/**
 * 「可调用模型」目录：经宿主官方 LlmRuntime（`ctx.llm`）枚举当前全部可调用的模型。
 *
 * 口径依据：宿主 GUI 的模型选择只提交各适配器「广告」（advertised）的模型，
 * 所以广告目录就是「可全部调用的模型」的官方口径——`listProviders()` 给出
 * 当前注册的平台路由，`listModels(provider)` 给出每个平台已启用的模型；
 * 「平台与模型」里的启用变化、平台接入与断开，都会反映到这两个调用上。
 *
 * 官方契约同时写明：目录是**咨询性**的（catalog membership is advisory, not
 * request validation），也不做订阅权益检查。这里照实枚举、照实缓存，不假装
 * 它是权益名单——面板文案负责把这一点说清楚。
 *
 * 服务名防御：文档 surface 记载为 `ctx.llm`，但插件契约只保证「可选服务用
 * `ctx.get(name)` 取」，不同版本的服务名可能带包名前缀。这里探测几个候选名
 * 并做鸭子判定（同时有 `listProviders` 与 `listModels` 才算），谁先命中用谁；
 * 一个都不中就是目录不可用，如实报错，**绝不悄悄退回另一种收录口径**。
 *
 * 缓存与用量扫描器同一套路：内存快照 + TTL + inflight 串行化，`force` 绕过
 * TTL。平台路由变化时宿主会广播 `llm/adapters-updated`（每提交点触发），调用方
 * 订阅它即可立即失效缓存；订阅不上也不影响正确性，TTL 是兜底。
 */

/**
 * 在插件 ctx 上解析 LlmRuntime 服务；找不到（或形状不对）返回 `null`。
 *
 * @param {object} ctx 宿主提供的插件 ctx（只要求它有 `.get(name)`）
 * @returns {object|null}
 */
export function resolveLlmRuntime(ctx) {
  const names = ['llm', '@deepseek-ai/llm', '@deepseek-ai/dsh-llm']
  for (const name of names) {
    let service = null
    try {
      service = typeof ctx?.get === 'function' ? ctx.get(name) : null
    } catch {
      // 服务未注册时 `ctx.get` 可能抛错而不是返回空；这不算异常路径。
      service = null
    }
    if (
      service !== null &&
      typeof service === 'object' &&
      typeof service.listProviders === 'function' &&
      typeof service.listModels === 'function'
    ) {
      return service
    }
  }
  return null
}

/**
 * 可调用模型目录的读取器。
 *
 * @param {object} options
 * @param {() => (object|null)} [options.resolveRuntime] 取 LlmRuntime 的方式
 *   （默认永远取不到——真实调用方必须传）。
 * @param {number} [options.ttlMs] 内存缓存寿命（默认 30 秒）。
 * @param {object} [options.logger] 宿主 logger，只用于 warn 单个平台失败。
 * @param {() => number} [options.now] 时间源（测试注入用）。
 */
export function createCallableCatalog(options = {}) {
  const {
    resolveRuntime = () => null,
    ttlMs = 30_000,
    logger,
    now = () => Date.now(),
  } = options

  let memory = null // { rows, at }
  let inflight = null

  /**
   * 真正枚举一遍。任何一步失败都往外抛——调用方负责把它如实写进响应，
   * 而不是编一份空目录。
   */
  async function enumerate() {
    const runtime = resolveRuntime()
    if (runtime === null) {
      const error = new Error('宿主没有提供 LlmRuntime（ctx.llm）服务，无法枚举「可调用模型」目录')
      error.code = 'LLM_RUNTIME_UNAVAILABLE'
      throw error
    }

    const providers = await runtime.listProviders()
    const routes = (Array.isArray(providers) ? providers : [])
      .map((item) => (typeof item?.id === 'string' ? item.id : ''))
      .filter((id) => id !== '')

    const rows = []
    for (const route of routes) {
      let models = []
      try {
        models = await runtime.listModels(route)
      } catch (error) {
        // 单个平台失败不影响其它平台；缺的平台会在行数与列表上如实缺席。
        logger?.warn?.(`列出平台 ${route} 的模型失败：${String(error?.message ?? error)}`)
        continue
      }
      for (const model of Array.isArray(models) ? models : []) {
        if (typeof model?.id !== 'string' || model.id === '') continue
        const name = typeof model.name === 'string' && model.name !== '' ? model.name : model.id
        const row = { provider: route, id: model.id, name }
        // magpie 网关把倍率拼在模型显示名里（`glm-5.3 · x0.79`）。把它抽出来单独
        // 成列：模型名交给 buildRankDoc 的 stripRateSuffix 去剥，倍率数字透传给
        // entry.multiplier（model-rank.js:370 已消费）——否则名字被剥后倍率就丢了。
        // 其它平台名字里没有倍率后缀，解析不到就不带 multiplier 字段。
        if (route === 'magpie') {
          const m = name.match(/\s*[·|]\s*x\s*([0-9.]+)/iu) ?? name.match(/\sx([0-9.]+)/u)
          if (m) {
            const multiplier = Number.parseFloat(m[1])
            if (Number.isFinite(multiplier) && multiplier >= 0) row.multiplier = multiplier
          }
        }
        rows.push(row)
      }
    }

    // magpie 是本地路由器：它广告的模型大多是从别家 agent 的订阅里路由出来的
    // （Qoder、WorkBuddy、Cline、TRAE CN、小米 MiMo、OpenCode Zen Free……），
    // id 的第一段就是原始提供者。把来源改写成 `magpie-<partner>`，排名页的
    // 「可用平台」列才能看到真来源。改写要在去重之前做，去重键才按新 provider 算。
    for (const row of rows) {
      if (row.provider !== 'magpie') continue
      const slash = row.id.indexOf('/')
      const partner = slash > 0 ? row.id.slice(0, slash) : ''
      if (partner === 'group') {
        // 命名路由组：`group/cheap-first` → 纯免费、`group/group` → 高性能。
        // 就这两个真实存在的组，组名由 magpie 自己的目录给出（name 字段即组名）。
        // 来源改写 `magpie-group`，组名带走交给 buildRankDoc / 用量明细去显示；
        // 不到榜单上，所以排名页「可用平台」列里不会出现，只在用量明细里现身。
        row.provider = 'magpie-group'
        if (typeof row.name === 'string' && row.name !== '') row.groupName = row.name
        continue
      }
      if (partner === 'auto') {
        // `auto/<model>` 是「按模型的自动路由」（每条模型各一个，名字带 routing group）。
        // 保留 provider=magpie-auto，但把 auto 后面的具体标识（模型名）带到 label 里，
        // 让「可用平台」列能区分各条 auto 路由（用户 m00513 选「带组名」方案）。
        // 格式：`Magpie·自动路由·GLM-5.3`，比统一的「Magpie·自动路由」信息量大。
        row.provider = 'magpie-auto'
        // auto/<model> 的 model 段：取 id 第一个 / 之后到结尾的部分
        const autoModel = slash > 0 ? row.id.slice(slash + 1) : ''
        // 目录 name 字段可能带倍率/装饰（`glm-5.3 · x0.79 · routing group`），
        // 取第一段（中点/竖线之前的部分）作为路由标识，与 stripRateSuffix 逻辑一致。
        const rawLabel = typeof row.name === 'string' && row.name !== '' ? row.name : autoModel
        const dot = rawLabel.indexOf('·')
        const bar = rawLabel.indexOf('|')
        let routeName = rawLabel
        if (dot > 0) routeName = rawLabel.slice(0, dot).trim()
        else if (bar > 0) routeName = rawLabel.slice(0, bar).trim()
        if (routeName !== '') row.label = 'Magpie·自动·' + routeName
        continue
      }
      if (partner !== '' && partner !== 'magpie' && /^[a-z0-9][a-z0-9._-]*$/u.test(partner)) {
        row.provider = 'magpie-' + partner
      }
    }

    // 同一平台重复广告同一模型只留一条；不同平台广告同名模型则各自保留——
    // provider 列照实显示，不猜「这两个是不是同一个模型」。
    const seen = new Set()
    return rows.filter((row) => {
      const key = row.provider + '\u0000' + row.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /**
   * 读目录。`force: true` 绕过 TTL 重新枚举（排名页的「刷新」按钮）。
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<Array<{provider: string, id: string, name: string}>>}
   */
  async function read(options = {}) {
    if (!options.force && memory !== null && now() - memory.at < ttlMs) {
      return memory.rows
    }
    if (inflight === null) {
      inflight = enumerate()
        .then((rows) => {
          memory = { rows, at: now() }
          return rows
        })
        .finally(() => {
          inflight = null
        })
    }
    return inflight
  }

  /** 立即失效缓存（宿主广播 `llm/adapters-updated` 时调用）。 */
  function invalidate() {
    memory = null
  }

  return { read, invalidate }
}
