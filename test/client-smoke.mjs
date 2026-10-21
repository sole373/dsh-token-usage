/**
 * 端到端冒烟：用假的宿主环境把 client.js 真跑一遍。
 *
 * 目的不是覆盖 UI 细节，而是抓三类「只会在真机才炸」的错误：
 *   1. 片段注入后出现未定义符号（例如 h / useMemo 没接上）；
 *   2. slot 注册参数形状不对（名字/key/locale）；
 *   3. 面板渲染时读不到数据就抛异常（React 里表现为白屏，日志里什么都没有）。
 *
 * 它渲染成静态字符串，所以不需要 DOM，也不需要 React 的 DOM renderer。
 *
 * 跑法：node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js')

// 插件不装 react：宿主在运行时把 `react` / `react/jsx-runtime` 塞进模块加载器。
// 所以这里也不 require 它——下面的 shim 就是「宿主那种极简 React」的替身。

const source = readFileSync(CLIENT_PATH, 'utf8')

// ---- 极简 React：只实现渲染成 HTML 字符串所需的那部分 ----
class FakeNode {
  constructor(type, props, children) {
    this.type = type
    this.props = props ?? {}
    // children 可能是单个节点、数组或 undefined（props.children 的三种形态）。
    const list = children === undefined || children === null ? [] : [children]
    this.children = list.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  }
}

function createElement(type, props, ...children) {
  // jsx-runtime 的调用形态是 createElement(type, { children })，children 藏在
  // props 里；只有 createElement 形态才在第三个参数之后。两种都要接住。
  const own = props?.children
  const supplied = children.length > 0 ? children : (own === undefined ? [] : own)
  return new FakeNode(type, props, supplied)
}

// ---- 极简 hooks：**按组件分别存槽位** ----
//
// 桩必须照 React 的做法按组件实例分配槽位：子组件的 useState 若与父组件共用
// 槽位，子组件会覆盖父组件的状态，父组件于是读到 undefined——那是桩的失败，
// 不是面板的失败。
const hookStore = new Map() // 组件函数 → { slots: [], index: 0 }
let currentComponent

function hooksFor(fn) {
  let entry = hookStore.get(fn)
  if (entry === undefined) {
    entry = { slots: [], index: 0 }
    hookStore.set(fn, entry)
  }
  return entry
}

/** 按组件名取槽位：组件函数是 factory 闭包里的，测试只能按名字找。 */
function hooksByName(name) {
  for (const [fn, entry] of hookStore) {
    if (fn.name === name) return entry
  }
  return undefined
}

const effects = []

// 极简 React.Component：错误边界要用 class 实现，桩必须能承受 extends。
class FakeComponent {
  constructor(props) {
    this.props = props ?? {}
    this.state = {}
  }

  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
  }
}

const ReactShim = {
  Component: FakeComponent,
  createElement,
  useState(initial) {
    const entry = hooksFor(currentComponent)
    const slot = entry.index++
    if (!(slot in entry.slots)) entry.slots[slot] = typeof initial === 'function' ? initial() : initial
    return [
      entry.slots[slot],
      (next) => { entry.slots[slot] = typeof next === 'function' ? next(entry.slots[slot]) : next },
    ]
  },
  useMemo(factory) {
    hooksFor(currentComponent).index++
    return factory()
  },
  useCallback(fn) {
    hooksFor(currentComponent).index++
    return fn
  },
  useEffect(fn) {
    hooksFor(currentComponent).index++
    effects.push(fn)
  },
  useRef(value) {
    hooksFor(currentComponent).index++
    return { current: value }
  },
}

// ---- 假的 fetch：返回 /usage 与 /model-rank 端点 ----
const usageDoc = {
  ok: true,
  generatedAt: new Date().toISOString(),
  windowDays: 30,
  scan: { files: 43, scannedFiles: 0, reusedFiles: 43, messages: 8454, unknownSource: 67, bytes: 53_700_000, elapsedMs: 7, partial: false },
  totals: { all: 871_663_183, today: 37_906_334, week: 703_253_086, calls: 8454, sources: 20, providers: 11, firstDay: '2026-09-26', todayDay: '2026-10-19' },
  sources: [
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash', label: 'WorkBuddy / deepseek-v4.1-flash', input: 12_000_000, output: 900_000, cacheRead: 267_000_000, cacheWrite: 0, total: 280_735_049, calls: 3101 },
    { provider: 'siliconflow', model: 'Qwen/Qwen3-235B', label: 'SiliconFlow / Qwen/Qwen3-235B', input: 5_000_000, output: 400_000, cacheRead: 0, cacheWrite: 0, total: 5_400_000, calls: 120 },
    { provider: '', model: '', label: '内部 / 标题', input: 900, output: 300, cacheRead: 0, cacheWrite: 0, total: 1200, calls: 40 },
  ],
  providers: [
    { provider: 'workbuddy', label: 'WorkBuddy', total: 331_317_425, calls: 3484, models: 4 },
    { provider: 'siliconflow', label: 'SiliconFlow', total: 52_510_359, calls: 579, models: 3 },
  ],
  series: [
    { day: '2026-09-26', total: 1_000_000, perSource: {} },
    { day: '2026-09-27', total: 0, perSource: {} },
    { day: '2026-09-28', total: 2_500_000, perSource: {} },
    { day: '2026-09-29', total: 3_100_000, perSource: {} },
  ],
}
// 模型排名文档：真实形状（后端 model-rank.js 产出），但内容裁到最小——
// 这里要验的是「渲染不炸 + 三态各自说了该说的话」，不是榜单数值。
const rankDoc = {
  ok: true,
  fetchedAt: new Date().toISOString(),
  source: 'https://openrouter.ai/api/v1/models',
  stale: false,
  error: null,
  availability: 'local-session-logs',
  availabilityNote: { zh: '只统计本机会话日志里真实出现过的模型。', en: 'Local session logs only.' },
  localCatalog: { scope: 'used', count: 2, note: { zh: '收录范围：实测用过的模型。', en: 'Scope: actually used models.' } },
  counts: { local: 4, matched: 2, unmatched: 2, scored: 2 },
  unmatched: [],
  entries: [
    { provider: 'workbuddy', id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', multiplier: 0.34, matchKind: 'exact', label: 'DeepSeek V4.1 Flash', intel: 62.5, coding: 58.1, agentic: 60.2, codingArena: null, ctx: 128000, price: 0.28, image: false },
    { provider: 'trae', id: 'kimi-k3', name: 'kimi-k3', multiplier: 1.83, matchKind: 'prefix', label: 'Kimi K3', intel: 71.2, coding: 69.8, agentic: 70.1, codingArena: null, ctx: 262144, price: 1.2, image: true },
  ],
  tasks: [
    { id: 'coding', zhLabel: '写代码', enLabel: 'Coding', zhRule: '按编码指数降序', enRule: 'by coding index', metric: 'index', rows: [{ provider: 'trae', id: 'kimi-k3', name: 'kimi-k3', value: 69.8 }] },
    { id: 'longctx', zhLabel: '长文档', enLabel: 'Long context', zhRule: '按上下文窗口降序', enRule: 'by context window', metric: 'tokens', rows: [{ provider: 'trae', id: 'kimi-k3', name: 'kimi-k3', value: 262144 }] },
  ],
}

const calls = []
globalThis.fetch = async (url) => {
  calls.push(String(url))
  const text = String(url)
  const body = text.includes('/model-rank') ? rankDoc : (text.includes('/usage') ? usageDoc : { ok: false, status: 'not-found' })
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}
// Node 自带只读的 navigator（getter），只能用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 把 client.js 的 factory 取出来单独跑 ----
//
// client.js 是固定开头那句 `window.__ModuleLoader__.load({...})`；把它的实参
// 换成桩，factory 就落进 captured —— 不需要 DOM，也不需要真宿主。
let captured
const loaderWindow = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, factory }
    },
  },
}
globalThis.window = loaderWindow
// 把 h（= jsxRuntime.jsx）换成直通包装，能直接看到面板每次建了什么节点。
// 严格复刻 `react/jsx-runtime` 的真实签名：`jsx(type, props, key?)`——**只有两参**，
// children 必须在 `props.children` 里，第三个参数是 key。
const RealShim = {
  jsx: (type, props) => createElement(type, props),
  jsxs: (type, props) => createElement(type, props),
  Fragment: 'fragment',
}
const TracedShim = {
  ...RealShim,
  jsx: (type, props) => {
    const node = createElement(type, props)
    if (globalThis.__trace) globalThis.__trace.push([typeof type === 'function' ? type.name : String(type), node.children.length])
    return node
  },
}
globalThis.__trace = []
try {
  new Function('window', 'navigator', 'document', 'fetch', 'setInterval', 'clearInterval', source)(
    loaderWindow, globalThis.navigator, globalThis.document, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval,
  )
} catch (error) {
  console.log('EVAL FAILED:', error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : String(error))
  throw error
}
if (captured === undefined) throw new Error('client.js did not register a module')

const moduleRequire = (name) => {
  if (name === 'react') return ReactShim
  if (name === 'react/jsx-runtime') return TracedShim
  throw new Error('unexpected require: ' + name)
}

const exportsObject = captured.factory(moduleRequire)
console.log('[1] module id =', captured.id)
console.log('[2] exports =', Object.keys(exportsObject).join(','))
if (typeof exportsObject.apply !== 'function') throw new Error('apply missing')
if (!Array.isArray(exportsObject.inject)) throw new Error('inject must be a static array')
console.log('[3] inject =', JSON.stringify(exportsObject.inject))

// ---- 假 ctx：记录全部 slot 注册 ----
const registrations = []
const injectedKeys = []
const ctx = {
  slots: {
    inject(key, callback) {
      injectedKeys.push(key)
      callback()
      return () => {}
    },
    register(meta, component) {
      registrations.push({ meta, component })
      return () => {}
    },
  },
}

exportsObject.apply(ctx)
console.log('[4] injected slots =', JSON.stringify(injectedKeys))
for (const { meta } of registrations) {
  console.log('    register', JSON.stringify(meta))
}
// 本插件只贡献两个槽：侧栏入口 + 主面板。签到设置页与输入框徽标
// 留在 dsh-agent-checkin 那边，不在这里重复注册。
if (injectedKeys.length !== 2) throw new Error('expected 2 slot injections, got ' + injectedKeys.length)

const byName = (name) => registrations.filter((r) => r.meta.name === name)
const panelMeta = byName('main')[0]
const sideMeta = byName('sidebar.panellist')[0]
if (panelMeta === undefined || sideMeta === undefined) throw new Error('main / sidebar.panellist not registered')
if (panelMeta.meta.key !== sideMeta.meta.id) throw new Error('sidebar id and main key must match')
if (typeof sideMeta.component !== 'function') throw new Error('sidebar.panellist entry must have a component function')
// main 必须注册「带错误边界」的安全壳，而不是面板本体：渲染期抛异常时
// 用户才能看到一行红字而不是空白（桌面版没有 devtools）。
if (panelMeta.component.name !== 'UsagePanelSafe') {
  throw new Error('main entry must register UsagePanelSafe, got ' + panelMeta.component.name)
}
console.log('[5] sidebar id === main key ===', panelMeta.meta.key)
console.log('[6] label zh =', sideMeta.meta.label())

// ---- 渲染成字符串 ----
/** 逐层摊平子节点数组（React 也这么干）。 */
function flatten(nodes) {
  const out = []
  const walk = (item) => {
    if (item === null || item === undefined || item === false || item === true) return
    if (Array.isArray(item)) {
      item.forEach(walk)
      return
    }
    out.push(item)
  }
  walk(nodes)
  return out
}

function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  if (Array.isArray(node)) return node.map(render).join('')
  if (node instanceof FakeNode) {
    if (typeof node.type === 'function') {
      // class 组件（错误边界）：必须 new 后调 render，不能当函数调用。
      if (node.type.prototype !== undefined && typeof node.type.prototype.render === 'function') {
        const instance = new node.type({ ...node.props, children: node.children })
        return render(instance.render())
      }
      // React 的 hook 游标是「每渲染一个组件实例从 0 开始，像调用栈一样进出」。
      // 这里按组件函数切换 currentComponent，子组件渲染完把游标还回去。
      const outer = currentComponent
      currentComponent = node.type
      hooksFor(node.type).index = 0
      const produced = node.type({ ...node.props, children: node.children })
      currentComponent = outer
      return render(produced)
    }
    const attrs = Object.entries(node.props)
      .filter(([key]) => key !== 'children' && key.startsWith('aria-') || key === 'className' || key === 'title' || key === 'width' || key === 'height' || key === 'viewBox')
      .map(([key, value]) => ' ' + key + '="' + String(value) + '"')
      .join('')
    return '<' + node.type + attrs + '>' + render(flatten(node.children)) + '\n</' + node.type + '>'
  }
  throw new Error('unknown node: ' + String(node))
}

// 面板首帧：loading 中（doc 为 null）—— 这条路径最容易抛。
// 每次从干净状态起渲：槽位按组件实例分配，所以清空 store 就等于「首次挂载」。
hookStore.clear()
effects.length = 0
const rootFrame = render(createElement(panelMeta.component, {}))
const firstFrame = rootFrame
const panelHooks = hooksByName('UsagePanel')
const panelStateSlot = panelHooks.slots[2]
console.log('    panel state slot =', JSON.stringify(panelStateSlot)?.slice(0, 90))
const pendingEffects = effects.splice(0)
console.log('[7] first frame length =', firstFrame.length, 'has header =', firstFrame.includes('Token 用量统计'))

// 跑一遍 effect 拿数据，再渲第二帧。setState 之后要重渲，所以这里直接把
// hook 槽里的 loading/error/doc 摆成「已加载」，比模拟 setState 的批处理更直白。
await Promise.all(pendingEffects.map((fn) => fn()))
// 不清空槽位（否则会丢失 days/mode 等状态），只把 state 槽（索引 2）改成已加载。
panelHooks.slots[2] = { loading: false, error: null, doc: usageDoc }
// 模型排名区是面板里的独立子组件，它自己那一份槽位同样摆成已加载。
// 注意槽位编号按各组件自己的 hook 顺序：ModelRankSection 的 useState 是第 0 个
// （UsagePanel 的 state 在第 2 个，因为它前面还有 days 与 trendMode 两个 useState）。
const rankHooks = hooksByName('ModelRankSection')
if (rankHooks === undefined) throw new Error('ModelRankSection was never rendered')
rankHooks.slots[0] = { loading: false, error: null, doc: rankDoc }
effects.length = 0
const secondFrame = render(createElement(panelMeta.component, {}))
console.log('    state =', JSON.stringify({ loading: panelHooks.slots[2]?.loading, error: panelHooks.slots[2]?.error, hasDoc: panelHooks.slots[2]?.doc !== null }).slice(0, 120))
if (process.env.DUMP_FRAME) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.DUMP_FRAME, secondFrame)
}
for (const needle of ['累计消耗', '8.72亿', '调用次数', '缓存命中率', 'tku-chart-bar', 'tku-donut', 'tku-rank-fill', '按来源明细', '未知来源', 'workbuddy', '模型权威排名', '按任务类型推荐', '写代码']) {
  if (!secondFrame.includes(needle)) {
    console.log('FRAME >>>', secondFrame.slice(0, 3000))
    throw new Error('rendered panel is missing: ' + needle)
  }
}
console.log('[8] second frame length =', secondFrame.length, 'OK, all markers present')
console.log('[9] fetch calls =', JSON.stringify(calls))

// ---- 端点前缀：必须是本插件自己的前缀，不能打到签到插件那边去 ----
for (const call of calls) {
  if (!call.startsWith('/dsh-token-usage/')) {
    throw new Error('panel must only call its own prefix, got: ' + call)
  }
}

console.log('\nALL CLIENT SMOKE CHECKS PASSED')
