// ---- 统计页面（`main` slot）----
//
// 读的是 `${prefix}/usage`：宿主侧扫 DSH 自己的会话日志，按 provider / 模型归类。
// 这一块只负责「把数画出来」，口径（哪条记录算一次调用、token 怎么加）全在后端，
// 前端再算一遍只会出现两个都对不上数的版本。

/** 持仓窗口可选项（天）。3650 = 「全部」，够长到覆盖任何真实使用史。 */
const USAGE_WINDOWS = [7, 30, 90, 3650]

// ---- 四张图的列宽 ----
// 列宽**一律按比例（fr）分配**，不用 minmax(px)，也不再有拖拽把手：
// 像素上下限一旦和宿主的实际可用宽度对不上，grid 就会把放不下的那一列折到下一行，
// 用户看到的就是「第四张卡不见了」。比例列没有这个毛病——窗口多宽，四列就按
// **20% / 20% / 30% / 30%**（即 2:2:3:3）分多宽，任何宽度都排得下。
//
// 为什么第三、四张各给 30%：它们是排行卡，一行要放下「模型名 + 数值」两列，
// 比只画一根趋势柱、只放一个环的前两张更需要横向空间。
const USAGE_COLS_DEFAULT = ['minmax(0, 2fr)', 'minmax(0, 2fr)', 'minmax(0, 3fr)', 'minmax(0, 3fr)']
/** 一行里几张卡。加卡改这里。 */
const USAGE_COL_COUNT = USAGE_COLS_DEFAULT.length

/**
 * 用量页前端版本号。**每次改动这一页的布局或卡片时都要改**，页面左上角会显示它。
 * 作用只有一个：把「浏览器还在跑旧 bundle」这件事从猜测变成一眼可见——
 * 界面显示 4 就是加载到了四卡那版，显示别的（或这行根本不出现）就是旧代码。
 */
const USAGE_UI_VERSION = 'ui-4card-2'



/** 拉一次用量文档。`refresh=1` 才会让宿主重扫文件；自动刷新走缓存。 */
async function fetchUsage(days, refresh) {
  const query = '?days=' + String(days) + (refresh ? '&refresh=1' : '')
  return callJson(DEFAULT_PREFIX + '/usage' + query, { cache: 'no-store' })
}

function UsageStat(props) {
  return h('div', { className: 'tku-stat' + (props.tone ? ' ' + props.tone : '') }, [
    h('div', { key: 'l', className: 'tku-stat-label' }, props.label),
    h('div', { key: 'v', className: 'tku-stat-value' }, props.value),
    props.hint ? h('div', { key: 'h', className: 'tku-stat-hint', title: props.hint }, props.hint) : null,
  ])
}

function UsageCard(props) {
  const aside = props.aside ? h('div', { key: 'a', className: 'tku-ucard-aside' }, props.aside) : null
  // scroll 分两种，样式在 CSS 里各自处理：
  //   true      —— 排行卡：body 内部滚动，条目本身是 li 列表；
  //   'table'   —— 明细表：表体滚动、表头钉住（sticky）。
  const scrollClass = props.scroll === 'table' ? ' is-scroll-table' : (props.scroll ? ' is-scroll' : '')
  return h('section', { className: 'tku-ucard' + scrollClass }, [
    h('header', { key: 'h', className: 'tku-ucard-head' }, [
      h('h3', { key: 't', className: 'tku-ucard-title' }, props.title),
      aside,
    ]),
    h('div', { key: 'b', className: 'tku-ucard-body' }, props.children),
  ])
}

function UsageTable(props) {
  const { doc, zh } = props
  if (doc.sources.length === 0) {
    return h('div', { className: 'tku-empty' }, zh ? '还没有任何用量记录' : 'No usage recorded yet')
  }
  const headCells = [
    h('th', { key: 'p' }, zh ? '来源' : 'Source'),
    h('th', { key: 'i', className: 'num' }, zh ? '输入' : 'Input'),
    h('th', { key: 'c', className: 'num' }, zh ? '缓存读' : 'Cache read'),
    h('th', { key: 'w', className: 'num' }, zh ? '缓存写' : 'Cache write'),
    h('th', { key: 'o', className: 'num' }, zh ? '输出' : 'Output'),
    h('th', { key: 't', className: 'num' }, zh ? '合计' : 'Total'),
    h('th', { key: 'n', className: 'num' }, zh ? '调用' : 'Calls'),
    // 效率列：全部由左边那几列当场算出，不引入任何新数据源。缺数就留空（`—`）。
    h('th', { key: 'r', className: 'num' }, zh ? '命中率' : 'Hit rate'),
    h('th', { key: 'a', className: 'num' }, zh ? '均次' : 'Per call'),
    h('th', { key: 's', className: 'num' }, zh ? '输出占比' : 'Output share'),
  ]
  const bodyRows = doc.sources.map((row, index) => {
    const name = row.provider === '' ? (zh ? '未知来源' : 'unknown') : row.provider
    const model = row.model === '' ? null : h('span', { key: 'm', className: 'tku-mono tku-muted' }, ' / ' + row.model)
    // 行级口径与面板总计一致：命中率分母是「喂进去的上下文」，不含 output。
    const billed = row.input + row.cacheRead + row.cacheWrite
    const hitRate = billed > 0 ? row.cacheRead / billed : null
    const perCall = row.calls > 0 ? row.total / row.calls : null
    const outShare = row.total > 0 ? row.output / row.total : null
    return h('tr', { key: 'r' + index }, [
      h('td', { key: 'p' }, [
        h('span', { key: 'd', className: 'tku-legend-dot', style: { background: paletteOf(index) } }),
        h('span', { key: 'n', className: 'tku-name' }, name),
        model,
      ]),
      h('td', { key: 'i', className: 'num tku-mono' }, formatTokens(row.input, zh)),
      h('td', { key: 'c', className: 'num tku-mono' }, formatTokens(row.cacheRead, zh)),
      h('td', { key: 'w', className: 'num tku-mono' }, formatTokens(row.cacheWrite, zh)),
      h('td', { key: 'o', className: 'num tku-mono' }, formatTokens(row.output, zh)),
      h('td', { key: 't', className: 'num tku-mono strong' }, formatTokens(row.total, zh)),
      h('td', { key: 'n', className: 'num tku-mono tku-muted' }, formatExact(row.calls)),
      h('td', { key: 'r', className: 'num tku-mono' }, formatRate(hitRate, zh)),
      h('td', { key: 'a', className: 'num tku-mono' }, perCall === null ? '—' : formatTokens(perCall, zh)),
      h('td', { key: 's', className: 'num tku-mono tku-muted' }, formatRate(outShare, zh)),
    ])
  })
  return h('div', { className: 'tku-table-wrap' },
    h('table', { className: 'tku-table tku-utable' }, [
      h('thead', { key: 'h' }, h('tr', {}, headCells)),
      h('tbody', { key: 'b' }, bodyRows),
    ]))
}

function UsagePanel() {
  const zh = isZhUi()
  const [days, setDays] = useState(30)
  const [trendMode, setTrendMode] = useState('daily')
  const [state, setState] = useState({ loading: true, error: null, doc: null })
  // 列宽现在是纯 CSS 的比例（20/20/30/30），不再有拖拽状态、也没有 localStorage 存档。
  // gridWidth 仍然保留：只是为了让面板知道当前是不是窄屏（决定要不要压缩留白）。
  const [gridWidth, setGridWidth] = useState(0)
  const gridRef = useRef(null)

  useEffect(() => {
    const node = gridRef.current
    if (!node || typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return undefined
    // 只测宽度：列宽由 CSS 的 fr 决定，这里不再反推任何像素位置。
    const observer = new window.ResizeObserver(() => {
      const width = node.getBoundingClientRect().width
      if (typeof width !== 'number') return
      setGridWidth(width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const load = useCallback(async (refresh) => {
    setState((prev) => ({ loading: true, error: null, doc: prev.doc }))
    const result = await fetchUsage(days, refresh)
    if (result.ok !== true) {
      setState({ loading: false, error: String(result.detail ?? result.status ?? 'unknown'), doc: null })
      return
    }
    setState({ loading: false, error: null, doc: result })
  }, [days])

  useEffect(() => {
    load(false)
  }, [load])

  const doc = state.doc
  const totals = doc?.totals
  const scan = doc?.scan

  const windowButtons = USAGE_WINDOWS.map((value) => h('button', {
    key: 'w' + value,
    type: 'button',
    className: 'tku-mode' + (value === days ? ' on' : ''),
    onClick: () => setDays(value),
  }, value === 3650 ? (zh ? '全部' : 'All') : value + (zh ? ' 天' : 'd')))

  const head = h('header', { key: 'head', className: 'tku-uhead' }, [
    h('div', { key: 't', className: 'tku-uhead-text' }, [
      h('h2', { key: 'h', className: 'tku-title' }, zh ? 'Token 用量统计' : 'Token usage'),
      h('p', { key: 's', className: 'tku-sub' }, zh
        ? '数据来自 DSH 自己的会话日志，按模型来源（provider / 模型）归类；统计范围是本机所有 workspace 的全部会话。'
        : 'Sourced from DSH session logs, grouped by provider and model, across every workspace on this machine.'),
      // 前端版本自证：浏览器缓存了旧的 client bundle 时，磁盘和后端都已是新代码，
      // 界面上跑的却还是旧的——表现就是「改了没生效」。这行让那种情况自己说出来，
      // 不必打开开发者工具（桌面版没有入口）。
      h('p', { key: 'v', className: 'tku-sub tku-uver' },
        (zh ? '前端 ' : 'front-end ') + USAGE_UI_VERSION),
    ]),
    h('div', { key: 'a', className: 'tku-uhead-actions' }, [
      h('div', { key: 'w', className: 'tku-modes' }, windowButtons),
      h('button', {
        key: 'r',
        type: 'button',
        className: 'tku-btn primary',
        disabled: state.loading === true,
        onClick: () => load(true),
      }, state.loading === true ? (zh ? '扫描中…' : 'Scanning…') : (zh ? '刷新' : 'Refresh')),
    ]),
  ])

  if (state.error !== null && doc === null) {
    return h('div', { className: 'tku-root tku-upanel' }, [
      head,
      h('div', { key: 'e', className: 'tku-banner bad' }, (zh ? '读取失败：' : 'Failed: ') + state.error),
    ])
  }

  const stats = h('div', { key: 'stats', className: 'tku-stats' }, [
    h(UsageStat, {
      key: 'all',
      label: zh ? '累计消耗' : 'Total',
      value: totals ? formatTokens(totals.all, zh) : '—',
      hint: totals?.firstDay ? (zh ? '自 ' + totals.firstDay + ' 起' : 'since ' + totals.firstDay) : null,
    }),
    h(UsageStat, {
      key: 'today',
      label: zh ? '今日' : 'Today',
      value: totals ? formatTokens(totals.today, zh) : '—',
      hint: totals?.todayDay ?? null,
    }),
    h(UsageStat, {
      key: 'week',
      label: zh ? '近 7 天' : 'Last 7 days',
      value: totals ? formatTokens(totals.week, zh) : '—',
      hint: null,
    }),
    h(UsageStat, {
      key: 'calls',
      label: zh ? '调用次数' : 'Calls',
      value: totals ? formatExact(totals.calls) : '—',
      hint: totals ? (zh
        ? totals.providers + ' 个来源 · ' + totals.sources + ' 个模型'
        : totals.providers + ' providers · ' + totals.sources + ' models') : null,
    }),
    // 缓存三指标。口径写在 hint 里，因为「命中率」的分母不是所有人默认的那一个：
    // 分母是 input + cacheRead + cacheWrite（喂进去的上下文），**不含 output**
    // ——output 是生成出来的，把它算进分母会让命中率凭空变好看。
    h(UsageStat, {
      key: 'hit',
      label: zh ? '缓存命中' : 'Cache hits',
      value: totals?.cacheHit !== undefined ? formatTokens(totals.cacheHit, zh) : '—',
      hint: zh ? '命中缓存的输入 token' : 'input tokens served from cache',
    }),
    h(UsageStat, {
      key: 'miss',
      label: zh ? '缓存未命中' : 'Cache misses',
      value: totals?.cacheMiss !== undefined ? formatTokens(totals.cacheMiss, zh) : '—',
      hint: zh ? '输入 + 写入缓存' : 'input + cache write',
    }),
    h(UsageStat, {
      key: 'rate',
      label: zh ? '缓存命中率' : 'Cache hit rate',
      value: totals ? formatRate(totals.cacheHitRate, zh) : '—',
      hint: zh ? '命中 ÷（输入 + 命中 + 写入），不含输出' : 'hits ÷ (input + hits + writes), excluding output',
      tone: totals?.cacheHitRate === null ? null : 'good',
    }),
  ])

  const trendToggle = h('div', { className: 'tku-modes' }, [
    h('button', {
      key: 'd',
      type: 'button',
      className: 'tku-mode' + (trendMode === 'daily' ? ' on' : ''),
      onClick: () => setTrendMode('daily'),
    }, zh ? '每日' : 'Daily'),
    h('button', {
      key: 'c',
      type: 'button',
      className: 'tku-mode' + (trendMode === 'cumulative' ? ' on' : ''),
      onClick: () => setTrendMode('cumulative'),
    }, zh ? '累计' : 'Cumulative'),
  ])

  const trendCard = h(UsageCard, { key: 'trend', title: zh ? '消耗趋势' : 'Usage trend', aside: trendToggle },
    doc ? h(UsageTrendChart, { series: doc.series, zh, mode: trendMode }) : null)

  const donutCard = h(UsageCard, { key: 'donut', title: zh ? '来源分布' : 'By provider' },
    doc ? h(UsageDonut, { rows: doc.providers.slice(0, 6), zh }) : null)

  // 排行卡：条目数不设限（原来的 limit: 8 会把第 9 名以后的模型直接丢掉），
  // 多出来的靠卡片内部滚动看。scope 传进 UsageRank 只为在标题旁标出总数。
  const rankCard = h(UsageCard, {
    key: 'rank',
    title: zh ? '模型使用排行' : 'Top models',
    scroll: true,
    aside: doc ? h('span', { className: 'tku-ucard-aside tku-mono' }, (zh ? '共 ' : '') + doc.sources.length + (zh ? ' 个' : '')) : null,
  }, doc ? h(UsageRank, { rows: doc.sources, zh }) : null)

  // 第四张：本机实测模型的能力排行。数据跟 `doc` 同一次请求回来（后端 `ranking`），
  // 名次是「用量 × 榜单分数」，与页面最下方「模型权威排名」（本机可用清单）分工不同，
  // 卡头副标题把这一点写死，免得两张表被当成同一个东西。
  const abilityCard = h(UsageCard, {
    key: 'ability',
    title: zh ? '本机模型能力排行' : 'Local model capability',
    scroll: true,
    aside: h('span', { className: 'tku-ucard-aside' }, zh ? '实际用过的' : 'as actually used'),
  }, doc ? h(UsageAbilityRank, { ranking: doc.ranking ?? null, zh }) : null)

  const tableCard = h(UsageCard, {
    key: 'table',
    title: zh ? '按来源明细' : 'Sources',
    // 明细表行数随来源数增长（本机 27 行），高度必须封顶，否则会把整页拉得很长。
    // is-scroll-table 让表体在自己的框里上下滚动，表头始终可见。
    scroll: 'table',
    aside: doc ? h('span', { className: 'tku-mono' }, (zh ? '共 ' : '') + doc.sources.length + (zh ? ' 个来源 · ' : '') + (zh ? '更新于 ' : 'updated ') + sinceLabel(Date.parse(doc.generatedAt), zh)) : null,
  }, doc ? h(UsageTable, { doc, zh }) : null)

  let footer = null
  if (scan) {
    const megabytes = Math.round(scan.bytes / 1048576)
    footer = h('div', { key: 'foot', className: 'tku-sub tku-ufoot' }, zh
      ? '扫描 ' + scan.files + ' 个会话文件（' + megabytes + ' MB，本次重扫 ' + scan.scannedFiles + ' 个）· '
        + formatExact(scan.messages) + ' 条计费消息 · 耗时 ' + scan.elapsedMs + ' ms'
        + (scan.partial ? ' · 本次因超时未扫完' : '')
        + (scan.unknownSource > 0 ? ' · ' + scan.unknownSource + ' 条记录没有来源信息（已归入「未知来源」）' : '')
      : 'Scanned ' + scan.files + ' session files (' + megabytes + ' MB, ' + scan.scannedFiles + ' rescanned) · '
        + formatExact(scan.messages) + ' billed messages · ' + scan.elapsedMs + ' ms')
  }

  return h('div', { className: 'tku-root tku-upanel' }, [
    head,
    stats,
    // 四张卡。列宽固定 20% / 20% / 30% / 30%（2:2:3:3 的 fr），不再提供拖拽把手：
    // 比例自适应比手动像素更省心，也不会出现「拖过一次之后窗口一变就排不下」。
    h('div', {
      key: 'charts',
      className: 'tku-ugrid',
      ref: gridRef,
    }, [
      trendCard,
      donutCard,
      rankCard,
      abilityCard,
    ]),
    tableCard,
    // 模型权威排名放在最下方：它是「接下来用哪个」的问题，与上面的「过去用了多少」
    // 是两件事，所以独立成一块，也套自己的错误边界。
    h(ModelRankSafe, { key: 'modelrank' }),
    footer,
  ])
}

/**
 * 面板的错误边界。
 *
 * 为什么必须有：`main` slot 里的组件一旦在渲染期抛异常，宿主会把整个面板
 * 渲染成空白/回退，**浏览器控制台里那行错误用户看不到**（桌面版没有 devtools
 * 入口），表现就是「点了侧栏按钮什么都没发生」。有了这个边界，同一个故障
 * 会变成页面上的一行红字，用户能直接把原因读给我。
 *
 * React 的错误边界只能用 class 实现（getDerivedStateFromError 是类专有的
 * 生命周期，函数组件没有等价物）。
 */
class UsageErrorBoundary extends react.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (error !== null && error !== undefined) {
      const detail = String((error && error.message) || error)
      return h('div', { className: 'tku-root tku-upanel' }, [
        h('div', { key: 't', className: 'tku-title' }, 'Token 用量统计'),
        h('div', { key: 'e', className: 'tku-banner bad' },
          '面板渲染失败：' + detail + '（请把这行文字发给维护者）'),
      ])
    }
    return this.props.children
  }
}

/** `main` slot 的入口：面板本体套在错误边界里。 */
function UsagePanelSafe(props) {
  return h(UsageErrorBoundary, null, h(UsagePanel, props))
}
