/**
 * 会话用量扫描：把 DSH 会话日志聚合成「按来源（provider/model）× 时间」的 token 用量。
 *
 * 为什么读日志而不是问宿主：DSH 的 token 计量服务（`dsh-token-meter`）给的是**当前会话
 * 表层**的请求压力快照，不保留历史；而「消耗趋势 / 模型排行 / 累计消耗」需要跨会话、
 * 跨 workspace 的历史。日志是唯一同时具备「全量」「持久」「带来源」三点的数据源。
 *
 * 数据形状（2026-10 实测，58887 条记录 / 43 个会话 / 7 个 workspace）：
 *
 *   { type: 'assistant/message', time: <epoch ms>,
 *     data: { usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens },
 *             message: { source: { kind: 'model', provider, model } } } }
 *
 * 三个必须守住的坑：
 *
 * 1. **多帧 zstd**。一个 `session.v4.jsonl.zstd` 是 12829 个独立帧首尾相接，
 *    `zstdDecompressSync` 只解第一帧，直接调会静默丢掉 99% 内容。必须逐帧切分。
 * 2. **`totalTokens` 不含缓存**。它恒等于 `inputTokens + outputTokens +
 *    cacheReadTokens + cacheWriteTokens`（用 8129 条记录核对，7952 条精确吻合，
 *    余下 177 条是旧版本记录的 `cacheWriteTokens` 缺失），而真正的「计费输入」
 *    是 `input + cacheRead + cacheWrite`。页面显示的 token 总量一律按四段求和，
 *    不读 `totalTokens`——不能指望那个字段一直是新的。
 * 3. **`assistant/attempt` 的用量是重复的**。它的 usage 只出现在
 *    `data.stream[].chunk.usage` 里，且与最终 `data.usage` 是同一份；两条都数会翻倍。
 *    因此只认 `assistant/message`。
 */

import { createReadStream, readFileSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
/** 版本优先级：同一会话同时存在 v4 与旧版时只读最高版本，否则用量翻倍。 */
const SESSION_FILE = /^session(?:\.(v\d+))?\.jsonl(?:\.zstd)?$/

/**
 * magpie 路由日志的对账窗口。
 *
 * DSH 的 `assistant/message` 是**消息落盘**时才写的，比 magpie 那边
 * `usage.jsonl` 记的路由完成时间晚；实测延迟中位数约 9 秒，最长 174 秒
 * （长流式调用）。所以窗口是不对称的：往前 5 分钟，往后只留 10 秒。
 */
const ROUTE_LOG_BEFORE_MS = 300_000
const ROUTE_LOG_AFTER_MS = 10_000

/** 路由日志里 `route_id` 行才是一次真实路由；`provider_test` 之类没有它。 */
const ROUTE_LOG_LINE = '"route_id"'

/** 路由 id：`group/...`、`auto/...`，或裸 `group`/`auto`。 */
const ROUTE_ID = /^(group|auto)(?:\/|$)/u

/** 逐帧切分多帧 zstd 流，返回 `[start, end)` 边界。 */
export function frameBounds(buf) {
  const out = []
  let off = 0
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) break
    const start = off
    let p = off + 4
    const descriptor = buf[p]
    p += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const hasChecksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) p += 1
    if (dictFlag === 3) p += 4
    else if (dictFlag === 1) p += 1
    else if (dictFlag === 2) p += 2
    p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    for (;;) {
      if (p + 3 > buf.length) return out
      const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
      p += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >> 3
      p += type === 1 ? 1 : size
      if (last) break
    }
    if (hasChecksum) p += 4
    out.push([start, Math.min(p, buf.length)])
    off = p
  }
  return out
}

/** 解一整个（可能多帧的）zstd 缓冲。 */
export function decompressAll(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    const bounds = frameBounds(buf)
    if (bounds.length > 1) {
      const parts = []
      for (const [start, end] of bounds) {
        try {
          parts.push(zstdDecompressSync(buf.subarray(start, end)))
        } catch {
          // 单帧损坏（写入中被读到）不该让整份历史消失，跳过这一帧继续。
        }
      }
      if (parts.length > 0) return Buffer.concat(parts)
    }
    // 只识别出 1 帧，但文件可能其实是多帧（帧头异常/写入中被读到）。
    // 此时不能直接用 Node 的 `zstdDecompressSync`——它只解第一帧，会**静默丢掉**
    // 后面所有帧的内容。所以改成：按「单帧」解一次，并检查解出来的内容是否
    // 用尽了整个缓冲；没用尽就说明后面还有帧，逐字节往后试解。
    const decoded = tryDecodeSingle(buf)
    if (decoded === null) return buf
    if (decoded.consumed >= buf.length) return decoded.data
    return decodeTrailingFrames(buf, decoded)
  }
  // 未压缩的 `.jsonl`（宿主也支持这种格式）：原样返回，不要试图解压。
  return buf
}

/**
 * 把一个缓冲当作**单帧** zstd 解压，并报告实际消耗的字节数。
 *
 * Node 的 `zstdDecompressSync` 不报告消耗量，所以这里先算出单帧的边界
 * （`frameBounds` 已经会返回第一帧的 `[start, end)`），再按该边界解压，
 * 从而知道「解完这一帧后还剩多少字节没处理」。
 *
 * @param {Buffer} buf
 * @returns {{data: Buffer, consumed: number} | null} 解不出来时返回 null。
 */
function tryDecodeSingle(buf) {
  const bounds = frameBounds(buf)
  const first = bounds[0]
  if (first === undefined) return null
  try {
    return { data: zstdDecompressSync(buf.subarray(first[0], first[1])), consumed: first[1] }
  } catch {
    return null
  }
}

/**
 * 第一帧之后还有残留字节时的兜底：逐个偏移尝试找到下一帧的起点并解压。
 *
 * 这条路径只在「帧头被写坏」时才会走到（本机 80 个日志全部帧数正常，从未触发），
 * 它的价值是：**宁可少解一点，也绝不静默假装解完了**。
 *
 * @param {Buffer} buf
 * @param {{data: Buffer, consumed: number}} first
 * @returns {Buffer}
 */
function decodeTrailingFrames(buf, first) {
  const parts = [first.data]
  let off = first.consumed
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) {
      // 不是帧头：把剩余字节当作原文附上（多半是尾部元数据），不丢内容。
      parts.push(buf.subarray(off))
      break
    }
    const rest = buf.subarray(off)
    const bounds = frameBounds(rest)
    const next = bounds[0]
    if (next === undefined) {
      parts.push(rest)
      break
    }
    try {
      parts.push(zstdDecompressSync(rest.subarray(next[0], next[1])))
      off += next[1]
    } catch {
      // 这帧坏了：跳过它继续找下一帧，避免整份历史消失。
      off += next[1]
    }
  }
  return Buffer.concat(parts)
}

/**
 * magpie 自己的路由日志路径（`~/.config/magpie/usage.jsonl`）。
 *
 * 环境变量 `MAGPIE_USAGE_LOG` 可覆盖（测试/换机时用）；空值视同未设置。
 */
export function resolveMagpieRouteLogPath() {
  const fromEnv = process.env.MAGPIE_USAGE_LOG
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.config', 'magpie', 'usage.jsonl')
}

/** 上一次读入的路由日志索引（按 path + size + mtime 失效）。 */
let routeLogCache = null

/**
 * 读入并索引 magpie 路由日志。
 *
 * 为什么需要它：DSH 会话日志里的 `replayState.response.responseModel` 并非每条
 * magpie 调用都有（命名路由组 `group/group-4`、部分 `auto/*` 就没有），此时只
 * 剩下路由 id，模型维度就统计不到具体模型。magpie 自己那份日志逐行记了
 * `req`（请求的路由 id）与 `served`（真正应答的模型名）以及 in/out token 数。
 *
 * 对账键是 **req + input + output + 时间窗**，靠 token 精确相等来定案：同一个
 * 模型在 5 分钟里跑两次且输入输出 token 完全一致的概率极低，实测用 4935 条
 * 「已有 responseModel」的记录反过来校验，4929 条（99.9%）与 served 一致。
 *
 * 日志是 append-only 的，所以按 size+mtime 缓存；文件不存在或读不出时返回
 * null，调用方退回原行为（保留路由 id），绝不编造模型名。
 *
 * @param {string | null | undefined} logPath
 * @returns {{byReq: Map<string, {t: number, served: string, inn: number, out: number}[]>} | null}
 */
function loadRouteIndex(logPath) {
  if (typeof logPath !== 'string' || logPath === '') return null
  let info
  try {
    info = statSync(logPath)
  } catch {
    return null
  }
  const stamp = `${info.size}:${info.mtimeMs}`
  if (routeLogCache !== null && routeLogCache.path === logPath && routeLogCache.stamp === stamp) {
    return routeLogCache.index
  }
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return null
  }
  const byReq = new Map()
  for (const line of text.split('\n')) {
    if (!line.includes(ROUTE_LOG_LINE)) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const t = Date.parse(typeof row?.t === 'string' ? row.t : '')
    if (!Number.isFinite(t)) continue
    const req = typeof row.req === 'string' ? row.req : ''
    if (req === '') continue
    // `served` 是真正应答的模型；老格式没这个字段时退回 `model`。
    const served = typeof row.served === 'string' && row.served !== ''
      ? row.served
      : typeof row.model === 'string' ? row.model : ''
    if (served === '') continue
    const inn = Number(row.in) || 0
    const out = Number(row.out) || 0
    const item = { t, served, inn, out }
    const bucket = byReq.get(req)
    if (bucket === undefined) byReq.set(req, [item])
    else bucket.push(item)
  }
  for (const bucket of byReq.values()) bucket.sort((a, b) => a.t - b.t)
  const index = { byReq }
  routeLogCache = { path: logPath, stamp, index }
  return index
}

/**
 * 在路由日志里给一条 DSH 记录找回真正应答的模型。
 *
 * @param {{byReq: Map<string, {t: number, served: string, inn: number, out: number}[]>} | null} index
 * @param {string[]} reqs 候选 req：原始 model id，必要时加 responseModel 里的路由 id、
 *   以及 magpie 内部的 `group/auto-*` 形态
 * @param {number} timeMs DSH 记录时间（epoch ms）
 * @param {number} inn 输入 token（含缺失时的 0）
 * @param {number} out 输出 token
 * @returns {string | null} 命中的 served 模型，未命中返回 null
 */
function resolveServedModel(index, reqs, timeMs, inn, out) {
  if (index === null) return null
  let best = null
  const from = timeMs - ROUTE_LOG_BEFORE_MS
  const to = timeMs + ROUTE_LOG_AFTER_MS
  for (const req of reqs) {
    const bucket = index.byReq.get(req)
    if (bucket === undefined) continue
    let lo = 0
    let hi = bucket.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (bucket[mid].t < from) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < bucket.length && bucket[i].t <= to; i += 1) {
      const cand = bucket[i]
      // token 必须逐位相等（包括 0）：差一个数字就不是同一次调用。
      if (cand.inn !== inn || cand.out !== out) continue
      const dt = Math.abs(cand.t - timeMs)
      if (best === null || dt < best.dt) best = { dt, served: cand.served }
    }
  }
  return best === null ? null : best.served
}

/**
 * 把 usage 归一成四段计数。缺字段按 0，不读 totalTokens。
 *
 * 字段值可以是数字，也可以是**数字字符串**。宿主目前写的是数字，但日志是
 * JSON，`"100"` 与 `100` 在语义上都是「一百个 token」。早期写法用
 * `Number.isFinite(value)` 直接过滤，字符串会被判为「不是数字」而**静默
 * 归零**——宿主哪天改用字符串序列化，这条路就会变成无声的漏计。
 */
function usageOf(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const n = (key) => {
    const value = raw[key]
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed === '') return 0
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    }
    return 0
  }
  const usage = {
    input: n('inputTokens'),
    output: n('outputTokens'),
    cacheRead: n('cacheReadTokens'),
    cacheWrite: n('cacheWriteTokens'),
  }
  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  return usage.total > 0 ? usage : undefined
}

/** 本地日期键 `YYYY-MM-DD`（与宿主看板口径一致：按本机时区切天，不按 UTC）。 */
export function localDayKey(ms) {
  const d = new Date(ms)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 递归找出所有会话日志；同目录多版本时只保留最高版本。 */
export async function listSessionLogs(root) {
  const found = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        const match = SESSION_FILE.exec(entry.name)
        if (match) found.push({ path: full, version: Number((match[1] ?? 'v1').slice(1)) || 1 })
      }
    }
  }
  await walk(root)
  // 同一父目录下若 v4 与 v3 并存，只留 v4。
  const byDir = new Map()
  for (const item of found) {
    const dir = join(item.path, '..')
    const prev = byDir.get(dir)
    if (prev === undefined || item.version > prev.version) byDir.set(dir, item)
  }
  return [...byDir.values()].map((item) => item.path)
}

/**
 * 扫描一批会话日志，返回按 (provider, model) 与 (day, provider, model) 的聚合。
 *
 * @param {string[]} files 日志绝对路径
 * @param {{onFile?: (path: string, ms: number) => void, signal?: AbortSignal,
 *   routeLogPath?: string | null}} [options]
 *   `routeLogPath`：magpie 路由日志路径。缺省按 `resolveMagpieRouteLogPath()` 取；
 *   传 `null` 显式关闭对账（测试要可复现时用）。
 */
export async function scanSessionFiles(files, options = {}) {
  const { onFile, signal } = options
  const routeIndex = loadRouteIndex(
    options.routeLogPath === undefined ? resolveMagpieRouteLogPath() : options.routeLogPath,
  )
  /** @type {Map<string, {provider: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number, total: number, calls: number}>} */
  const bySource = new Map()
  /** @type {Map<string, Record<string, number>>} day -> sourceKey -> total */
  const byDay = new Map()
  /** @type {Map<string, {provider: string, model: string, msgs: number}>} */
  const selected = new Map()
  let messages = 0
  let unknownSource = 0

  for (const file of files) {
    if (signal?.aborted) break
    const started = Date.now()
    let raw
    try {
      raw = await readFile(file)
    } catch {
      continue
    }
    let text
    try {
      text = decompressAll(raw).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      // 便宜的预筛：绝大多数行是 tool/result 与 step 事件，先按关键字跳过。
      if (!line.includes('assistant/message') && !line.includes('model/selection')) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.type === 'model/selection') {
        const provider = record.data?.provider
        const model = record.data?.model
        if (typeof provider === 'string' && provider !== '') {
          const key = `${provider}\u0000${model ?? ''}`
          const row = selected.get(key) ?? { provider, model: model ?? '', msgs: 0 }
          row.msgs += 1
          selected.set(key, row)
        }
        continue
      }
      const usage = usageOf(record.data?.usage)
      if (usage === undefined) continue
      if (!Number.isFinite(record.time)) continue // 无时间戳的记录无法归日，丢弃好过塞进「今天」
      messages += 1
      const source = record.data?.message?.source
      let provider = typeof source?.provider === 'string' && source.provider !== '' ? source.provider : ''
      let model = typeof source?.model === 'string' ? source.model : ''
      /** group 行所属的命名路由组 id（`group/cheap-first` 等），auto 行为 ''。 */
      let groupName = ''
      if (provider === 'magpie') {
        // magpie 是本地路由器：日志里 provider 恒为 `magpie`，真实来源在 model id
        // 的第一段（`qoder/qfmodel`、`group/cheap-first`、`auto/glm-5.3`……）。
        // 全链路（来源分布环形图 / 明细表 / 趋势图 / 来源计数）要按真实来源拆开，
        // 与排名页 llm-catalog.js 的 `magpie-<partner>` 口径保持一致。
        const slash = model.indexOf('/')
        const partner = slash > 0 ? model.slice(0, slash) : ''
        if (partner === 'group' || partner === 'auto') {
          provider = 'magpie-' + partner
          // group/auto 行进一步拆到「真正应答的模型」：日志里
          // `replayState.response.responseModel` 是 magpie 路由后的真实模型名
          // （如 `group/cheap-first` 实际应答 `deepseek-v4.1-flash`）。
          // 大小写归一：`minimax-m3.1-flash` 与 `MiniMax-M3.1-Flash` 是同一模型
          // 的两种大小写，归一成小写聚合，避免裂成两行。
          //
          // 有些记录没有这个字段（`group/group-4`、部分 `auto/*`），或者字段本身
          // 还是路由 id（`group/auto-hy4free`）——那就拿 magpie 自己那份路由日志
          // 按 req + in/out token + 时间窗对账，解出 served 模型；两边都对不上时
          // 保留原始 model id，绝不编一个。
          const rm = source?.replayState?.response?.responseModel
          const rmText = typeof rm === 'string' ? rm.trim() : ''
          if (rmText !== '' && !ROUTE_ID.test(rmText)) {
            groupName = model // 保留原始 group/auto id 作附带字段
            model = rmText.toLowerCase()
          } else {
            const reqs = [model]
            if (rmText !== '' && ROUTE_ID.test(rmText)) reqs.push(rmText)
            // magpie 内部把按模型的自动路由记成 `group/auto-*`，两种形态都试。
            if (model.startsWith('auto/')) reqs.push('group/' + model)
            const served = resolveServedModel(routeIndex, reqs, record.time, usage.input, usage.output)
            if (served !== null) {
              groupName = model
              model = served.toLowerCase()
            }
          }
        } else if (partner !== '' && partner !== 'magpie' && /^[a-z0-9][a-z0-9._-]*$/u.test(partner)) {
          provider = 'magpie-' + partner
        }
      }
      if (provider === '') unknownSource += 1
      const key = `${provider}\u0000${model}`
      const row = bySource.get(key) ?? {
        provider,
        model,
        groupName,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        calls: 0,
      }
      row.input += usage.input
      row.output += usage.output
      row.cacheRead += usage.cacheRead
      row.cacheWrite += usage.cacheWrite
      row.total += usage.total
      row.calls += 1
      bySource.set(key, row)

      const day = localDayKey(record.time)
      let dayRow = byDay.get(day)
      if (dayRow === undefined) {
        dayRow = {}
        byDay.set(day, dayRow)
      }
      dayRow[key] = (dayRow[key] ?? 0) + usage.total
    }
    onFile?.(file, Date.now() - started)
  }

  return { bySource, byDay, selected, messages, unknownSource }
}

/** 供展示用的来源标签：provider 已知但模型为空时补 `-`，provider 为空时标成「未知来源」。 */
export function sourceLabel(provider, model) {
  if (provider === '') return '未知来源'
  return model === '' ? provider : `${provider} / ${model}`
}
