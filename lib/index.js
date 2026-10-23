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
 *   2. `GET {prefix}/model-rank` —— 模型权威排名（能力分数取自公开榜单，收录范围
 *      由 rankScope 决定：默认宿主可调用的全部模型）。
 *   3. Web UI 的 `main` 面板      —— 上面的数据画成图。
 *
 * 与其它插件的耦合：**零**。不共享代码、不共享缓存文件、不读别人的文件、
 * 不调用别人。「可调用模型」目录经宿主官方 LlmRuntime（`ctx.llm`）枚举——
 * 那是宿主自己的服务，不是任何插件的内部状态。
 *
 * @module dsh-token-usage
 */

import Schema from '@deepseek-ai/schemastery'

import { registerUsageRoutes } from './usage-routes.js'
import { createUsageStore } from './usage-store.js'
import { registerModelRankRoutes } from './model-rank-routes.js'
import { createModelRankStore, attachUsageRanking } from './model-rank.js'
import { createCallableCatalog, resolveLlmRuntime } from './llm-catalog.js'
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
    .default('catalog')
    .description(
      '模型权威排名的收录范围：`catalog` = 宿主当前可调用的全部模型（默认，随「平台与模型」的启用情况变化）；'
        + '`used` = 只排本机会话日志里真实用过的模型；`all` = 排公开榜单上的全部模型。',
    ),
})

/**
 * 每个收录范围的对外口径：标识 + 中英说明。后端发给前端，面板照实显示——
 * 文案跟着口径走，而不是把某一种口径写死在页面里。
 */
const RANK_SCOPE_META = {
  catalog: {
    availability: 'callable-catalog',
    availabilityNote: {
      zh: '进榜的模型 = 宿主当前可调用的全部模型（各平台已启用的模型目录，随「平台与模型」的启用情况变化）。目录是广告名册、不是订阅权益检查，只如实反映宿主此刻能调用什么；对不上公开榜单的模型计入「未匹配」，不硬造分数。',
      en: 'Ranked models = every model currently callable through this host (each platform\'s enabled catalog, tracking your platform/model setup). That catalog is an advertised roster, not an entitlement check; it honestly reflects what the host can call right now. Models the public leaderboard does not recognize are counted as unmatched, never given invented scores.',
    },
    localCatalogNote: {
      zh: '收录范围：宿主可调用的全部模型（经官方 ctx.llm 服务枚举，随「平台与模型」启用情况变化）。能力分数取自公开榜单。',
      en: 'Scope: every model callable through this host (enumerated via the official ctx.llm service, tracking your platform/model setup). Capability scores come from a public leaderboard.',
    },
  },
  used: {
    availability: 'local-usage',
    availabilityNote: {
      zh: '进榜的模型都来自本机会话日志里真实出现过的调用（含已不再使用的历史模型），它反映的是「我用过什么」，不代表本机此刻还启用着它们。能力分数取自公开榜单。',
      en: 'Ranked models all actually appear in local session logs (including models you no longer use); that reflects what you have used, not what is currently enabled. Capability scores come from a public leaderboard.',
    },
    localCatalogNote: {
      zh: '收录范围：本机会话日志里真实调用过的模型（含已不再使用的历史调用）。能力分数取自公开榜单。',
      en: 'Scope: models that actually appear in local session logs (including past calls). Capability scores come from a public leaderboard.',
    },
  },
  all: {
    availability: 'leaderboard',
    availabilityNote: {
      zh: '收录公开榜单全集——回答「世界上有什么」，不代表本机可调用；榜单里绝大多数模型本机并没有接入。',
      en: 'This ranks the full public leaderboard — a view of what exists in the world, not of what this host can call; most of these models are not set up here.',
    },
    localCatalogNote: {
      zh: '收录范围：公开榜单全集（世界全景，非本机可用性）。能力分数即榜单分数。',
      en: 'Scope: the entire public leaderboard (a world view, not local availability). Scores are the leaderboard\'s own.',
    },
  },
}

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
    const rawRankScope = pick(config.rankScope)
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
      // 历史值 'used' / 'all' 都如实保留；其余（含未配置）一律落到新默认 'catalog'。
      rankScope: rawRankScope === 'used' || rawRankScope === 'all' ? rawRankScope : 'catalog',
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

    // 模型权威排名：把收录的模型清单与公开榜单对齐。榜单缓存到 stateDir，
    // 与用量文档同处一地，便于用户备份与排查。
    const rankStore = createModelRankStore({
      dir: stateDir,
      ttlMs: cfg.rankCacheHours * 60 * 60 * 1000,
      logger,
    })

    // 「可调用模型」目录（rankScope: 'catalog' 用）：宿主 LlmRuntime 官方枚举。
    // 缓存寿命复用用量扫描的秒数——两者都是「本机此刻的状态」级别的数据。
    const callableCatalog = createCallableCatalog({
      resolveRuntime: () => resolveLlmRuntime(ctx),
      ttlMs: cfg.usageCacheSeconds * 1000,
      logger,
    })
    // 平台接入/断开、勾选变化都会广播 `llm/adapters-updated`（官方事件，无载荷），
    // 订阅它让目录缓存立即失效。订阅失败只是失去即时性，TTL 仍兜底，不致命。
    try {
      ctx.on('llm/adapters-updated', callableCatalog.invalidate)
    } catch {
      /* 宿主若不广播此事件，缓存由 TTL 兜底 */
    }

    /**
     * 排名用的「收录模型清单」，按 rankScope 三种口径各取各的：
     *   - `catalog`：宿主可调用的全部模型（ctx.llm 广告目录）；
     *   - `used`：本机会话日志里真实出现过的模型（与用量面板同一次扫描）；
     *   - `all`：公开榜单全集。
     *
     * 目录枚举失败必须往外抛——由 readRank 如实写进响应，而不是悄悄退回另一种
     * 口径：用户看到的榜比预期少一堆还不知道为什么，正是这种「静默兜底」造成的。
     *
     * @param {boolean} force 刷新按钮语义：目录与榜单都绕过缓存。
     */
    const collectRankRows = async (force) => {
      if (cfg.rankScope === 'all') {
        return rankStore.readAllRows(force)
      }
      if (cfg.rankScope === 'catalog') {
        return callableCatalog.read({ force })
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

    // 模型权威排名：能力分数一律来自公开榜单，收录范围一律由 rankScope 决定。
    // 两者都不由本插件自己编，页面也如实说明这一点。
    registerModelRankRoutes(wctx, {
      prefix,
      readRank: async (options) => {
        const force = options?.force === true
        const meta = RANK_SCOPE_META[cfg.rankScope] ?? RANK_SCOPE_META.catalog

        let rows
        try {
          rows = await collectRankRows(force)
        } catch (error) {
          // 目录枚举失败要如实报，而不是退回另一种口径——悄悄换口径才是真正的坑。
          return {
            ok: false,
            status: 'catalog-unavailable',
            detail: String(error?.message ?? error),
            fetchedAt: null,
            source: 'dsh://llm/advertised-catalog',
            scope: cfg.rankScope,
            availability: meta.availability,
            availabilityNote: meta.availabilityNote,
            counts: { local: 0, matched: 0, unmatched: 0, scored: 0 },
            entries: [],
            tasks: [],
            unmatched: [],
          }
        }

        // 'all' 的全集行在 collectRankRows 里已经把榜单拉到手了，这里不再 force
        // （否则同一请求会把榜单拉两遍）；其余口径把 force 原样传给榜单层。
        const doc = await rankStore.read({
          force: cfg.rankScope === 'all' ? false : force,
          rows,
          availability: meta.availability,
          availabilityNote: meta.availabilityNote,
        })
        return {
          ...doc,
          localCatalog: {
            scope: cfg.rankScope,
            count: rows.length,
            note: meta.localCatalogNote,
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
