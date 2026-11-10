// ---- 图表：柱状（消耗趋势） / 环形（来源分布） ----
//
// 全部手写 SVG，不引图表库：client.js 只能 require react，而且用 --dsw-alias-*
// 变量上色能让图表跟着主题（浅色 / 深色）一起变，不需要监听主题事件。
//
// 消耗趋势原本是折线 + 面积，用户要求改成柱状图（2026-10-20），所以
// usageLinePath / usageAreaPath 一并删掉，避免留下没人调用的死代码。

/**
 * 面板与侧栏共用的 slot id：两者同名，宿主才会把侧栏项和这块主面板联成一组。
 *
 * id 必须带本插件自己的前缀：slot id 是宿主侧的全局命名空间，撞上别的插件
 * 的 id 会让宿主把两个插件的侧栏项与主面板联成一组——点一个打开另一个。
 */
const USAGE_SLOT_ID = 'dsh-token-usage-usage'

/** 柱状图下沿的基线。`max <= 0` 时所有柱子压成零高，而不是除以零。 */
function usageBarHeight(value, height, max) {
  if (max <= 0 || value <= 0) return 0
  return (value / max) * height
}

/** 环形图的一段扇形（外弧 → 内弧闭合）。 */
function usageArcPath(cx, cy, radius, thickness, start, end) {
  const inner = radius - thickness
  const point = (r, angle) => {
    const a = angle - Math.PI / 2
    return (cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2)
  }
  const large = end - start > Math.PI ? 1 : 0
  return [
    'M' + point(radius, start),
    'A' + radius + ',' + radius + ' 0 ' + large + ' 1 ' + point(radius, end),
    'L' + point(inner, end),
    'A' + inner + ',' + inner + ' 0 ' + large + ' 0 ' + point(inner, start),
    'Z',
  ].join(' ')
}

function UsageTrendChart(props) {
  const { series, zh, mode } = props
  // 坐标系定在 360x150：柱子的槽宽按 series.length 均分，SVG 用
  // preserveAspectRatio="none" 横向拉满卡片、纵向写死高度（--tku-trend-h），
  // 所以 viewBox 的宽高比只决定「柱子画得细不细」，不决定实际尺寸。
  // 竖向刻度标签会画到 x = width + 6 之外，左右各留一点边距，否则数字被卡片裁掉。
  const width = 360
  const height = 150
  const values = series.map((point) => point.total)
  const max = values.reduce((a, b) => Math.max(a, b), 0)
  if (values.length === 0 || max === 0) {
    return h('div', { className: 'tku-empty' }, zh ? '这个区间还没有消耗记录' : 'No usage recorded in this range')
  }
  // 累计模式：把每日值累加，用来回答「一共花掉多少」。
  let running = 0
  const shown = mode === 'cumulative' ? values.map((value) => (running += value)) : values
  const shownMax = shown.reduce((a, b) => Math.max(a, b), 0)
  // 画布比绘图区高 topPad：顶端留给「当前值」气泡，不给气泡底下的柱子涂色
  // （工具栏的「累计」按钮就悬在那儿，柱子涂上去会把它顶得看不清）。
  const topPad = 12
  const plotHeight = height - topPad
  const ticks = [0, 0.5, 1].map((fraction) => ({ fraction, y: height - fraction * plotHeight, value: shownMax * fraction }))
  // 柱状图不再是「点连点」：每根柱子占一个等宽槽位，槽内按比例留白，形成柱间空隙。
  const slot = series.length > 0 ? width / series.length : 0
  const barWidth = Math.max(1, slot * 0.62)
  const labelEvery = Math.max(1, Math.floor(series.length / 6))

  // 文字全部改用 HTML 覆盖层（.tku-chart-text）：preserveAspectRatio="none" 把
  // 坐标系横向拉满卡片（402 → 实际卡宽，约 1.3 倍以上），柱子是实心矩形拉了看
  // 不出来，网格线有 non-scaling-stroke 兜底，唯独文字会被拉胖——用户实测「字是
  // 扁的」。覆盖层与 SVG 共用同一套 viewBox 百分比坐标，字形走浏览器原生渲染，
  // 横竖比例永远正常、还更清晰。
  // 峰值气泡和刻度数字挤在同一列，所以右边留 30 才够，留窄了两行字会叠在一起。
  const labelWidth = 30
  const boxWidth = width + labelWidth + 12
  // 轴线下方只留 15 个单位放日期标签（原 22——标签条太厚，轴线悬得高，用户要求下移）。
  const boxHeight = height + 15
  const pctOf = (value, base) => (value / base * 100).toFixed(3) + '%'

  const gridLines = []
  const overlayTexts = []
  for (const tick of ticks) {
    // 网格线止于绘图区右沿，右侧那一小截干净地留给刻度数字，不再从数字底下穿过去。
    gridLines.push(h('line', { key: 'g' + tick.fraction, x1: 0, x2: width, y1: tick.y, y2: tick.y, className: 'tku-chart-grid' }))
    // 刻度数字：贴在绘图区右沿外 8，垂直居中对齐各自的网格线。
    overlayTexts.push(h('span', {
      key: 't' + tick.fraction,
      className: 'tku-chart-tick',
      style: { left: pctOf(width + 8, boxWidth), top: pctOf(tick.y, boxHeight) },
    }, formatTokens(tick.value, zh)))
  }

  series.forEach((point, index) => {
    if (index % labelEvery !== 0 && index !== series.length - 1) return
    // 日期标签：落在柱子槽位正中、轴线下方 3px。
    overlayTexts.push(h('span', {
      key: 'x' + index,
      className: 'tku-chart-date',
      style: { left: pctOf(index * slot + slot / 2, boxWidth), top: 'calc(' + pctOf(height, boxHeight) + ' + 3px)' },
    }, point.day.slice(5)))
  })

  // 每根柱子底部对齐 y=height，高度按 shownMax 归一。柱子用非缩放描边，
  // 横向被拉宽也不会把颜色拉糊。
  const shapes = shown.map((value, index) => {
    const barHeight = usageBarHeight(value, plotHeight, shownMax)
    if (barHeight <= 0) return null
    return h('rect', {
      key: 'b' + index,
      x: (index * slot + (slot - barWidth) / 2).toFixed(2),
      y: (height - barHeight).toFixed(2),
      width: barWidth.toFixed(2),
      height: barHeight.toFixed(2),
      className: mode === 'cumulative' ? 'tku-chart-bar is-cumulative' : 'tku-chart-bar',
    })
  }).filter(Boolean)

  // 最高那根柱子的数值直接写在柱子顶上，一来最高点常被裁在框线外，二来顺着柱子读比
  // 抬头对刻度更直观。字压在柱子上（柱子是不透明的），所以不会有「卡在线上」的问题；
  // 柱子太低时没有地方落脚，就不画。
  // 累计模式下最高点永远是最后一根、贴着右边框，所以气泡改成右对齐并往中间收一点，
  // 否则会和右侧刻度数字叠在一起。
  const cumulativeMode = mode === 'cumulative'
  const peakIndex = shown.indexOf(shownMax)
  const peak = shownMax > 0 ? shownMax : 0
  const peakY = height - (peak / shownMax) * plotHeight - 5
  const peakLabel = peak > 0 && (peak / shownMax) * plotHeight > 18
    ? h('span', {
      key: 'peak',
      className: 'tku-chart-peak',
      style: {
        left: pctOf(cumulativeMode
          ? peakIndex * slot + slot / 2 - slot * 0.35
          : peakIndex * slot + slot / 2, boxWidth),
        top: pctOf(peakY, boxHeight),
        transform: (cumulativeMode ? 'translateX(-100%)' : 'translateX(-50%)') + ' translateY(-100%)',
      },
    }, formatTokens(peak, zh))
    : null

  const svg = h('svg', {
    viewBox: '0 0 ' + boxWidth + ' ' + boxHeight,
    preserveAspectRatio: 'none',
    className: 'tku-chart-svg',
    role: 'img',
    'aria-label': zh ? '消耗趋势' : 'usage trend',
  }, [
    h('g', { key: 'grid' }, gridLines),
    h('g', { key: 'bars' }, shapes),
  ])

  // 内层 box 与 SVG 同尺寸（SVG 撑起高度），覆盖层的百分比坐标才对得上 SVG。
  // box 用 margin-top:auto 把整块图表压到 body 底部（轴线贴底）。
  return h('div', { className: 'tku-chart' }, [
    h('div', { className: 'tku-chart-box' }, [
      svg,
      h('div', { className: 'tku-chart-text' }, [overlayTexts, peakLabel]),
    ]),
  ])
}

function UsageDonut(props) {
  const { rows, zh } = props
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  if (total === 0) {
    return h('div', { className: 'tku-empty' }, zh ? '暂无数据' : 'No data')
  }
  // 132 的时候和旁边 6 行图例一对比显得空；后来放大到 168、再放大到 196，
  // 环径占比一直保持「radius/size = 0.44」，视觉重量才和左右两张图对齐。
  // 配合 CSS 里的 .tku-donut { height } 一起改，两处尺寸必须一致。
  //
  // 196 → 156 → 120 → 150 → 180：四张卡的行高 380→300→250→210 后，body 只剩 156px，
  // 环必须同比缩小，否则会被卡片的 overflow:hidden 切掉底边。
  // 缩放系数 120/156 ≈ 0.769，radius 与 thickness 一起按比例走，
  // 环径占比仍是 0.44，视觉重量不变。环小了，并排所需宽度也从 356 降到 250px，
  // 1200px 起的窗口就能把图例和环并排放下。
  const size = 180
  const radius = 80
  const thickness = 18
  // viewBox 之外再留 4px 余量：右边那一大刀弧（R8）的边缘落在 svg 框外正好被裁掉，
  // overflow:hidden 的容器（可拖拽的窄卡）会把它削成一条竖切线。
  const pad = 4
  const box = size + pad * 2
  let angle = 0
  const arcs = []
  const legend = []
  rows.forEach((row, index) => {
    const span = (row.total / total) * Math.PI * 2
    arcs.push(h('path', {
      key: 's' + index,
      d: usageArcPath(size / 2 + pad, size / 2 + pad, radius, thickness, angle, angle + span),
      fill: paletteOf(index),
    }))
    angle += span
    legend.push(h('li', { key: 'l' + index }, [
      h('span', { key: 'd', className: 'tku-legend-dot', style: { background: paletteOf(index) } }),
      h('span', { key: 'n', className: 'tku-legend-name' }, providerLabel(row.provider)),
      h('span', { key: 'v', className: 'tku-legend-val' }, formatTokens(row.total, zh)),
      h('span', { key: 'p', className: 'tku-legend-pct' }, ((row.total / total) * 100).toFixed(1) + '%'),
    ]))
  })
  const track = h('circle', {
    cx: size / 2 + pad, cy: size / 2 + pad, r: radius - thickness / 2,
    fill: 'none', className: 'tku-chart-grid', strokeWidth: thickness,
  })
  return h('div', { className: 'tku-donut-wrap' }, [
    h('svg', { key: 'svg', viewBox: '0 0 ' + box + ' ' + box, className: 'tku-donut' }, [track, ...arcs]),
    h('ul', { key: 'legend', className: 'tku-legend' }, legend),
  ])
}

/** 模型用量排行：横向条形图，条宽按占比缩放。 */
function UsageRank(props) {
  const { rows, zh, limit } = props
  const shown = rows.slice(0, limit || rows.length)
  const max = shown.reduce((a, row) => Math.max(a, row.total), 0)
  if (shown.length === 0 || max === 0) {
    return h('div', { className: 'tku-empty' }, zh ? '暂无数据' : 'No data')
  }
  return h('ul', { className: 'tku-rank' }, shown.map((row, index) => {
    const pct = max > 0 ? (row.total / max) * 100 : 0
    return h('li', { key: row.provider + ':' + row.model }, [
      h('div', { key: 'top', className: 'tku-rank-top' }, [
        h('span', { key: 'n', className: 'tku-rank-name', title: row.merged ? (row.modelLabel ?? row.model) : (row.modelLabel ?? row.model) + ' / ' + row.provider }, row.merged ? (row.modelLabel ?? row.model) : (row.modelLabel ?? row.model) + ' / ' + providerLabel(row.provider)),
        h('span', { key: 'v', className: 'tku-rank-val' }, formatTokens(row.total, zh)),
      ]),
      h('div', { key: 'bar', className: 'tku-rank-bar' },
        h('span', { className: 'tku-rank-fill', style: { width: pct.toFixed(1) + '%', background: paletteOf(index) } })),
    ])
  }))
}
