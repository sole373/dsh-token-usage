/**
 * 模型权威排名：把「本次收录的模型」与公开榜单对齐。
 *
 * 为什么不用本机目录里的字段自己排：本机目录只透出 id / name / 倍率 / 是否支持
 * 图片，**没有任何能力分数**；按名字猜强弱就是编。所以能力维度一律取公开榜单
 * （OpenRouter 的 `/api/v1/models`，免鉴权，内含 Artificial Analysis 的
 * intelligence / coding / agentic 指数，以及上下文长度、价格、输入模态）。
 *
 * 收录范围（rankScope）由调用方决定，本模块不猜口径只做对齐：
 *   - `catalog`：宿主当前可调用的全部模型（枚举见 llm-catalog.js）；
 *   - `used`：本机会话日志里真实出现过的模型；
 *   - `all`：公开榜单全集。
 * 对不上榜单的模型进 unmatched，绝不硬造分数。
 *
 * 同一榜单条目（名称一样、分数一样）被多个 provider 重复命中时合并成一行：
 * 分数本来就来自同一条榜单条目，重复展示只会让同一个模型霸占多个名次；
 * 来源（providers 数组）合并展示在「可用平台」列里。分数不同的条目绝不互相合并。

 *
 * 收录口径标识与说明（availability / availabilityNote）随文档透传给面板照实
 * 显示——不假装「进榜」等于「你有权用」，也不把某一种口径写死在文案里。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const LEADERBOARD_URL = 'https://openrouter.ai/api/v1/models'
export const RANK_CACHE_FILE = 'model-rank.json'
export const RANK_CACHE_VERSION = 1

/** 榜单刷新 TTL：6 小时。榜单以天为单位变，刷太勤只是白费网络。 */
export const DEFAULT_RANK_TTL_MS = 6 * 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 20_000

/** 「快而省」的质量门槛：智能指数低于它的便宜模型不配叫「省」，只是弱。 */
const VALUE_INTEL_FLOOR = 40

/** 每个任务推荐展示多少行；总榜自 v1.3.0 起不截断（有分数的模型全部返回，面板表格滚动）。 */
const TASK_LIMIT = 5

/**
 * 数值归一：读不出就是 `null`，**绝不用 0 冒充**。
 *
 * 榜单对「没有这个指数」的模型发的是显式 `null`（实测 `anthropic/claude-haiku-5.5`
 * 的 `coding_index` 就是 null），而 `Number(null)` 是 `0`、`Number('')` 也是 `0`。
 * 早期写法直接 `Number(value)`，于是 98 个没有编码指数的模型被当成「编码 0 分」，
 * 在写代码榜里排到了真·弱模型前面——null 与 0 在这里是天壤之别。
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 把任一种模型写法折成同一个比对键。
 *
 * 需要消掉的差异（都是实测见过的）：
 *   - 本机目录把倍率拼在名字里：`Fast · x0.34`、`Kimi-K3 · x1.62`
 *   - 榜单带厂牌前缀：`OpenAI: GPT-6 Astra`、`Z.ai: GLM 5.3`
 *   - 大小写、空格、点、横线、下划线全不一致：`deepseek-v4.1-flash` vs
 *     `DeepSeek V4.1 Flash 1017`、`qwen3.8_max` vs `Qwen3.8-Max`
 *   - 括号里的渠道注解：`DeepSeek-V4-Flash (Official)`
 *
 * 归一化只做「去掉装饰」，不猜同义（`Auto` 不会变成任何具体模型）。
 */
export function normalizeModelKey(value) {
  if (typeof value !== 'string') return ''
  let text = value.toLowerCase()
  // 本机目录的倍率后缀：` · x1.33` 或结尾的 ` x1.33`
  text = text.replace(/\s*[·|]\s*x\s*[0-9.]+\s*$/u, '')
  text = text.replace(/\s+x\s*[0-9.]+\s*$/u, '')
  // 括号注解（含半角与全角括号）
  text = text.replace(/\s*\([^)]*\)\s*/gu, ' ')
  text = text.replace(/\s*（[^）]*）\s*/gu, ' ')
  // 榜单的 `厂牌: ` 前缀
  text = text.replace(/^[a-z0-9._-]+\s*:\s*/u, '')
  // 只留字母数字
  text = text.replace(/[^a-z0-9]/gu, '')
  return text
}

/** 只剥掉模型名尾部的客户端装饰（` · x1.33`、` x1.33`、` · 免费`、` · 免费）` 等），
 * 其余字符不动、不改大小写。用于「显示模型名称」的场景：榜单条目本身不带倍率，
 * 但本机目录/可调用目录里的名字可能拼了倍率或促销标记，展示时必须去掉，免得
 * 模型名里夹着价格信息。括号注解（`(Official)`）保留——那是模型名的一部分。 */
export function stripRateSuffix(value) {
  if (typeof value !== 'string') return value
  let text = value
  // 循环剥：`DeepSeek-V4 · 免费）` 可能同时带右括号尾巴与倍率，一次 replace 剥不掉两层。
  for (let i = 0; i < 4; i += 1) {
    const before = text
    text = text.replace(/\s*[·|]\s*x\s*[0-9.]+\s*$/u, '').trim()
    text = text.replace(/\s+x\s*[0-9.]+\s*$/u, '').trim()
    text = text.replace(/\s*[·|]\s*(免费|free)\s*[）)]*\s*$/u, '').trim()
    if (text === before) break
  }
  return text
}

/** 价格：`pricing.prompt` 是「每 token 美元」的字符串，折成「每百万 token 美元」。 */
function pricePerMillion(value) {
  const parsed = numberOrNull(value)
  if (parsed === null || parsed < 0) return null
  return parsed * 1e6
}

/** 榜单一行 → 我们只留需要的字段。字段缺失一律 `null`，不用 0 冒充。 */
export function normalizeLeaderboardEntry(row) {
  if (typeof row !== 'object' || row === null) return undefined
  const id = typeof row.id === 'string' ? row.id : ''
  if (id === '') return undefined

  const aa = row.benchmarks?.artificial_analysis
  const arena = Array.isArray(row.benchmarks?.design_arena) ? row.benchmarks.design_arena : []
  const codingArena = arena.reduce((best, item) => {
    const elo = numberOrNull(item?.elo)
    return elo !== null && elo > best ? elo : best
  }, 0)
  const modalities = Array.isArray(row.architecture?.input_modalities) ? row.architecture.input_modalities : []

  const key = normalizeModelKey(row.name) || normalizeModelKey(id)
  if (key === '') return undefined

  return {
    key,
    label: typeof row.name === 'string' && row.name !== '' ? row.name : id,
    intel: numberOrNull(aa?.intelligence_index),
    coding: numberOrNull(aa?.coding_index),
    agentic: numberOrNull(aa?.agentic_index),
    codingArena: codingArena > 0 ? codingArena : null,
    ctx: numberOrNull(row.context_length),
    price: pricePerMillion(row.pricing?.prompt),
    image: modalities.includes('image'),
  }
}

/**
 * 榜单文档 → `归一化键 → 条目` 的索引。
 *
 * 一个条目会以多个候选名注册（榜单 `name`、榜单 `id`、`id` 去掉厂牌后的尾段），
 * 谁先注册谁赢——同一个键只留第一条，避免同一模型被两份写法互相覆盖。
 */
export function buildLeaderboardIndex(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const index = new Map()
  for (const row of rows) {
    const entry = normalizeLeaderboardEntry(row)
    if (entry === undefined) continue
    const tail = typeof row?.id === 'string' ? row.id.split('/').pop() : ''
    for (const candidate of [row?.name, row?.id, tail]) {
      const key = normalizeModelKey(candidate)
      if (key !== '' && !index.has(key)) index.set(key, entry)
    }
  }
  return index
}

/** 索引里的去重条目（同一个 entry 可能注册在多个键上）。 */
export function uniqueEntries(index) {
  const seen = new Set()
  const out = []
  for (const entry of index.values()) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    out.push(entry)
  }
  return out
}

/**
 * 本机一行 → 榜单条目。
 *
 * 先精确命中。没命中才退化成「唯一前缀」：榜单会把快照日期拼进 id
 * （`deepseek-v4.1-flash-1017`），而本机目录用不带日期的稳定名
 * （`deepseek-v4.1-flash`）。前缀命中取**最短**的那个键，免得
 * `gpt-6-sol` 抢到 `gpt-6-sol-pro` 的分数。
 */
export function lookupEntry(index, name, id) {
  const key = normalizeModelKey(name) || normalizeModelKey(id)
  if (key === '') return { entry: undefined, matchKind: 'none', key: '' }

  const exact = index.get(key)
  if (exact !== undefined) return { entry: exact, matchKind: 'exact', key }

  let bestKey
  for (const candidate of index.keys()) {
    if (!candidate.startsWith(key)) continue
    if (bestKey === undefined || candidate.length < bestKey.length) bestKey = candidate
  }
  if (bestKey === undefined) return { entry: undefined, matchKind: 'none', key }
  return { entry: index.get(bestKey), matchKind: 'prefix', key }
}

/**
 * 任务类型 → 推荐规则。
 *
 * 每条规则都必须是**可解释、可复算**的一句话：面板上原样显示，用户看到某个模型
 * 排第一时能自己验证为什么。规则里不许出现「综合评估」这类不可复算的说法。
 */
const TASK_SPECS = [
  {
    id: 'coding',
    zhLabel: '写代码',
    enLabel: 'Coding',
    zhRule: '按编码指数降序；没有编码指数的用智能指数兜底',
    enRule: 'by coding index, falling back to intelligence index',
    metric: 'index',
    select: (entry) => entry.coding ?? entry.intel,
  },
  {
    id: 'reasoning',
    zhLabel: '推理与数学',
    enLabel: 'Reasoning & math',
    zhRule: '按智能指数降序',
    enRule: 'by intelligence index, descending',
    metric: 'index',
    select: (entry) => entry.intel,
  },
  {
    id: 'agentic',
    zhLabel: '智能体与工具调用',
    enLabel: 'Agentic & tool use',
    zhRule: '按 agentic 指数降序；没有 agentic 指数的用智能指数兜底',
    enRule: 'by agentic index, falling back to intelligence index',
    metric: 'index',
    select: (entry) => entry.agentic ?? entry.intel,
  },
  {
    id: 'longctx',
    zhLabel: '长文档',
    enLabel: 'Long context',
    zhRule: '按上下文窗口降序',
    enRule: 'by context window, descending',
    metric: 'tokens',
    select: (entry) => entry.ctx,
  },
  {
    id: 'vision',
    zhLabel: '多模态（看图）',
    enLabel: 'Vision',
    zhRule: '只取支持图片输入的模型，按智能指数降序',
    enRule: 'image-capable models only, by intelligence index',
    metric: 'index',
    select: (entry) => entry.intel,
    filter: (entry) => entry.image === true,
  },
  {
    id: 'value',
    zhLabel: '快而省',
    enLabel: 'Best value',
    zhRule: `只取智能指数 ≥ ${VALUE_INTEL_FLOOR} 的模型，按每百万输入 token 价格升序`,
    enRule: `intelligence index ≥ ${VALUE_INTEL_FLOOR} only, cheapest input price first`,
    metric: 'usd',
    select: (entry) => entry.price,
    filter: (entry) => entry.price !== null && entry.intel !== null && entry.intel >= VALUE_INTEL_FLOOR,
    ascending: true,
  },
]

/** 给每个任务类型挑前几名。没有可算的值的模型直接不进这个任务的榜。 */
export function taskRecommendations(entries) {
  return TASK_SPECS.map((spec) => {
    const pool = entries.filter((entry) => (spec.filter === undefined ? true : spec.filter(entry)))
    const scored = []
    for (const entry of pool) {
      const value = spec.select(entry)
      if (value === null || value === undefined || !Number.isFinite(value)) continue
      scored.push({ entry, value })
    }
    scored.sort((a, b) => (spec.ascending === true ? a.value - b.value : b.value - a.value))
    return {
      id: spec.id,
      zhLabel: spec.zhLabel,
      enLabel: spec.enLabel,
      zhRule: spec.zhRule,
      enRule: spec.enRule,
      metric: spec.metric,
      // 任务推荐不再截前 5：每个任务列出所有有该指标可排的模型，前端卡片内部滚动。
      rows: scored.map((item) => ({ ...item.entry, value: item.value })),
    }
  })
}

/**
 * 组装面板要的排名文档。
 *
 * @param {object} input
 * @param {Array<{provider: string, id: string, name: string, multiplier?: number}>} input.rows
 *   本次收录的模型清单（由调用方按 rankScope 口径给出：可调用目录 / 实测日志 /
 *   榜单全集）。
 * @param {Map<string, object>} input.index 榜单索引
 * @param {number} input.fetchedAt 榜单抓取时间（ms）
 * @param {string} input.source 榜单地址
 * @param {boolean} [input.stale] 本次是「刷新失败、用了旧榜单」
 * @param {string|null} [input.error] 刷新失败原因
 * @param {string} [input.availability] 收录口径标识（callable-catalog / local-usage /
 *   leaderboard）；调用方不注明时如实写 unspecified。
 * @param {{zh: string, en: string}} [input.availabilityNote] 收录口径的中英说明，
 *   面板原样显示；不注明时给一段不撒谎的占位说明。
 */
export function buildRankDoc(input) {
  const { rows, index, fetchedAt, source, stale, error } = input
  const availability =
    typeof input.availability === 'string' && input.availability !== ''
      ? input.availability
      : 'unspecified'
  const availabilityNote =
    input.availabilityNote !== null && typeof input.availabilityNote === 'object'
      ? input.availabilityNote
      : {
          zh: '本文档未注明收录口径（unspecified）；能力分数取自公开榜单。',
          en: 'This document does not state its scope (unspecified); capability scores come from a public leaderboard.',
        }
  // 同一榜单条目（key 相同 → 名称一样、分数一样）只出一行；本机的重复命中
  // （同一模型在多个 provider 下都可用）折进该行的 providers 数组。分数不同
  // 的条目 key 必不同，天然不会互相合并——合并的唯一依据就是同一条榜单条目。
  const byKey = new Map()
  const unmatched = []
  let matchedRows = 0

  for (const row of rows) {
    const { entry, matchKind } = lookupEntry(index, row.name, row.id)
    if (entry === undefined) {
      unmatched.push({ provider: row.provider, id: row.id, name: row.name })
      continue
    }
    matchedRows += 1
    const multipliers = new Set()
    let rateless = false
    const origin = {
      provider: row.provider,
      id: row.id,
      matchKind,
    }
    if (typeof row.multiplier === 'number' && Number.isFinite(row.multiplier)) {
      origin.multiplier = row.multiplier
      multipliers.add(row.multiplier)
    } else {
      rateless = true
    }
    const existing = byKey.get(entry.key)
    if (existing === undefined) {
      byKey.set(entry.key, {
        key: entry.key,
        // 行名取本机叫法而不是榜单 label：用户认得自己勾的那串名字。
        // 客户端目录有时把倍率拼进名字（`Qwen3.8-Max · x1.80`），显示时必须剥掉，
        // 免得模型名里夹着价格倍率。
        name: stripRateSuffix(row.name),
        label: entry.label,
        intel: entry.intel,
        coding: entry.coding,
        agentic: entry.agentic,
        codingArena: entry.codingArena,
        ctx: entry.ctx,
        price: entry.price,
        image: entry.image,
        providers: [origin],
        // 该行是否所有来源都带同一个倍率：是则在名称后面标一个倍率，倍率各异则不标。
        multipliers,
        rateless,
      })
    } else {
      existing.providers.push(origin)
      if (origin.multiplier !== undefined) existing.multipliers.add(origin.multiplier)
      if (rateless) existing.rateless = true
    }
  }

  const entries = [...byKey.values()]
  // 给旧字段兜底：行名退回榜单 label（label 来自榜单，本身不带倍率装饰）。
  // multipliers/rateless 只是构建期的临时状态，算完就删；entry.multiplier 保留在
  // 数据里（调用方可能要用），但面板一律不显示倍率。
  for (const entry of entries) {
    if (entry.name === '' || entry.name === undefined) entry.name = entry.label
    entry.multiplier =
      entry.rateless !== true && entry.multipliers.size === 1 ? [...entry.multipliers][0] : null
    delete entry.multipliers
    delete entry.rateless
  }

  // 总榜按智能指数降序；没有智能指数的排后面（`null` 不当 0 用），同分按名字稳定排序。
  entries.sort((a, b) => {
    const left = a.intel === null ? -1 : a.intel
    const right = b.intel === null ? -1 : b.intel
    if (right !== left) return right - left
    return String(a.name).localeCompare(String(b.name))
  })

  // 任务推荐基于合并后的条目：同一模型不再重复霸占一个任务的多个名次。
  const tasks = taskRecommendations(entries)

  return {
    ok: true,
    fetchedAt: new Date(fetchedAt).toISOString(),
    source,
    stale: stale === true,
    error: error ?? null,
    // 收录口径写进文档、面板照实显示——口径由调用方注入，不假装排名等于订阅权益。
    availability,
    availabilityNote,
    counts: {
      local: rows.length,
      // matched 数的是「本机行」，entries 数的是「合并后的模型数」：两条曲线都保留，
      // 面板的「本机清单 X · 匹配 Y」与总榜行数才能各自对上账。
      matched: matchedRows,
      merged: entries.length,
      unmatched: unmatched.length,
      scored: entries.filter((entry) => entry.intel !== null).length,
    },
    unmatched: unmatched.slice(0, 40),
    // 总榜不再截断：catalog 口径下有分数的模型可能有几十个，全量返回、面板表格滚动展示；
    // 排序保证有分的在前（见上方 sort），所以即便调用方想自己截断，前缀也是稳定的高分序。
    entries,
    tasks,
  }
}

/**
 * 把当前榜单索引挂到用量文档上，让「本机实际用过的模型」也能带上能力分数。
 *
 * 为什么用**全量榜单**索引、而不是 `buildRankDoc` 那份本机清单文档：用量是过去时，
 * 记的是「我调用过什么」。某个模型今天从「平台与模型」里取消勾选，过去烧掉的 token
 * 并不会因此消失；只用清单过滤会把历史用量整段抹掉，排行榜就和趋势图对不上账。
 * 所以这里只做「名字能不能对上榜单」这一件事。
 *
 * 匹配方式与 `buildRankDoc` 同名模型完全一致（先精确、再唯一最长前缀），免得同一次
 * 会话里出现「榜单页认得出、能力排行认不出」这种自相矛盾。
 *
 * 注意 `usageStore` 的模型名来自会话日志的 `provider / model`，那边的 `model` 可能
 * 带日期快照后缀，前缀匹配正是为它准备的。
 */
export function attachUsageRanking(doc, index, options = {}) {
  if (doc === null || typeof doc !== 'object') return doc
  const getIndex = typeof options.getIndex === 'function' ? options.getIndex : () => index
  const sources = Array.isArray(doc.sources) ? doc.sources : []
  const enabled = options.enabled !== false

  /** 单个模型的榜单条目；榜单不可用或没对上就是 `null`（面板显示「—」，不显示 0）。 */
  const lookup = (row) => {
    if (!enabled) return null
    const current = getIndex()
    if (!(current instanceof Map)) return null
    const { entry } = lookupEntry(current, row.model, row.label)
    return entry === undefined ? null : entry
  }

  const scores = {}
  for (const row of sources) {
    const entry = lookup(row)
    if (entry !== null) scores[row.provider + '\u0000' + row.model] = entry
  }

  // 「模型能力排行」= 按能力分数降序的本机实测模型榜。
  //
  // 三个坑必须在这里一次说清：
  //   1) 同一模型可能在多个客户端里都能用（本机清单里就有两份），用量日志只知道
  //      它当时走的是哪个 provider。所以这里按 provider + 模型去重，不去猜「这两个
  //      是不是同一个模型」——把两家的 deepseek-v4.1-flash 强行合并，总额就不再是
  //      任何一份账单上的数。
  //   2) 没有榜单条目的模型（排行里那些 GLM、mimo）分数是 null，不能当 0 排到最后
  //      再假装它们是「最弱的」，所以单独成组、显示「无榜单分数」。
  //   3) 同一分数里按用量降序：分数打平时，用得多的那个才该在前面——这是用户真正
  //      关心的信息（我到底在用哪几个）。
  const ranked = sources.map((row) => {
    const entry = scores[row.provider + '\u0000' + row.model] ?? null
    return {
      provider: row.provider,
      model: row.model,
      label: typeof row.label === 'string' ? row.label : row.model,
      total: row.total,
      calls: row.calls,
      share: doc.totals?.all > 0 ? row.total / doc.totals.all : null,
      intel: entry === null ? null : numberOrNull(entry.intel),
      coding: entry === null ? null : numberOrNull(entry.coding),
      agentic: entry === null ? null : numberOrNull(entry.agentic),
      ctx: entry === null ? null : numberOrNull(entry.ctx),
      price: entry === null ? null : numberOrNull(entry.price),
      image: entry === null ? null : entry.image === true,
      matchKind: entry === null ? 'none' : 'entry',
    }
  })
  ranked.sort((a, b) => {
    const left = a.intel === null ? -1 : a.intel
    const right = b.intel === null ? -1 : b.intel
    if (right !== left) return right - left
    if (b.total !== a.total) return b.total - a.total
    return String(a.label).localeCompare(String(b.label))
  })

  // 任务维度推荐：**只在本机实测用过的模型里**挑。这是与下方「模型权威排名」分明的
  // 一点——那边回答「我收录的模型里哪个最适合干什么」，这边回答「我实际用过的里面，
  // 哪个最适合写代码」。规则与榜单页共用 `TASK_SPECS`，所以两处口径不会飘。
  const tasks = taskRecommendations(ranked).map((task) => ({
    ...task,
    rows: task.rows.map((row) => ({ ...row, total: row.total, calls: row.calls, share: row.share })),
  }))

  return {
    ...doc,
    ranking: {
      enabled,
      available: indexedSize(getIndex()),
      scored: ranked.filter((row) => row.intel !== null).length,
      rows: ranked,
      tasks,
      note: {
        zh: '只统计本机会话日志里真实出现过的模型（含已从勾选里移除的历史调用），能力分数取自公开榜单；没有对上榜单的模型显示「—」，不按 0 分排。',
        en: 'Only models that actually appear in local session logs are ranked (including past calls of models since deselected); scores come from the public leaderboard. Unmatched models show "—" rather than being scored as 0.',
      },
    },
  }
}

/** 榜单索引里有多少个可用条目；拿不到索引就是 0。 */
function indexedSize(index) {
  if (!(index instanceof Map)) return 0
  const seen = new Set()
  for (const entry of index.values()) seen.add(entry.key)
  return seen.size
}

/**
 * 榜单缓存 + 拉取。与用量扫描器同一套路：内存快照 + 磁盘兜底 + `inflight` 串行化。
 *
 * 刷新失败**不是**致命错误：手上有旧榜单就继续用它，并在文档里标 `stale` 与原因。
 * 只有「从来没成功过」才返回失败文档——那种情况下面板必须说明为什么没有排名，
 * 而不是画一张空表让人以为本机没有可用模型。
 */
export function createModelRankStore(options = {}) {
  const { dir, ttlMs = DEFAULT_RANK_TTL_MS, fetchImpl, logger } = options
  let memory = null
  let inflight = null
  let lastError = null

  const cachePath = () => join(dir(), RANK_CACHE_FILE)

  async function readCache() {
    try {
      const text = await readFile(cachePath(), 'utf8')
      const parsed = JSON.parse(text)
      if (parsed?.version !== RANK_CACHE_VERSION) return null
      if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return null
      const fetchedAt = numberOrNull(parsed.fetchedAt)
      if (fetchedAt === null) return null
      return { entries: parsed.entries, fetchedAt, source: typeof parsed.source === 'string' ? parsed.source : LEADERBOARD_URL }
    } catch {
      // 文件不存在是正常态（首次运行）；坏文件同样按「没有缓存」处理，下次成功刷新会重写。
      return null
    }
  }

  async function writeCache(snapshot) {
    try {
      await mkdir(dirname(cachePath()), { recursive: true })
      const body = JSON.stringify({
        version: RANK_CACHE_VERSION,
        fetchedAt: snapshot.fetchedAt,
        source: snapshot.source,
        entries: snapshot.entries,
      })
      await writeFile(cachePath(), body, 'utf8')
    } catch (error) {
      // 缓存写不进去只影响下次冷启动的速度，不影响本次结果。
      logger?.warn?.(`模型榜单缓存写入失败：${String(error?.message ?? error)}`)
    }
  }

  async function fetchLeaderboard() {
    const doFetch = fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await doFetch(LEADERBOARD_URL, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response?.ok) throw new Error(`榜单返回 HTTP ${response?.status ?? '?'}`)
      const payload = await response.json()
      const entries = uniqueEntries(buildLeaderboardIndex(payload))
      if (entries.length === 0) throw new Error('榜单解析结果为空')
      return { entries, fetchedAt: Date.now(), source: LEADERBOARD_URL }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 保证手上有一份尽可能新的榜单。返回 `{snapshot, stale, error}`。 */
  async function ensure(force) {
    const now = Date.now()
    if (!force && memory !== null && now - memory.fetchedAt < ttlMs) {
      return { snapshot: memory, stale: false, error: null }
    }
    if (memory === null) {
      const disk = await readCache()
      if (disk !== null) {
        memory = disk
        if (!force && now - disk.fetchedAt < ttlMs) return { snapshot: disk, stale: false, error: null }
      }
    }
    try {
      const fresh = await fetchLeaderboard()
      memory = fresh
      lastError = null
      await writeCache(fresh)
      return { snapshot: fresh, stale: false, error: null }
    } catch (error) {
      const detail = String(error?.message ?? error)
      lastError = detail
      if (memory !== null) return { snapshot: memory, stale: true, error: detail }
      return { snapshot: null, stale: false, error: detail }
    }
  }

  /**
   * 只读地取当前榜单索引，**绝不触发网络**。
   *
   * 用量面板要在每次刷新时给每个模型配能力分数，如果那里顺手拉起一次网络请求，
   * 一次「刷新」就会同时打穿两张网；而榜单本来有自己的 6 小时 TTL 与刷新按钮。
   * 这里只回内存里已有的索引——没有就回 `null`，面板把分数显示成「—」。
   * 那个「—」是诚实的：榜还没拉回来，不等于这些模型没分数。
   */
  function peek() {
    if (memory === null) return null
    const index = new Map()
    for (const entry of memory.entries) if (!index.has(entry.key)) index.set(entry.key, entry)
    return index
  }

  /**
   * @param {{force?: boolean, rows?: Array<object>, availability?: string, availabilityNote?: object}} [options]
   */
  async function read(options = {}) {
    const rows = Array.isArray(options.rows) ? options.rows : []
    if (inflight === null) {
      inflight = ensure(options.force === true).finally(() => {
        inflight = null
      })
    }
    const { snapshot, stale, error } = await inflight

    if (snapshot === null) {
      return {
        ok: false,
        status: 'leaderboard-unavailable',
        detail: error ?? lastError,
        fetchedAt: null,
        source: LEADERBOARD_URL,
        availability:
          typeof options.availability === 'string' && options.availability !== ''
            ? options.availability
            : 'unspecified',
        availabilityNote:
          options.availabilityNote ?? {
            zh: '榜单拉不回来时没有排名口径可言；先解决榜单获取，再谈收录范围。',
            en: 'No scope applies while the leaderboard cannot be fetched; fix leaderboard access first.',
          },
        counts: { local: rows.length, matched: 0, merged: 0, unmatched: rows.length, scored: 0 },
        entries: [],
        tasks: [],
        unmatched: rows.slice(0, 40),
      }
    }

    const index = new Map()
    for (const entry of snapshot.entries) {
      if (!index.has(entry.key)) index.set(entry.key, entry)
    }
    return buildRankDoc({
      rows,
      index,
      fetchedAt: snapshot.fetchedAt,
      source: snapshot.source,
      stale,
      error,
      availability: options.availability,
      availabilityNote: options.availabilityNote,
    })
  }

  /**
   * 「公开榜单全集」行（`rankScope: 'all'` 用）：先确保榜单在手（force 绕过 TTL），
   * 再从快照索引去重取全部条目折成行。
   *
   * 不能用 `read({ rows: [] })` 的产物凑：`buildRankDoc` 的行来自 rows×index 的
   * 交集，rows 为空则结果永远为空——全集必须直接从索引取。旧版在这里栽过跟头：
   * 'all' 口径传了空 rows，静默排出一张空榜。
   */
  async function readAllRows(force = false) {
    if (inflight === null) {
      inflight = ensure(force === true).finally(() => {
        inflight = null
      })
    }
    const { snapshot } = await inflight
    if (snapshot === null) return []
    const index = new Map()
    for (const entry of snapshot.entries) {
      if (!index.has(entry.key)) index.set(entry.key, entry)
    }
    return uniqueEntries(index).map((entry) => ({
      provider: '',
      id: entry.label,
      name: entry.label,
    }))
  }

  return { read, readAllRows, peek }
}
