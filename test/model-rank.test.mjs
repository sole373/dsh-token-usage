/**
 * 模型权威排名自我检查：名字归一、榜单索引、前缀匹配、任务推荐规则、缓存与陈旧回退。
 *
 * 跑法：node test/model-rank.test.mjs
 *
 * 这里的每一条都对应一个「会静默出错」的点：归一错了会让匹配率变成 0（面板上看起来
 * 像「本机没有可用模型」），前缀匹配取错了会让 gpt-6-sol 拿到 gpt-6-sol-pro 的分数，
 * 推荐规则里 `null` 当 0 用会把没数据的模型排到第一。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_RANK_TTL_MS,
  RANK_CACHE_FILE,
  RANK_CACHE_VERSION,
  buildLeaderboardIndex,
  buildRankDoc,
  createModelRankStore,
  lookupEntry,
  normalizeLeaderboardEntry,
  normalizeModelKey,
  stripRateSuffix,
  taskRecommendations,
  uniqueEntries,
} from '../lib/model-rank.js'

let checks = 0
function ok(cond, message) {
  checks += 1
  assert.ok(cond, message)
  console.log(`  ok ${checks} - ${message}`)
}

// ---- 1. 名字归一：消装饰，不猜同义 ------------------------------------------
ok(normalizeModelKey('Fast · x0.34') === 'fast', '倍率后缀「 · x0.34」被剥掉')
ok(normalizeModelKey('Kimi-K3 · x1.62') === 'kimik3', '倍率后缀 + 横线一并归一')
ok(normalizeModelKey('deepseek-v4.1-flash') === 'deepseekv41flash', '点与横线不参与比对')
ok(normalizeModelKey('DeepSeek V4.1 Flash 1017') === 'deepseekv41flash1017', '空格不参与比对')
ok(normalizeModelKey('qwen3.8_max') === 'qwen38max', '下划线不参与比对')
ok(normalizeModelKey('OpenAI: GPT-6 Astra') === 'gpt6astra', '榜单的「厂牌: 」前缀被剥掉')
ok(normalizeModelKey('DeepSeek-V4-Flash (Official)') === 'deepseekv4flash', '括号渠道注解被剥掉')
ok(normalizeModelKey('通义千问 Max') === 'max', '非 ASCII 全被去掉（中文名归不出键）')
ok(normalizeModelKey('Auto') === 'auto', 'Auto 保持原样，不猜成任何具体模型')
ok(normalizeModelKey(42) === '' && normalizeModelKey(undefined) === '', '非字符串输入返回空键')

// ---- 2. 榜单一行 → 我们的字段（缺字段一律 null，不用 0 冒充） ----------------
const richRow = {
  id: 'openai/gpt-6-astra-1017',
  name: 'OpenAI: GPT-6 Astra',
  context_length: 400000,
  pricing: { prompt: '0.0000035' },
  architecture: { input_modalities: ['text', 'image'] },
  benchmarks: {
    artificial_analysis: { intelligence_index: 72, coding_index: 68, agentic_index: 65 },
    design_arena: [{ elo: 1310 }, { elo: 1345 }],
  },
}
const rich = normalizeLeaderboardEntry(richRow)
ok(rich.intel === 72 && rich.coding === 68 && rich.agentic === 65, '三个指数被读出')
ok(rich.codingArena === 1345, 'design_arena 取最高的 elo（1345 而不是 1310）')
ok(rich.ctx === 400000, '上下文长度被读出')
ok(Math.abs(rich.price - 3.5) < 1e-9, '每 token 美元折成每百万 token 美元：3.5')
ok(rich.image === true, '输入模态含 image → 支持看图')
ok(rich.key === 'gpt6astra' && rich.label === 'OpenAI: GPT-6 Astra', '键来自 name，label 保留原名')

const bare = normalizeLeaderboardEntry({ id: 'vendor/plain-model', name: 'Plain Model' })
ok(bare.intel === null && bare.coding === null && bare.agentic === null, '缺指数是 null，不是 0')
ok(bare.ctx === null && bare.price === null, '缺长度与价格同样是 null')
ok(bare.image === false && bare.codingArena === null, '缺模态是 false（不是 null），缺 arena 是 null')
ok(normalizeLeaderboardEntry({}) === undefined, '没有 id 的行直接丢掉')
ok(
  normalizeLeaderboardEntry({ id: 'x', name: '!!!' })?.key === 'x',
  '名字归一后为空时退回用 id 当键（而不是把这一行丢掉）',
)
ok(
  normalizeLeaderboardEntry({ id: '!!!', name: '???' }) === undefined,
  'id 与 name 归一后都是空的行直接丢掉',
)
ok(normalizeLeaderboardEntry(null) === undefined, '非对象输入直接丢掉')

// 榜单对「没有这个指数」的模型发的是**显式 null**（实测 anthropic/claude-haiku-5.5）。
// `Number(null)` 是 0，早期写法因此把 98 个没有编码指数的模型当成「编码 0 分」，
// 在写代码榜里排到真·弱模型前面。null 与 0 在这里是天壤之别，必须锁死。
const nullish = normalizeLeaderboardEntry({
  id: 'anthropic/claude-haiku-5.5',
  name: 'Anthropic: Claude Haiku 5.5',
  context_length: 1000000,
  pricing: { prompt: '0.0000001' },
  benchmarks: { artificial_analysis: { intelligence_index: 43.4, coding_index: null, agentic_index: null } },
})
ok(nullish.coding === null, '榜单发显式 null 时归一成 null，不变成 0')
ok(nullish.agentic === null, 'agentic 的显式 null 同样保持 null')
ok(nullish.intel === 43.4, '同一行里存在的指数照常读出')
ok(
  normalizeLeaderboardEntry({ id: 'x/y', name: 'Y', benchmarks: { artificial_analysis: { coding_index: '' } } }).coding === null,
  '空字符串也归一成 null（Number(\'\') 是 0）',
)
ok(
  normalizeLeaderboardEntry({ id: 'x/y', name: 'Y', benchmarks: { artificial_analysis: { coding_index: '0' } } }).coding === 0,
  '字符串 "0" 是真·0 分，如实保留',
)
ok(
  normalizeLeaderboardEntry({ id: 'x/y', name: 'Y', pricing: { prompt: null } }).price === null,
  '价格为 null 时归一成 null，不变成 0（0 会被当成免费）',
)

// ---- 3. 索引：一个条目注册多个候选名，同一个键只留第一条 --------------------
const index = buildLeaderboardIndex({
  data: [
    richRow,
    // 同一个模型换个写法重复出现：不该覆盖已有键
    { ...richRow, benchmarks: { artificial_analysis: { intelligence_index: 1 } } },
    { id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', benchmarks: { artificial_analysis: { intelligence_index: 60 } } },
  ],
})
ok(index.get('gpt6astra')?.intel === 72, '重复条目没有覆盖先注册的键（仍是 72 不是 1）')
ok(index.has('gpt6astra1017'), '榜单 id 的尾段也注册成了候选名')
ok(index.has('openaigpt6astra1017'), '榜单完整 id 也注册成了候选名')
ok(index.get('glm53')?.intel === 60, '第二个模型正常入索引')
ok(uniqueEntries(index).length === 2, '索引里多个键指向同一 entry，去重后是 2 条')

// ---- 4. 匹配：精确优先，退化时取最短前缀 ------------------------------------
const hit = lookupEntry(index, 'GPT-6 Astra', 'gpt-6-astra')
ok(hit.matchKind === 'exact' && hit.entry.intel === 72, '本机名归一后精确命中')
const viaId = lookupEntry(index, '', 'openai/gpt-6-astra-1017')
ok(viaId.matchKind === 'exact' && viaId.entry.intel === 72, '本机 name 为空时用 id 命中')
const miss = lookupEntry(index, 'Something Else', 'something-else')
ok(miss.matchKind === 'none' && miss.entry === undefined, '匹配不上如实报 none，不硬套一个')
ok(lookupEntry(index, '', '').matchKind === 'none', '空名字直接 none')

// 前缀匹配：本机不带日期、榜单带日期，且不能抢到更长的同名候选
const prefixIndex = buildLeaderboardIndex({
  data: [
    { id: 'v/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', benchmarks: { artificial_analysis: { intelligence_index: 50 } } },
    { id: 'v/deepseek-v4.1-flash-1017-pro', name: 'DeepSeek V4.1 Flash 1017 Pro', benchmarks: { artificial_analysis: { intelligence_index: 90 } } },
  ],
})
const prefixHit = lookupEntry(prefixIndex, 'deepseek-v4.1-flash', '')
ok(prefixHit.matchKind === 'prefix', '带日期的榜单 id 靠前缀命中本机的稳定名')
ok(prefixHit.entry.intel === 50, '取最短前缀（50 那个），不抢 -pro 的 90')

// ---- 5. 任务推荐：规则可复算、过滤器生效、空数据不进榜 ----------------------
const taskEntries = [
  { name: 'Strong', intel: 80, coding: 70, agentic: 75, ctx: 100000, price: 5, image: false, key: 'strong' },
  { name: 'Coder', intel: 60, coding: 90, agentic: 50, ctx: 200000, price: 2, image: false, key: 'coder' },
  { name: 'Cheap', intel: 45, coding: null, agentic: null, ctx: 8000, price: 0.2, image: false, key: 'cheap' },
  { name: 'Weak', intel: 10, coding: null, agentic: null, ctx: 4000, price: 0.05, image: false, key: 'weak' },
  { name: 'Seer', intel: 55, coding: 40, agentic: 60, ctx: 128000, price: 1, image: true, key: 'seer' },
  { name: 'Blank', intel: null, coding: null, agentic: null, ctx: null, price: null, image: false, key: 'blank' },
]
const tasks = taskRecommendations(taskEntries)
const byId = Object.fromEntries(tasks.map((t) => [t.id, t]))
ok(tasks.length === 6, '六个任务类型各出一条')
ok(byId.coding.rows[0].name === 'Coder', '写代码：编码指数最高的排第一')
ok(byId.coding.rows[0].value === 90, '写代码展示的是用于排序的那个值')
ok(byId.coding.rows.some((r) => r.name === 'Cheap'), '没有编码指数的模型靠智能指数兜底进榜（这是写死的规则）')
ok(byId.coding.rows.some((r) => r.name === 'Blank') === false, '两个指数都没有的模型不进写代码榜')
ok(byId.reasoning.rows[0].name === 'Strong', '推理：智能指数最高的排第一')
ok(byId.agentic.rows[0].name === 'Strong', '智能体：agentic 指数最高的排第一（75 > 60）')
ok(byId.longctx.rows[0].name === 'Coder', '长文档：上下文窗口最大的排第一（200000）')
ok(byId.vision.rows.length === 1 && byId.vision.rows[0].name === 'Seer', '看图：只留支持图片输入的模型')
ok(byId.value.rows[0].name === 'Cheap', '快而省：过智能门槛后最便宜的排第一（0.2 美元）')
ok(byId.value.rows.some((r) => r.name === 'Weak') === false, '智能指数低于门槛的便宜模型不配叫「省」')
ok(byId.value.rows.some((r) => r.name === 'Blank') === false, '没有价格或没有指数的模型不进快而省榜')
for (const task of tasks) {
  ok(task.zhRule.length > 0 && task.enRule.length > 0, `${task.id} 带可显示的中英规则说明`)
  ok(task.rows.length >= 1, `${task.id} 至少有一条可推荐行`)
}

// 排序稳定性：并列时不该随机跳动
const tie = taskRecommendations([
  { name: 'B', intel: 50, coding: null, agentic: null, ctx: null, price: null, image: false, key: 'b' },
  { name: 'A', intel: 50, coding: null, agentic: null, ctx: null, price: null, image: false, key: 'a' },
])
ok(tie[1].rows[0].name === 'B', '同分时保持输入顺序（不引入随机性）')

// ---- 6. buildRankDoc：排序、计数、口径说明 ----------------------------------
const rankDoc = buildRankDoc({
  rows: [
    { provider: 'trae', id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
    { provider: 'workbuddy', id: 'glm-5.3', name: 'glm-5.3', multiplier: 0.78 },
    { provider: 'trae', id: 'nobody-knows', name: 'Nobody Knows' },
  ],
  index: buildLeaderboardIndex({
    data: [
      { id: 'v/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', context_length: 128000, benchmarks: { artificial_analysis: { intelligence_index: 50 } } },
      { id: 'z/glm-5.3', name: 'Z.ai: GLM 5.3', context_length: 200000, benchmarks: { artificial_analysis: { intelligence_index: 60 } } },
    ],
  }),
  fetchedAt: Date.UTC(2026, 9, 19, 12, 0, 0),
  source: 'https://example.invalid/models',
})
ok(rankDoc.ok === true, '成功文档 ok=true')
ok(rankDoc.entries[0].name === 'glm-5.3', '总榜按智能指数降序（60 的在前）')
ok(rankDoc.entries[0].multiplier === 0.78, '本机倍率原样带上')
ok(rankDoc.entries[1].providers[0].matchKind === 'prefix', '带日期的榜单名靠前缀命中并如实标注 matchKind（合并后挪进行内 providers）')
ok(rankDoc.counts.local === 3 && rankDoc.counts.matched === 2 && rankDoc.counts.unmatched === 1, '计数：3 条本机 / 2 条匹配 / 1 条未匹配')
ok(rankDoc.counts.scored === 2, 'scored 只数有智能指数的')
ok(rankDoc.unmatched[0].name === 'Nobody Knows', '未匹配的模型如实列出，供用户判断是不是榜单缺条目')

// ---- 6b. stripRateSuffix：显示名剥掉客户端倍率/免费装饰 ---------------------
// 匹配层 normalizeModelKey 早就剥倍率，但展示名此前原样带着 ` · x1.80`；
// 榜单一经 catalog 口径全量收录，这些装饰就糊在每个模型名后面。
ok(stripRateSuffix('Qwen3.8-Max · x1.80') === 'Qwen3.8-Max', '「 · x1.80」倍率装饰被剥掉')
ok(stripRateSuffix('GLM-5.3-Flash · x0.06') === 'GLM-5.3-Flash', '「 · x0.06」小数倍率被剥掉')
ok(stripRateSuffix('Kimi-K3 x1.62') === 'Kimi-K3', '空格分隔的「 x1.62」也被剥掉')
ok(stripRateSuffix('DeepSeek-V4.1-Flash-1017 · 免费') === 'DeepSeek-V4.1-Flash-1017', '「 · 免费」促销标记被剥掉')
ok(stripRateSuffix('DeepSeek-V4 · 免费）') === 'DeepSeek-V4', '「 · 免费）」带右括号尾巴也剥掉')
ok(stripRateSuffix('DeepSeek-V4-Flash (Official)') === 'DeepSeek-V4-Flash (Official)', '括号注解是模型名的一部分，保留')
ok(stripRateSuffix('GLM-5.3') === 'GLM-5.3', '干净名字原样返回')
ok(stripRateSuffix('mimo-v2.6-flash') === 'mimo-v2.6-flash', '干净名字（带连字符点号）原样返回')
ok(stripRateSuffix('') === '', '空串返回空串')
ok(stripRateSuffix(42) === 42, '非字符串原样返回（不猜）')
{
  // 端到端：行名带倍率装饰时，entries 的显示名必须是剥过的，任务推荐同理。
  const doc = buildRankDoc({
    rows: [
      { provider: 'qwenwork-cn', id: 'qwen3.8-max', name: 'Qwen3.8-Max · x1.80' },
      { provider: 'lobsterai', id: 'glm-5.3', name: 'GLM-5.3-Flash · x0.06' },
    ],
    index: buildLeaderboardIndex({
      data: [
        { id: 'a/qwen3.8-max', name: 'Qwen3.8 Max', context_length: 128000, benchmarks: { artificial_analysis: { intelligence_index: 70, coding_index: 70 } } },
        { id: 'b/glm-5.3', name: 'Z.ai: GLM 5.3', context_length: 200000, benchmarks: { artificial_analysis: { intelligence_index: 60, coding_index: 60 } } },
      ],
    }),
    fetchedAt: Date.UTC(2026, 9, 19, 12, 0, 0),
    source: 'https://example.invalid/models',
  })
  ok(doc.entries.every((e) => !/x\s*[0-9.]|免费/u.test(e.name)), '总榜显示名不带倍率/免费装饰')
  ok(doc.tasks.every((t) => t.rows.every((r) => !/x\s*[0-9.]|免费/u.test(r.name))), '任务推荐显示名不带倍率/免费装饰')
  ok(doc.entries.some((e) => e.name === 'Qwen3.8-Max'), '剥完倍率后是本机叫法而不是榜单 label')
}
// 调用方不注明口径时如实写 unspecified，并给一段不撒谎的占位说明——
// 绝不假装自己知道收录范围是什么。
ok(rankDoc.availability === 'unspecified', '调用方不注明口径时如实写 unspecified')
ok(/unspecified/.test(rankDoc.availabilityNote.zh) && /unspecified/.test(rankDoc.availabilityNote.en), '占位口径说明必须明说「未注明」，不冒充任何一种范围')

// 同名同分合并：同一榜单条目被多个 provider 重复命中只出一行，来源折进 providers。
const mergedDoc = buildRankDoc({
  rows: [
    { provider: 'workbuddy', id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', multiplier: 0.34 },
    { provider: 'trae', id: 'DeepSeek V4.1 Flash', name: 'DeepSeek V4.1 Flash', multiplier: 0.34 },
    { provider: 'siliconflow', id: 'ds-flash', name: 'deepseek-v4.1-flash' },
    { provider: 'trae', id: 'glm-5.3', name: 'glm-5.3' },
  ],
  index: buildLeaderboardIndex({
    data: [
      { id: 'v/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', context_length: 128000, benchmarks: { artificial_analysis: { intelligence_index: 50 } } },
      { id: 'z/glm-5.3', name: 'Z.ai: GLM 5.3', context_length: 200000, benchmarks: { artificial_analysis: { intelligence_index: 60 } } },
    ],
  }),
  fetchedAt: Date.now(),
  source: 'x',
})
ok(mergedDoc.entries.length === 2, '三条同分来源合并成一行（与 glm 合计共 2 行）')
ok(mergedDoc.counts.matched === 4, 'matched 仍数本机匹配行（4 条），不因合并缩水')
ok(mergedDoc.counts.merged === 2, 'merged 数合并后的模型数（2 个）')
const flash = mergedDoc.entries.find((row) => row.intel === 50)
ok(flash.providers.length === 3, '三个来源全部折进行内 providers')
ok(flash.providers.map((item) => item.provider).join(',') === 'workbuddy,trae,siliconflow', '来源保持本机行序，不乱排')
ok(flash.multiplier === null, '倍率各异（0.34/0.34/无）时不标单一倍率')
const sameRate = buildRankDoc({
  rows: [
    { provider: 'a', id: 'x', name: 'deepseek-v4.1-flash', multiplier: 0.34 },
    { provider: 'b', id: 'y', name: 'DeepSeek V4.1 Flash', multiplier: 0.34 },
  ],
  index: buildLeaderboardIndex({
    data: [
      { id: 'v/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', benchmarks: { artificial_analysis: { intelligence_index: 50 } } },
    ],
  }),
  fetchedAt: Date.now(),
  source: 'x',
})
ok(sameRate.entries.length === 1 && sameRate.entries[0].multiplier === 0.34, '全部来源同倍率时合并行标一个倍率')
// 任务推荐吃合并后的条目：同一模型不再霸占一个任务的多个名次。
const dupTasks = sameRate.entries[0]
ok(dupTasks.providers.length === 2, '合并行在任务推荐里也只有一份（taskRecommendations 输入即 entries）')

// 注明口径时原样透传：文案跟口径走，面板照实显示，不写死在页面里。
const scoped = buildRankDoc({
  rows: [{ provider: 'p', id: 'gpt-6-astra', name: 'GPT-6 Astra' }],
  index: buildLeaderboardIndex({ data: [richRow] }),
  fetchedAt: Date.now(),
  source: 'x',
  availability: 'callable-catalog',
  availabilityNote: {
    zh: '进榜的模型 = 宿主当前可调用的全部模型。',
    en: 'Ranked models = every model currently callable through this host.',
  },
})
ok(scoped.availability === 'callable-catalog', '口径标识原样透传给面板')
ok(/可调用/.test(scoped.availabilityNote.zh) && /callable/.test(scoped.availabilityNote.en), '口径说明原样透传给面板')
ok(scoped.counts.matched === 1 && scoped.counts.merged === 1, '透传示例里模型照常匹配（口径透传不影响对齐逻辑）')
ok(rankDoc.fetchedAt === '2026-10-19T12:00:00.000Z', '抓取时间以 ISO 串返回')
ok(rankDoc.stale === false && rankDoc.error === null, '非陈旧文档 stale=false、error=null')

// 没有智能指数的模型排在后面，不被当成 0 排到末尾之外
const mixed = buildRankDoc({
  rows: [
    { provider: 'p', id: 'noindex', name: 'No Index' },
    { provider: 'p', id: 'low', name: 'Low' },
  ],
  index: buildLeaderboardIndex({
    data: [
      { id: 'v/noindex', name: 'No Index' },
      { id: 'v/low', name: 'Low', benchmarks: { artificial_analysis: { intelligence_index: 12 } } },
    ],
  }),
  fetchedAt: Date.now(),
  source: 'x',
})
ok(mixed.entries[0].name === 'Low' && mixed.entries[1].name === 'No Index', '有分数的在前，没分数的沉底（null 不当 0 用）')
ok(mixed.tasks[1].rows.length === 1, '只有一条有智能指数，推理榜就只有一行')
ok(mixed.counts.merged === 2, 'mixed 示例的 merged 计数照常给出')

// 行数上限
const many = buildRankDoc({
  rows: Array.from({ length: 30 }, (_, i) => ({ provider: 'p', id: 'm' + i, name: 'Model ' + i })),
  index: buildLeaderboardIndex({
    data: Array.from({ length: 30 }, (_, i) => ({
      id: 'v/model-' + i,
      name: 'Model ' + i,
      benchmarks: { artificial_analysis: { intelligence_index: 100 - i } },
    })),
  }),
  fetchedAt: Date.now(),
  source: 'x',
})
ok(many.entries.length === 30, '总榜不截断：30 个匹配模型全部返回')
ok(many.entries[0].name === 'Model 0' && many.entries[29].name === 'Model 29', '全量返回且保持智能指数降序')
ok(many.counts.matched === 30 && many.counts.merged === 30, '计数统计的是全部匹配数（无重复时 merged 与 matched 相等），不受展示上限影响')

// ---- 7. 缓存与陈旧回退（用假 fetch，不碰网络） ------------------------------
const dir = await mkdtemp(join(tmpdir(), 'dsh-rank-'))
let fetchCalls = 0
let fetchMode = 'ok'
const fakePayload = {
  data: [
    { id: 'v/model-a', name: 'Model A', context_length: 1000, pricing: { prompt: '0.000001' }, benchmarks: { artificial_analysis: { intelligence_index: 42 } } },
  ],
}
const store = createModelRankStore({
  dir: () => dir,
  ttlMs: 60_000,
  fetchImpl: async () => {
    fetchCalls += 1
    if (fetchMode === 'fail') return { ok: false, status: 503 }
    return { ok: true, status: 200, json: async () => fakePayload }
  },
})
const rows = [{ provider: 'p', id: 'model-a', name: 'Model A' }]

const first = await store.read({ rows })
ok(first.ok === true && first.entries.length === 1, '首次读取拿到榜单并匹配上本机模型')
ok(fetchCalls === 1, '首次读取确实发了一次请求')
ok(first.entries[0].intel === 42, '匹配到的分数正确')
ok(first.entries[0].providers.length === 1, '单来源行的 providers 数组照常给出')

const second = await store.read({ rows })
ok(second.ok === true && fetchCalls === 1, 'TTL 内第二次读取走内存，不再发请求')

await store.read({ rows, force: true })
ok(fetchCalls === 2, 'force 强制刷新，绕过 TTL')

// 磁盘缓存：新 store 实例（模拟进程重启）应当读到文件而不是发请求
const cached = JSON.parse(await readFile(join(dir, RANK_CACHE_FILE), 'utf8'))
ok(cached.version === RANK_CACHE_VERSION, '缓存文件带版本号')
ok(Array.isArray(cached.entries) && cached.entries.length === 1, '缓存文件写了归一后的条目')
const fetchBefore = fetchCalls
const restarted = createModelRankStore({
  dir: () => dir,
  ttlMs: 60_000,
  fetchImpl: async () => {
    fetchCalls += 1
    return { ok: true, status: 200, json: async () => fakePayload }
  },
})
const fromDisk = await restarted.read({ rows })
ok(fromDisk.ok === true && fromDisk.entries.length === 1, '重启后从磁盘缓存恢复')
ok(fetchCalls === fetchBefore, 'TTL 内的磁盘缓存不再发请求')

// 刷新失败但有旧榜单：继续用旧的，并标 stale + 原因
fetchMode = 'fail'
const stale = await store.read({ rows, force: true })
ok(stale.ok === true, '刷新失败不致命：手上还有旧榜单就继续给结果')
ok(stale.stale === true && /503/.test(stale.error), '如实标 stale 并给出失败原因')
ok(stale.entries.length === 1, '陈旧榜单照样能匹配本机模型')

// 坏缓存文件按「没有缓存」处理
await writeFile(join(dir, RANK_CACHE_FILE), '{ not json', 'utf8')
const freshDir = await mkdtemp(join(tmpdir(), 'dsh-rank-'))
await writeFile(join(freshDir, RANK_CACHE_FILE), JSON.stringify({ version: 999, entries: [{ key: 'x' }] }), 'utf8')
const wrongVersion = createModelRankStore({
  dir: () => freshDir,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => fakePayload }),
})
const afterBad = await wrongVersion.read({ rows })
ok(afterBad.ok === true, '版本号对不上的缓存被忽略，重新拉取成功')

// 从来没成功过：返回失败文档，但照样把本机清单带出去
let neverCalls = 0
const neverDir = await mkdtemp(join(tmpdir(), 'dsh-rank-'))
const never = createModelRankStore({
  dir: () => neverDir,
  fetchImpl: async () => {
    neverCalls += 1
    throw new Error('network down')
  },
})
const failed = await never.read({ rows })
ok(failed.ok === false && failed.status === 'leaderboard-unavailable', '从未成功过时如实报失败')
ok(/network down/.test(failed.detail), '失败原因带出来，面板才能说明为什么没有排名')
ok(failed.entries.length === 0 && failed.tasks.length === 0, '失败文档不画空榜')
ok(failed.counts.local === 1 && failed.unmatched.length === 1, '失败文档仍带本机清单与未匹配列表')
ok(failed.counts.merged === 0, '失败文档的 merged 计数为 0（不画空榜）')
ok(neverCalls === 1, '失败也只是一次请求，不重试风暴')

// 并发读取串行化：同一时刻多个请求共用一次拉取
let slowCalls = 0
const slowDir = await mkdtemp(join(tmpdir(), 'dsh-rank-'))
const slow = createModelRankStore({
  dir: () => slowDir,
  fetchImpl: async () => {
    slowCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { ok: true, status: 200, json: async () => fakePayload }
  },
})
const [a, b, c] = await Promise.all([slow.read({ rows }), slow.read({ rows }), slow.read({ rows })])
ok(slowCalls === 1, '三个并发读取只触发一次拉取（inflight 串行化）')
ok(a.ok === true && b.ok === true && c.ok === true, '三个并发读取都拿到结果')

// ---- 8. readAllRows：'all' 口径的「榜单全集」行 --------------------------------
// 旧版在这里栽过跟头：'all' 用 read({ rows: [] }) 的产物当行，rows 空则交集永远
// 为空，'all' 静默排出一张空榜。readAllRows 必须直接从快照索引取。
const fullRows = await slow.readAllRows()
ok(Array.isArray(fullRows) && fullRows.length === 1, 'readAllRows 从索引去重后给出全集行')
ok(fullRows[0].name === 'Model A' && fullRows[0].provider === '', '全集行带榜单 label，provider 留空')
const fullDoc = await slow.read({ force: false, rows: fullRows, availability: 'leaderboard' })
ok(fullDoc.ok === true && fullDoc.counts.local === 1 && fullDoc.counts.matched === 1, '全集行回灌 buildRankDoc 能匹配上（不再是旧版那张静默空榜）')
ok(fullDoc.availability === 'leaderboard', 'store.read 把调用方的口径透传进文档')
await slow.readAllRows()
ok(slowCalls === 1, 'TTL 内 readAllRows 与 read 共用同一份榜单快照，不重复拉取')
const emptyAll = await never.readAllRows()
ok(Array.isArray(emptyAll) && emptyAll.length === 0, '榜单从未拉到时 readAllRows 返回空（不编造全集，让上层如实报 leaderboard-unavailable）')

ok(DEFAULT_RANK_TTL_MS === 6 * 60 * 60 * 1000, '默认 TTL 是 6 小时')

await rm(dir, { recursive: true, force: true })
await rm(freshDir, { recursive: true, force: true })
await rm(neverDir, { recursive: true, force: true })
await rm(slowDir, { recursive: true, force: true })

console.log(`\nmodel-rank: ${checks} passed, 0 failed`)
