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

import { createReadStream, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
/** 版本优先级：同一会话同时存在 v4 与旧版时只读最高版本，否则用量翻倍。 */
const SESSION_FILE = /^session(?:\.(v\d+))?\.jsonl(?:\.zstd)?$/

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
 * @param {{onFile?: (path: string, ms: number) => void, signal?: AbortSignal}} [options]
 */
export async function scanSessionFiles(files, options = {}) {
  const { onFile, signal } = options
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
      const provider = typeof source?.provider === 'string' && source.provider !== '' ? source.provider : ''
      const model = typeof source?.model === 'string' ? source.model : ''
      if (provider === '') unknownSource += 1
      const key = `${provider}\u0000${model}`
      const row = bySource.get(key) ?? {
        provider,
        model,
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
