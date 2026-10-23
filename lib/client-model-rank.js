// ---- 模型权威排名（用量面板最下方）----
//
// 读的是 `${prefix}/model-rank`。两件事在这里汇合，但来源严格分开：
//   - **能力分数**：公开榜单（后端拉取并缓存），本插件自己不编。
//   - **收录哪些模型**：由设置里的 rankScope 决定（可调用目录 / 实测日志 /
//     榜单全集），口径说明由后端随文档发来（availabilityNote），页面照实显示。
//
// 所以页面不把任何一种口径写死在文案里——换收录范围时说明自动跟着换。
// 但有一点永远要说清：目录/日志都不是订阅权益检查，进榜 ≠ 你已有权调用。
//
// 后端自合并版起，同一榜单条目（名称一样、分数一样）只出一行，本机的多个
// 来源折进行内 providers 数组；「可用平台」列把它们合并展示（`WorkBuddy / TRAE`）。

/** 上下文窗口：`128K` / `1M`。比 formatTokens 更贴近这个领域的习惯写法。 */
function formatCtx(value, zh) {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) + 'M'
  if (value >= 1e3) return Math.round(value / 1e3) + 'K'
  return String(Math.round(value))
}

/** 榜单价格：后端已折成「每百万输入 token 美元」。 */
function formatPrice(value) {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '免费'
  if (value < 0.01) return '$' + value.toFixed(4)
  return '$' + value.toFixed(2)
}

/** 指数类分数：一位小数。`null`（榜单没给）显示「—」，不显示 0。 */
function formatScore(value) {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(1)
}

/** 任务卡里的「度量值」列，按该任务的度量单位渲染。 */
function formatMetric(value, metric, zh) {
  if (!Number.isFinite(value)) return '—'
  if (metric === 'tokens') return formatCtx(value, zh)
  if (metric === 'usd') return formatPrice(value)
  return formatScore(value)
}

async function fetchModelRank(refresh) {
  return callJson(DEFAULT_PREFIX + '/model-rank' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' })
}

/** 收录口径 → 总榜标题旁的范围标签。未知口径用中性的「收录范围内」。 */
const RANK_SCOPE_ASIDE = {
  'callable-catalog': { zh: '可调用范围内', en: 'within callable models' },
  'local-usage': { zh: '本机实测范围内', en: 'within locally used models' },
  leaderboard: { zh: '公开榜单全集', en: 'the full public board' },
}

/** 收录口径 → 统计行里的名词。未知口径用中性的「收录模型」。 */
const RANK_SCOPE_NOUN = {
  'callable-catalog': { zh: '可调用模型', en: 'callable models' },
  'local-usage': { zh: '本机实测模型', en: 'locally used models' },
  leaderboard: { zh: '榜单收录模型', en: 'board models' },
}

/** 一行里合并后的多来源标签：`WorkBuddy / TRAE`；单来源就是它自己。 */
function providerCell(row, zh) {
  const providers = Array.isArray(row.providers) && row.providers.length > 0
    ? row.providers.map((item) => providerLabel(item.provider))
    : [providerLabel(row.provider)]
  return providers.join(zh ? ' / ' : ' / ')
}

/** 一个模型在榜里的完整能力行。列宽固定，便于纵向比较。 */
function ModelRankTable(props) {
  const { rows, zh } = props
  if (!Array.isArray(rows) || rows.length === 0) {
    return h('div', { className: 'tku-empty' }, zh ? '没有可排名的模型' : 'Nothing to rank')
  }
  const headCells = [
    h('th', { key: 'n', className: 'num' }, '#'),
    h('th', { key: 'm' }, zh ? '模型' : 'Model'),
    h('th', { key: 'p' }, zh ? '可用平台' : 'Available via'),
    h('th', { key: 'i', className: 'num' }, zh ? '智能' : 'Intel'),
    h('th', { key: 'c', className: 'num' }, zh ? '编码' : 'Coding'),
    h('th', { key: 'g', className: 'num' }, zh ? '智能体' : 'Agentic'),
    h('th', { key: 'x', className: 'num' }, zh ? '上下文' : 'Context'),
    h('th', { key: 'r', className: 'num' }, zh ? '价格/百万' : '$/1M'),
  ]
  const bodyRows = rows.map((row, index) => h('tr', { key: 'r' + index }, [
    h('td', { key: 'n', className: 'num tku-mono tku-muted' }, String(index + 1)),
    h('td', { key: 'm' }, [
      h('span', { key: 'd', className: 'tku-legend-dot', style: { background: paletteOf(index) } }),
      h('span', { key: 'l', className: 'tku-name' }, row.name),
      row.image === true ? h('span', { key: 'v', className: 'tku-mono tku-muted' }, zh ? ' · 图片' : ' · image') : null,
    ]),
    h('td', { key: 'p', className: 'tku-mono tku-muted' }, providerCell(row, zh)),
    h('td', { key: 'i', className: 'num tku-mono' }, formatScore(row.intel)),
    h('td', { key: 'c', className: 'num tku-mono' }, formatScore(row.coding)),
    h('td', { key: 'g', className: 'num tku-mono' }, formatScore(row.agentic)),
    h('td', { key: 'x', className: 'num tku-mono' }, formatCtx(row.ctx, zh)),
    h('td', { key: 'r', className: 'num tku-mono' }, formatPrice(row.price)),
  ]))
  return h('div', { className: 'tku-table-wrap' },
    h('table', { className: 'tku-table tku-utable tku-rtable' }, [
      h('thead', { key: 'h' }, h('tr', {}, headCells)),
      h('tbody', { key: 'b' }, bodyRows),
    ]))
}

/** 一个任务类型的推荐卡：规则写在卡里，让「为什么它排第一」可当场验证。 */
function ModelTaskCard(props) {
  const { task, zh } = props
  const rows = Array.isArray(task.rows) ? task.rows : []
  const rule = zh ? task.zhRule : task.enRule
  const label = zh ? task.zhLabel : task.enLabel
  const body = rows.length === 0
    ? h('div', { className: 'tku-empty' }, zh ? '收录范围内没有符合这个任务条件的模型' : 'No model in the current scope matches this task')
    : h('ol', { className: 'tku-rtask-list' }, rows.map((row, index) => h('li', { key: 'r' + index }, [
      h('span', { key: 'n', className: 'tku-rtask-name' }, row.name),
      h('span', { key: 'v', className: 'tku-rtask-val tku-mono' }, formatMetric(row.value, task.metric, zh)),
    ])))
  return h('div', { className: 'tku-rtask' }, [
    h('div', { key: 'h', className: 'tku-rtask-head' }, [
      h('span', { key: 'l', className: 'tku-rtask-title' }, label),
      h('span', { key: 'r', className: 'tku-rtask-rule', title: rule }, rule),
    ]),
    h('div', { key: 'b', className: 'tku-rtask-body', style: { maxHeight: '120px', overflowY: 'auto', overscrollBehavior: 'contain' } }, body),
  ])
}

function ModelRankSection() {
  const zh = isZhUi()
  const [state, setState] = useState({ loading: true, error: null, doc: null })

  const load = useCallback(async (refresh) => {
    setState((prev) => ({ loading: true, error: null, doc: prev.doc }))
    const result = await fetchModelRank(refresh)
    if (result.ok !== true) {
      setState({
        loading: false,
        error: String(result.detail ?? result.status ?? 'unknown'),
        doc: null,
      })
      return
    }
    setState({ loading: false, error: null, doc: result })
  }, [])

  useEffect(() => {
    load(false)
  }, [load])

  const doc = state.doc
  const counts = doc?.counts

  const aside = h('div', { className: 'tku-uhead-actions' }, [
    doc?.fetchedAt
      ? h('span', { key: 't', className: 'tku-mono tku-muted' },
        (zh ? '榜单 ' : 'board ') + sinceLabel(Date.parse(doc.fetchedAt), zh))
      : null,
    h('button', {
      key: 'r',
      type: 'button',
      className: 'tku-btn',
      disabled: state.loading === true,
      onClick: () => load(true),
    }, state.loading === true ? (zh ? '拉取中…' : 'Loading…') : (zh ? '刷新榜单' : 'Refresh board')),
  ])

  // 头部说明压成一行：分数来源（永远不变）+ 收录口径（后端按 rankScope 发来）。
  // 口径文案跟着文档走：换收录范围时说明自动换，不把某一种口径写死在页面里。
  // 文档还没回来时先显示口径的中性说明，不猜后端正用哪种口径。
  const scoreSource = zh
    ? '能力分数来自公开榜单（Artificial Analysis 指数，经 OpenRouter 公开接口取回），本插件自己不编。'
    : 'Capability scores come from a public leaderboard (Artificial Analysis indices via OpenRouter\'s public API); this plugin never invents them.'
  const scopeLine = doc?.availabilityNote
    ? String(zh ? doc.availabilityNote.zh : doc.availabilityNote.en)
    : (zh
      ? '收录哪些模型由设置里的 rankScope 决定（可调用目录 / 实测日志 / 榜单全集）。'
      : 'Which models are ranked follows the rankScope setting (callable catalog / observed usage / full board).')
  const subtitle = scopeLine === '' ? scoreSource : scoreSource + '｜' + scopeLine

  const head = h('header', { key: 'head', className: 'tku-uhead' }, [
    h('div', { key: 't', className: 'tku-uhead-text' }, [
      h('h2', { key: 'h', className: 'tku-title' }, zh ? '模型权威排名' : 'Model leaderboard'),
      h('p', { key: 's', className: 'tku-sub tku-oneline', title: subtitle }, subtitle),
    ]),
    aside,
  ])

  if (state.error !== null && doc === null) {
    return h('section', { className: 'tku-ucard tku-rsec' }, [
      head,
      h('div', { key: 'e', className: 'tku-banner bad' },
        (zh ? '排名读取失败：' : 'Ranking failed: ') + state.error
          + (zh
            ? '（可能是公开榜单拉取失败，也可能是宿主没能枚举可调用模型；可稍后重试或在设置里更换 rankScope）'
            : ' (either the public leaderboard could not be fetched, or the host could not enumerate its callable models; retry later or change rankScope in settings)')),
    ])
  }

  if (doc === null) {
    return h('section', { className: 'tku-ucard tku-rsec' }, [head])
  }

  // 榜单读取成功但一条都对不上：不是错误，是事实。必须说清楚，否则用户会
  // 以为本机真的没有模型，或者以为排名坏了。
  if (counts && counts.matched === 0) {
    return h('section', { className: 'tku-ucard tku-rsec' }, [
      head,
      h('div', { key: 'w', className: 'tku-banner warn' }, zh
        ? '收录的 ' + counts.local + ' 个模型在榜单里一个都没匹配上——可能榜单还没收录这些新模型。'
        : 'None of the ' + counts.local + ' models in the current scope matched the leaderboard — it may not list them yet.'),
    ])
  }

  const banner = doc.stale === true
    ? h('div', { key: 'stale', className: 'tku-banner warn' },
      (zh ? '本次刷新失败，下面是上次成功拉取的榜单：' : 'Refresh failed; showing the last successful fetch: ')
        + String(doc.error ?? ''))
    : null

  // 统计行：名词跟着收录口径走（可调用 / 本机实测 / 榜单收录），未知口径用中性词。
  // matched 数的是本机匹配行，merged 数的是同名同分合并后的模型数——两者有差时
  // 必须都写出来，否则「匹配 109」和总榜 86 行对不上账。
  const scopeAside = RANK_SCOPE_ASIDE[doc.availability] ?? { zh: '收录范围内', en: 'within the scope' }
  const scopeNoun = RANK_SCOPE_NOUN[doc.availability] ?? { zh: '收录模型', en: 'in-scope models' }
  const merged = Number.isFinite(counts.merged) ? counts.merged : counts.matched
  const meta = h('div', { key: 'meta', className: 'tku-sub tku-ufoot' }, zh
    ? (scopeNoun.zh + ' ' + counts.local + ' 个 · 榜单匹配上 ' + counts.matched + ' 个'
      + (merged !== counts.matched ? '（合并为 ' + merged + ' 个模型）' : '')
      + ' · 有智能指数的 ' + counts.scored + ' 个'
      + (counts.unmatched > 0 ? ' · ' + counts.unmatched + ' 个未匹配' : ''))
    : (scopeNoun.en + ': ' + counts.local + ' · ' + counts.matched + ' matched'
      + (merged !== counts.matched ? ' (' + merged + ' after merging)' : '')
      + ' · ' + counts.scored + ' with an intelligence index'
      + (counts.unmatched > 0 ? ' · ' + counts.unmatched + ' unmatched' : '')))

  // 右上角标出总行数：默认只铺开 10 行，用户得知道底下还有多少行可滚，
  // 否则「只显示 10 行」看起来和旧版的截断没有区别。
  const totalRows = Array.isArray(doc.entries) ? doc.entries.length : 0

  const overall = h(UsageCard, {
    key: 'overall',
    title: zh ? '总榜（按智能指数）' : 'Overall (by intelligence index)',
    aside: h('span', { className: 'tku-mono' },
      (zh ? scopeAside.zh : scopeAside.en) + ' · ' + totalRows + (zh ? ' 行' : ' rows')),
    // scroll: 'table' —— 总榜是张表（8 列、几十行），不给这个参数它就只继承
    // .tku-table-wrap 的 overflow-x:auto，纵向不滚：行多时下半截被 .tku-ucard
    // 的 overflow:hidden 剪掉，用户看到「总榜只显示一半，且滚不动」。
    // 复用明细表那套机制：表体封 max-height、内部纵向滚动、表头 sticky 钉住。
    scroll: 'table',
    // extraClass：总榜数据自 v1.3.0 起不截断（有分数的模型全部返回，可能上百行），
    // 默认只铺开 10 行（与明细表同一套 306px/28px 规则），其余表体内部滚动；
    // 卡片右上角标出总行数，免得被误以为还是截断的旧版。
    extraClass: 'is-rank-table',
  }, h(ModelRankTable, { rows: doc.entries, zh }))

  const tasks = h('div', { key: 'tasks', className: 'tku-rtasks' },
    (doc.tasks ?? []).map((task) => h(ModelTaskCard, { key: task.id, task, zh })))

  return h('section', { className: 'tku-ucard tku-rsec' }, [
    head,
    banner,
    overall,
    h('div', { key: 'th', className: 'tku-ucard-title' }, zh ? '按任务类型推荐' : 'Recommendations by task'),
    tasks,
    meta,
  ])
}

/** 排名区套在自己的错误边界里：它坏了不能把上面的用量统计一起变成空白。 */
function ModelRankSafe() {
  return h(UsageErrorBoundary, null, h(ModelRankSection, null))
}
