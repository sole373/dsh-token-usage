// ---- 模型权威排名（用量面板最下方）----
//
// 读的是 `${prefix}/model-rank`。两件事在这里汇合，但来源严格分开：
//   - **能力分数**：公开榜单（后端拉取并缓存），本插件自己不编。
//   - **有哪些模型**：本机客户端清单 ∩ 你在「平台与模型」里的勾选。
//
// 所以页面必须同时写清两句话：分是谁给的、榜里为什么只有这些模型。
// 尤其不能让人以为「进榜 = 我的账号有权调用」——客户端目录不按订阅过滤。

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
      // 倍率是客户端给的，不是榜单给的——用倍率符号区分，免得被当成分数的一部分。
      Number.isFinite(row.multiplier) ? h('span', { key: 'k', className: 'tku-mono tku-muted' }, ' · x' + row.multiplier) : null,
    ]),
    h('td', { key: 'p', className: 'tku-mono tku-muted' }, providerLabel(row.provider)),
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
    ? h('div', { className: 'tku-empty' }, zh ? '本机可用模型里没有符合这个任务条件的' : 'No locally available model matches this task')
    : h('ol', { className: 'tku-rtask-list' }, rows.map((row, index) => h('li', { key: 'r' + index }, [
      h('span', { key: 'n', className: 'tku-rtask-name' }, row.name),
      h('span', { key: 'p', className: 'tku-rtask-prov tku-mono tku-muted' }, providerLabel(row.provider)),
      h('span', { key: 'v', className: 'tku-rtask-val tku-mono' }, formatMetric(row.value, task.metric, zh)),
    ])))
  return h('div', { className: 'tku-rtask' }, [
    h('div', { key: 'h', className: 'tku-rtask-head' }, [
      h('span', { key: 'l', className: 'tku-rtask-title' }, label),
      h('span', { key: 'r', className: 'tku-rtask-rule', title: rule }, rule),
    ]),
    h('div', { key: 'b', className: 'tku-rtask-body' }, body),
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

  const head = h('header', { key: 'head', className: 'tku-uhead' }, [
    h('div', { key: 't', className: 'tku-uhead-text' }, [
      h('h2', { key: 'h', className: 'tku-title' }, zh ? '模型权威排名' : 'Model leaderboard'),
      h('p', { key: 's', className: 'tku-sub' }, zh
        ? '能力分数来自公开榜单（Artificial Analysis 指数，经 OpenRouter 公开接口取回）；'
          + '「有哪些模型」只看本机客户端清单与你自己的勾选。两者都不是本插件自己估的。'
        : 'Capability scores come from a public leaderboard (Artificial Analysis indices, fetched via OpenRouter\'s public API); '
          + '"which models exist" comes only from the local client catalog plus your own selections. Neither is estimated by this plugin.'),
    ]),
    aside,
  ])

  if (state.error !== null && doc === null) {
    return h('section', { className: 'tku-ucard tku-rsec' }, [
      head,
      h('div', { key: 'e', className: 'tku-banner bad' },
        (zh ? '榜单读取失败：' : 'Leaderboard failed: ') + state.error
          + (zh ? '（下面的排名需要联网；本机清单不受影响）' : ' (ranking needs network; the local catalog is unaffected)')),
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
        ? '本机可用模型（' + counts.local + ' 个）在榜单里一个都没匹配上——可能榜单还没收录这些新模型。'
        : 'None of the ' + counts.local + ' locally available models matched the leaderboard — it may not list them yet.'),
    ])
  }

  const banner = doc.stale === true
    ? h('div', { key: 'stale', className: 'tku-banner warn' },
      (zh ? '本次刷新失败，下面是上次成功拉取的榜单：' : 'Refresh failed; showing the last successful fetch: ')
        + String(doc.error ?? ''))
    : null

  const note = h('p', { key: 'note', className: 'tku-sub tku-rnote' },
    zh ? doc.availabilityNote?.zh : doc.availabilityNote?.en)

  const meta = h('div', { key: 'meta', className: 'tku-sub tku-ufoot' }, zh
    ? '本机清单 ' + counts.local + ' 个模型 · 榜单匹配上 ' + counts.matched + ' 个 · 有智能指数的 '
      + counts.scored + ' 个'
      + (counts.unmatched > 0 ? ' · ' + counts.unmatched + ' 个未匹配' : '')
    : 'Local catalog ' + counts.local + ' models · ' + counts.matched + ' matched · '
      + counts.scored + ' with an intelligence index'
      + (counts.unmatched > 0 ? ' · ' + counts.unmatched + ' unmatched' : ''))

  const overall = h(UsageCard, {
    key: 'overall',
    title: zh ? '总榜（按智能指数）' : 'Overall (by intelligence index)',
    aside: h('span', { className: 'tku-mono' }, zh ? '本机可用范围内' : 'within local availability'),
    // scroll: 'table' —— 总榜是张表（8 列、12 行），不给这个参数它就只继承
    // .tku-table-wrap 的 overflow-x:auto，纵向不滚：行多时下半截被 .tku-ucard
    // 的 overflow:hidden 剪掉，用户看到「总榜只显示一半，且滚不动」。
    // 复用明细表那套机制：表体封 max-height、内部纵向滚动、表头 sticky 钉住。
    scroll: 'table',
    // extraClass：总榜行数远少于明细表，单独放宽表体高度上限（480px），
    // 12 行能一屏看完，条目更多时仍可滚。
    extraClass: 'is-rank-table',
  }, h(ModelRankTable, { rows: doc.entries, zh }))

  const tasks = h('div', { key: 'tasks', className: 'tku-rtasks' },
    (doc.tasks ?? []).map((task) => h(ModelTaskCard, { key: task.id, task, zh })))

  return h('section', { className: 'tku-ucard tku-rsec' }, [
    head,
    banner,
    note,
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
