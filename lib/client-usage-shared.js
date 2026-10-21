/**
 * 用量统计页面（`main` slot）共用的工具与文案。
 *
 * 本文件是 dsh-token-usage 的前端片段，被 scripts/sync-usage-parts.mjs
 * 拼进 lib/client.js 的标记区。片段单独成文件（好读、好审、能 `node --check`），
 * 但运行期必须与 client.js 的 factory 同作用域——宿主只认 package.json
 * `exports` 里那一个 `./client` 入口。
 *
 * 图表全部是手写 SVG。理由不是洁癖：
 *   1. 这个插件的 client.js 只能 require `react` 与 `react/jsx-runtime`，
 *      引不进 ECharts / Recharts；把图表库塞进宿主 bundle 更不可能。
 *   2. 需要画的只有柱、环，SVG 路径足够，且颜色能直接吃
 *      `--dsw-alias-*` 主题变量——换主题时图表跟界面一起变，不需要重绘。
 */

/** 当前界面语言是否为中文。与 client.js 的 `t()` 同一判据，避免两处各猜一次。 */
function isZhUi() {
  return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')
}

/** 双语取词：中文界面取前一个，英文界面取后一个。 */
function t(zh, en) {
  return isZhUi() ? zh : en
}

/**
 * 把响应体解析成 `{ok, ...}`。
 *
 * 宿主的路由对失败统一回 `{ ok: false, status, detail }`；网络层失败（DSH 没起来、
 * 插件被禁用）连响应都没有，此时合成一个同形状的对象，让上层只用一套判断。
 */
async function callJson(url, options) {
  let response
  try {
    response = await fetch(url, options)
  } catch (error) {
    return {
      ok: false,
      status: 'network',
      detail: '无法连接 DSH 服务：' + String(error && error.message ? error.message : error),
    }
  }
  let body = null
  const text = await response.text()
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (body === null || typeof body !== 'object') {
    return {
      ok: false,
      status: 'bad-response',
      detail: '服务返回了无法解析的内容（HTTP ' + response.status + '）',
    }
  }
  // HTTP 失败而载荷里没带 ok 时补一个，让上层只用一套判断。
  if (response.ok === false && body.ok === undefined) body.ok = false
  return body
}

/** 统一的 token 数字格式：过万折成 `1.2万` / `12.3K`，保留一位小数。 */
function formatTokens(value, zh) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (zh) {
    if (value >= 1e8) return (value / 1e8).toFixed(2) + '亿'
    if (value >= 1e4) return (value / 1e4).toFixed(1) + '万'
    return String(Math.round(value))
  }
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B'
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K'
  return String(Math.round(value))
}

/** 精确数字：带千位分隔符，用于 tooltip 与「精确」模式。 */
function formatExact(value) {
  if (!Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString()
}

/**
 * 比率显示：`null`（分母为 0，读不到）显示「—」，**不显示 0%**。
 *
 * 这条与余额徽标是同一个口径：0% 是一个读数，「读不到」不是。把后者画成 0%
 * 会让人以为缓存完全没命中，而事实可能只是这批日志里没有缓存字段。
 */
function formatRate(value, zh) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return (value * 100).toFixed(1) + '%'
}

/** 相对时间：「3 分钟前」。 */
function sinceLabel(ms, zh) {
  const delta = Math.max(0, Date.now() - ms)
  const minute = 60_000
  if (delta < minute) return zh ? '刚刚' : 'just now'
  if (delta < 60 * minute) return Math.floor(delta / minute) + (zh ? ' 分钟前' : 'm ago')
  const hours = Math.floor(delta / (60 * minute))
  if (hours < 24) return hours + (zh ? ' 小时前' : 'h ago')
  return Math.floor(hours / 24) + (zh ? ' 天前' : 'd ago')
}

/** 把 provider id 翻成一个人类能读的名字；不认识的照原样显示，不猜。 */
const PROVIDER_LABELS = {
  workbuddy: 'WorkBuddy',
  'workbuddy-global': 'WorkBuddy AI',
  trae: 'TRAE',
  'trae-global': 'TRAE AI',
  'qoder-cn': 'Qoder',
  'deepseek-account': 'DeepSeek（账号）',
  'deepseek-official': 'DeepSeek（官方）',
  siliconflow: 'SiliconFlow',
  xiaomi: '小米 MiMo',
  zai: '智谱 GLM',
  openrouter: 'OpenRouter',
  freeroute: 'FreeRoute',
  dumate: '百度搭子',
  lingxi: 'WPS 灵犀',
}

function providerLabel(id) {
  if (id === '') return '未知来源'
  return PROVIDER_LABELS[id] ?? id
}

/** 一条折线的坐标；`series` 是 `{day, total}` 数组。 */
function linePath(values, width, height, max) {
  if (values.length === 0) return ''
  const step = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((value, index) => {
      const x = index * step
      const y = max === 0 ? height : height - (value / max) * height
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

/** 面积图：折线 + 到底边的闭合路径。 */
function areaPath(values, width, height, max) {
  const line = linePath(values, width, height, max)
  if (line === '') return ''
  return `${line} L${width.toFixed(2)},${height.toFixed(2)} L0,${height.toFixed(2)} Z`
}

/** 环形图的一段扇形路径。 */
function arcPath(cx, cy, radius, thickness, start, end) {
  const outer = radius
  const inner = radius - thickness
  const p = (r, angle) => {
    const a = angle - Math.PI / 2
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  }
  const large = end - start > Math.PI ? 1 : 0
  const [x1, y1] = p(outer, start)
  const [x2, y2] = p(outer, end)
  const [x3, y3] = p(inner, end)
  const [x4, y4] = p(inner, start)
  return [
    `M${x1.toFixed(2)},${y1.toFixed(2)}`,
    `A${outer},${outer} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`,
    `L${x3.toFixed(2)},${y3.toFixed(2)}`,
    `A${inner},${inner} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(2)}`,
    'Z',
  ].join(' ')
}

/** 图表配色：全部取主题 token，深浅色主题自动跟随。 */
const PALETTE = [
  'var(--dsw-alias-state-business-primary, #4d6bfe)',
  'var(--dsw-alias-state-success-primary, #2e9e5b)',
  'var(--dsw-alias-state-warning-primary, #d9921a)',
  'var(--dsw-alias-state-error-primary, #d9503f)',
  'var(--dsw-alias-label-tertiary, #8a8a95)',
  'var(--dsw-alias-label-secondary, #5f5f6b)',
]

function paletteOf(index) {
  return PALETTE[index % PALETTE.length]
}
