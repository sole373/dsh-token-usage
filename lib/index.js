/**
 * dsh-token-usage —— Token 用量统计 + 模型能力排名，独立插件。
 *
 * 读的是 DSH 自己的会话日志（`$DSH_HOME/sessions`），按 provider / 模型归类，
 * 得出「花了多少 token、缓存命中如何、哪些模型用得多」。数据源与任何本机
 * 客户端的登录态**完全无关**，所以它能独立于签到 / 模型接入那类插件存在，
 * 装不装 dsh-agent-checkin 都不影响它工作。
 *
 * 三块能力：
 *   1. `GET {prefix}/usage`      —— 用量文档（趋势 / 来源分布 / 模型排行 / 明细）。
 *   2. `GET {prefix}/model-rank` —— 模型能力排名（能力分数取自公开榜单）。
 *   3. Web UI 的 `main` 面板      —— 上面的数据画成图。
 *
 * 与其它插件的耦合：**零**。不共享代码、不共享缓存文件、不读别人的文件、
 * 不调用别人。榜单自己抓、自己缓存；「本机用过的模型」来自自己的会话日志扫描。
 *
 * @module dsh-token-usage
 */

import Schema from '@deepseek-ai/schemastery'

import { registerUsageRoutes } from './usage-routes.js'
import { createUsageStore } from './usage-store.js'
import { registerModelRankRoutes } from './model-rank-routes.js'
import { createModelRankStore, attachUsageRanking } from './model-rank.js'
import { isLoopbackRequest } from './loopback.js'
import { resolveDshHome, resolveStateDir } from './paths.js'

export const name = 'dsh-token-usage'

/**
 * 不声明 inject：HTTP 路由在 apply 内部用 `ctx.inject()` 按需挂载。
 * 宿主没有 webServer 时（例如 headless 组合）这一块不出现，
 * 而不是整个插件加载失败。
 */
export const inject = []

export const Config = Schema.object({
  statusRoute: Schema.string()
    .default('/dsh-token-usage')
    .description('用量面板 HTTP 端点前缀（挂在宿主 web 服务器上）'),
  sessionsDir: Schema.string()
    .default('')
    .description(
      '会话日志根目录，用量统计的数据源。留空则用 `$DSH_HOME/sessions`（未设 DSH_HOME 时用 `~/.dsh/sessions`）。'
        + '只有把日志搬到别处时才需要改。',
    ),
  usageCacheSeconds: Schema.natural()
    .default(30)
    .description(
      '用量扫描结果的缓存秒数。面板上的「刷新」按钮总是绕过缓存重新扫；'
        + '这里的值只影响自动轮询与其它调用方。',
    ),
  rankCacheHours: Schema.natural()
    .default(6)
    .description(
      '模型权威榜单的缓存小时数。榜单取自公开接口（免鉴权），以天为单位变化，'
        + '刷太勤只是白费网络。排名页的「刷新」按钮总是绕过缓存重新拉。'
        + '拉取失败时继续用手上的旧榜单并在页面上标明「本次刷新失败」。',
    ),
  rankScope: Schema.string()
    .default('used')
    .description(
      '模型榜单的收录范围：`used` = 只排本机会话日志里真实用过的模型（默认）；'
        + '`all` = 排公开榜单上的全部模型。',
    ),
})

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // 用量数据随时间变化，且反映真实消耗，禁止中间层缓存。
  'cache-control': 'no-store',
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export function apply(ctx, config) {
  const logger = ctx.logger('dsh-token-usage')

  /**
   * 读取当前生效的配置。
   *
   * `volatile()` 字段是引用对象（只有 `.get()`），普通字段就是字面值；这里统一
   * 归一化，让调用点不必区分。每次运行都重新读，settings 面板上的修改才真的
   * 生效——在 apply 时解构一次是最容易犯、又最难察觉的错。
   *
   * 注：cordis 在配置变更时会 `fiber.update()` → `restart()` → 重跑 `apply`，
   * 所以这份快照每次都会重新读，无需在请求路径上反复取。
   */
  const readConfig = () => {
    const pick = (value) => (value && typeof value.get === 'function' ? value.get() : value)
    const rawSessionsDir = pick(config.sessionsDir)
    const rawUsageCacheSeconds = pick(config.usageCacheSeconds)
    const rawRankCacheHours = pick(config.rankCacheHours)
    return {
      statusRoute: pick(config.statusRoute),
      sessionsDir:
        typeof rawSessionsDir === 'string' && rawSessionsDir.trim() !== ''
          ? rawSessionsDir.trim()
          : '',
      usageCacheSeconds:
        Number.isFinite(rawUsageCacheSeconds) && rawUsageCacheSeconds >= 0
          ? rawUsageCacheSeconds
          : 30,
      rankCacheHours: Number.isFinite(rawRankCacheHours) && rawRankCacheHours >= 0 ? rawRankCacheHours : 6,
      rankScope: pick(config.rankScope) === 'all' ? 'all' : 'used',
    }
  }

  /**
   * 状态目录：`<dshHome>/dsh-token-usage`（榜单缓存落在这里，与插件本体分离）。
   *
   * 主目录的解析统一在 `lib/paths.js`：宿主把 `dshHomePath` 作为**函数**服务
   * 提供，必须调用而非当字符串用；解析不出来时退回 `$DSH_HOME`、再退回
   * `~/.dsh`——与宿主 `resolveDshHome` 的优先级完全一致。
   */
  const stateDir = () => resolveStateDir(ctx)

  /**
   * 最近一次前端上报的布局实测值。
   *
   * 「页面不能滚」这类问题只看 CSS 规则是看不出所以然的：根元素到底是不是宿主
   * 中栏的 flex 子项、中栏给了多高、最终滚动容器是谁——这些只有浏览器能测出来。
   * 前端把实测值报上来，这里留最后一次，供 `GET {prefix}/status` 读取。
   */
  let lastClientDiag = null

  // ---- HTTP 面 ----
  ctx.inject(['webServer'], (wctx) => {
    const cfg = readConfig()
    const prefix = cfg.statusRoute.replace(/\/+$/, '') || '/dsh-token-usage'

    // 会话日志扫描器：整个插件共用一个实例，靠它的文件级缓存做增量。
    // 不持久化到数据库——几十个日志 / 几十 MB 冷扫约 1.4 秒，而日志只增不减，
    // 内存缓存已经能把日常刷新压到个位数毫秒；引入 SQLite 只会多一份
    // 需要迁移、需要与日志对账的副本。
    const usageStore = createUsageStore({
      sessionsRoot: cfg.sessionsDir === '' ? undefined : cfg.sessionsDir,
      ttlMs: cfg.usageCacheSeconds * 1000,
    })

    // 模型权威排名：把本机实测清单与公开榜单对齐。榜单缓存到 stateDir，
    // 与用量文档同处一地，便于用户备份与排查。
    const rankStore = createModelRankStore({
      dir: stateDir,
      ttlMs: cfg.rankCacheHours * 60 * 60 * 1000,
      logger,
    })

    /**
     * 排名用的「本机可用模型清单」。
     *
     * 口径：**本机会话日志里真实出现过的模型**（与用量面板同一次扫描）。
     * 这么定有三个理由：
     *   1. 它是**实测**的——「我调用过什么」不需要读任何别的插件的文件，
     *      因此两个插件之间零耦合。
     *   2. 它是**有意义的**——榜单里几百个模型绝大多数本机没装过，
     *      只按榜单排，那张榜答的是「世界上有什么」而不是「我用过什么」。
     *   3. 它与能力排行卡的口径**完全一致**——那四张卡与下面这块排名
     *      区块说的是同一件事，不会出现「上面认得、下面认不出」的自相矛盾。
     *
     * `rankScope: 'all'` 时改为排公开榜单全集（用户明确要「世界全景」时用）。
     */
    const rankRows = async () => {
      if (cfg.rankScope === 'all') {
        const doc = await rankStore.read({ force: false, rows: [] })
        const entries = Array.isArray(doc.entries) ? doc.entries : []
        return entries.map((row) => ({ provider: row.provider, id: row.id, name: row.name }))
      }
      const doc = await usageStore.read({ force: false })
      return (Array.isArray(doc.sources) ? doc.sources : []).map((row) => ({
        provider: row.provider,
        id: row.model,
        name: row.model,
      }))
    }

    // 用量统计（token）。数据源是宿主自己的会话日志，与本插件的其它能力无关。
    registerUsageRoutes(wctx, {
      prefix,
      // 用量文档顺便挂上「本机实测模型的能力排行」：模型清单来自用量扫描器，
      // 能力分数来自 rankStore 手上已有的榜单快照（`peek` 不联网）。
      // 榜单还没拉回来时 `peek()` 是 null，能力列显示「—」而不是编一个 0。
      readUsage: async (options) => {
        const doc = await usageStore.read(options)
        return attachUsageRanking(doc, null, { getIndex: () => rankStore.peek() })
      },
      effect: (fn) => wctx.effect(fn),
    })

    // 模型权威排名：能力分数一律来自公开榜单，可用性一律来自本机实测清单。
    // 两者都不由本插件自己编，页面也如实说明这一点。
    registerModelRankRoutes(wctx, {
      prefix,
      readRank: async (options) => {
        const rows = await rankRows()
        const doc = await rankStore.read({ force: options?.force === true, rows })
        return {
          ...doc,
          localCatalog: {
            scope: cfg.rankScope,
            count: rows.length,
            note: {
              zh: '收录范围：本机会话日志里真实调用过的模型（含已不再使用的历史调用）。能力分数取自公开榜单，与本插件自己无关。',
              en: 'Scope: models that actually appear in local session logs (including past calls). Capability scores come from a public leaderboard, not from this plugin.',
            },
          },
        }
      },
      effect: (fn) => wctx.effect(fn),
    })

    wctx.effect(() =>
      wctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/status`,
        async handler(req, res) {
          // 端点只服务本机看板：非回环的 Host/Origin 一律拒绝。
          if (!isLoopbackRequest(req)) {
            sendJson(res, 403, { error: 'forbidden' })
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            plugin: 'dsh-token-usage',
            sessionsRoot: usageStore.sessionsRoot,
            rankScope: cfg.rankScope,
            routes: [`${prefix}/usage`, `${prefix}/model-rank`, `${prefix}/client-diag`],
            // 最近一次前端上报的布局实测值（见 client-usage.js 的 rootRef 诊断）。
            // 「页面不能滚」这类问题只看 CSS 规则是看不出所以然的：
            // 根元素到底是不是宿主中栏的 flex 子项、中栏给了多高、滚动容器是谁，
            // 只能由浏览器实测后回传。
            clientDiag: lastClientDiag,
          })
        },
      }),
    )

    // 前端布局诊断回传：POST {prefix}/client-diag。
    // 前端把根元素与宿主中栏的实测尺寸报上来，后端只留最后一次。
    // 只收本机回环，且只收小 JSON——这是诊断通道，不是数据通道。
    wctx.effect(() =>
      wctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/client-diag`,
        async handler(req, res) {
          if (!isLoopbackRequest(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const chunks = []
            let size = 0
            for await (const chunk of req) {
              size += chunk.length
              if (size > 64 * 1024) {
                sendJson(res, 413, { ok: false, error: 'payload too large' })
                return
              }
              chunks.push(chunk)
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            lastClientDiag = {
              at: new Date().toISOString(),
              uiVersion: typeof body.uiVersion === 'string' ? body.uiVersion : null,
              data: body.data && typeof body.data === 'object' ? body.data : null,
            }
            sendJson(res, 200, { ok: true })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )
  })

  const initial = readConfig()
  logger.info(
    'dsh-token-usage 已加载：会话根目录 %s，榜单缓存 %s 小时，收录范围 %s',
    initial.sessionsDir === '' ? '$DSH_HOME/sessions' : initial.sessionsDir,
    String(initial.rankCacheHours),
    initial.rankScope,
  )
}
