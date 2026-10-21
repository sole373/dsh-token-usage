/**
 * 用量快照：扫描 + 缓存 + 增量。供 Web 路由、命令与客户端面板共用。
 *
 * 缓存策略（不做持久化数据库的理由）：全量扫描 43 个日志 / 48MB 实测约 1.4 秒，
 * 而日志只增不减。所以（1）内存里留最近一次快照；（2）记下每个文件的 `size+mtime`，
 * 只重扫变化的文件，未变化的文件直接复用上次的行级聚合结果。
 *
 * 这比引入 SQLite 诚实：没有原生依赖、没有 schema 迁移、没有一半写坏的中间态；
 * 进程重启后第一次扫描 1.4 秒，用户感知不到。
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { listSessionLogs, scanSessionFiles, sourceLabel } from './usage-scan.js'

/** 默认快照缓存时长：面板手动刷新时强制重扫，自动轮询走缓存。 */
const DEFAULT_TTL_MS = 30_000
/** 单次扫描的硬上限，防止日志暴涨时把请求拖死。 */
const DEFAULT_BUDGET_MS = 20_000

/**
 * @param {object} options
 * @param {string} [options.sessionsRoot] 会话根目录，默认 `$DSH_HOME/sessions`
 * @param {number} [options.ttlMs]
 * @param {number} [options.budgetMs]
 */
export function createUsageStore(options = {}) {
  const sessionsRoot =
    options.sessionsRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS

  /** @type {Map<string, {stamp: string, result: Awaited<ReturnType<typeof scanSessionFiles>>}>} */
  const fileCache = new Map()
  let snapshot = undefined
  let snapshotAt = 0
  /** 串行化：并发刷新共用同一次扫描，避免 N 个面板同时扫盘。 */
  let inflight = undefined

  async function build(force) {
    if (!force && snapshot !== undefined && Date.now() - snapshotAt < ttlMs) return snapshot
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      const started = Date.now()
      const files = await listSessionLogs(sessionsRoot)
      const fresh = []
      let reused = 0
      let totalBytes = 0
      for (const file of files) {
        let info
        try {
          info = await stat(file)
        } catch {
          continue
        }
        totalBytes += info.size
        const stamp = `${info.size}:${info.mtimeMs}`
        const cached = fileCache.get(file)
        if (cached !== undefined && cached.stamp === stamp) reused += 1
        else fresh.push({ path: file, stamp })
      }
      // 被删掉的会话不再占缓存。必须在下面的合并之前做：合并只遍历 `files`，
      // 但 stamp 更新与 merge 若依赖了残留键，删文件后合计会与明细对不上。
      const live = new Set(files)
      for (const key of fileCache.keys()) if (!live.has(key)) fileCache.delete(key)

      const partial = new Map()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), budgetMs)
      try {
        for (const item of fresh) {
          if (controller.signal.aborted) break
          const result = await scanSessionFiles([item.path], { signal: controller.signal })
          fileCache.set(item.path, { stamp: item.stamp, result })
          partial.set(item.path, result)
        }
      } finally {
        clearTimeout(timer)
      }

      // 汇总：命中缓存的旧文件 + 本次重扫的新文件。
      const merged = {
        bySource: new Map(),
        byDay: new Map(),
        selected: new Map(),
        messages: 0,
        unknownSource: 0,
        files: files.length,
        reusedFiles: reused,
        scannedFiles: fresh.length,
        bytes: totalBytes,
        partial: controller.signal.aborted,
      }
      const addInto = (target, key, delta) => target.set(key, (target.get(key) ?? 0) + delta)
      for (const file of files) {
        const entry = fileCache.get(file)
        if (entry === undefined) continue
        const { result } = entry
        merged.messages += result.messages
        merged.unknownSource += result.unknownSource
        for (const [key, row] of result.bySource) {
          const acc = merged.bySource.get(key)
          if (acc === undefined) {
            merged.bySource.set(key, { ...row })
          } else {
            acc.input += row.input
            acc.output += row.output
            acc.cacheRead += row.cacheRead
            acc.cacheWrite += row.cacheWrite
            acc.total += row.total
            acc.calls += row.calls
          }
        }
        for (const [day, row] of result.byDay) {
          let dayRow = merged.byDay.get(day)
          if (dayRow === undefined) {
            dayRow = new Map()
            merged.byDay.set(day, dayRow)
          }
          for (const [key, value] of Object.entries(row)) addInto(dayRow, key, value)
        }
        for (const [key, row] of result.selected) {
          const acc = merged.selected.get(key)
          if (acc === undefined) merged.selected.set(key, { ...row })
          else acc.msgs += row.msgs
        }
      }
      merged.elapsedMs = Date.now() - started
      snapshot = merged
      snapshotAt = Date.now()
      return merged
    })()
    try {
      return await inflight
    } finally {
      inflight = undefined
    }
  }

  /**
   * 生成给客户端用的 JSON 文档。
   *
   * @param {{force?: boolean, days?: number, now?: number}} [options]
   */
  async function read(options = {}) {
    const merged = await build(options.force === true)
    const now = options.now ?? Date.now()
    const windowDays = Math.max(1, Math.min(3650, options.days ?? 30))
    const dayKeys = daySeries(now, windowDays)

    const sources = [...merged.bySource.values()]
      .map((row) => ({
        provider: row.provider,
        model: row.model,
        label: sourceLabel(row.provider, row.model),
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        total: row.total,
        calls: row.calls,
      }))
      .sort((a, b) => b.total - a.total)

    // 按 provider 再聚合一层：用户关心「哪个 agent 花得多」，模型只是明细。
    const byProvider = new Map()
    for (const row of sources) {
      const acc = byProvider.get(row.provider) ?? {
        provider: row.provider,
        label: row.provider === '' ? '未知来源' : row.provider,
        total: 0,
        calls: 0,
        models: 0,
      }
      acc.total += row.total
      acc.calls += row.calls
      acc.models += 1
      byProvider.set(row.provider, acc)
    }

    const series = dayKeys.map((day) => {
      const row = merged.byDay.get(day)
      let total = 0
      const perSource = {}
      if (row !== undefined) {
        for (const [key, value] of row) {
          total += value
          perSource[key] = value
        }
      }
      return { day, total, perSource }
    })

    // 全量累计直接由 `bySource` 求和，不遍历 `byDay`：两者是同一次扫描的两份投影，
    // 但 byDay 的键是「天」，一旦某天没有记录就不会出现在 map 里，用 min 键推导
    // 起点在旧数据上很脆弱（实测就出现过 firstDay 拿到同一天、累加却为 0 的情况）。
    const allDays = [...merged.byDay.keys()].sort()
    const firstDay = allDays[0]
    const cumulative = sources.reduce((sum, row) => sum + row.total, 0)

    // 四段汇总：缓存命中率要用「计费输入」当分母，而分母是 input + cacheRead +
    // cacheWrite（不含 output——output 是生成结果，不是喂进去的上下文）。这里只
    // 做加法，不动上面已有的 `all/today/week/calls/...`，面板的老断言继续成立。
    const segments = sources.reduce(
      (acc, row) => {
        acc.input += row.input
        acc.output += row.output
        acc.cacheRead += row.cacheRead
        acc.cacheWrite += row.cacheWrite
        return acc
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    )

    const todayKey = localDayOf(now)
    const today = merged.byDay.get(todayKey)
    const todayTotal = today === undefined ? 0 : [...today.values()].reduce((a, b) => a + b, 0)
    const weekKeys = daySeries(now, 7)
    let weekTotal = 0
    for (const day of weekKeys) {
      const row = merged.byDay.get(day)
      if (row !== undefined) weekTotal += [...row.values()].reduce((a, b) => a + b, 0)
    }

    return {
      generatedAt: new Date(now).toISOString(),
      windowDays,
      sessionsRoot,
      scan: {
        files: merged.files,
        scannedFiles: merged.scannedFiles,
        reusedFiles: merged.reusedFiles,
        messages: merged.messages,
        unknownSource: merged.unknownSource,
        bytes: merged.bytes,
        elapsedMs: merged.elapsedMs,
        partial: merged.partial,
      },
      totals: {
        all: cumulative,
        today: todayTotal,
        week: weekTotal,
        calls: sources.reduce((sum, row) => sum + row.calls, 0),
        sources: sources.length,
        providers: byProvider.size,
        firstDay: firstDay ?? null,
        todayDay: todayKey,
        // 四段明细 + 缓存三指标（全时段口径，与 `all` 同基准）。
        // `cacheHitRate` 在分母为 0 时是 `null` 而不是 0 —— 「读不到」与「真的是
        // 0%」不是一回事，面板据此显示「—」。
        segments,
        cacheHit: segments.cacheRead,
        cacheMiss: segments.input + segments.cacheWrite,
        cacheHitRate: segments.input + segments.cacheRead + segments.cacheWrite > 0
          ? segments.cacheRead / (segments.input + segments.cacheRead + segments.cacheWrite)
          : null,
      },
      sources,
      providers: [...byProvider.values()].sort((a, b) => b.total - a.total),
      series,
    }
  }

  /** 当前选中模型的来源（来自最新的 `model/selection`），供输入框徽标使用。 */
  async function currentSelection() {
    const merged = await build(false)
    let best = undefined
    for (const row of merged.selected.values()) if (best === undefined || row.msgs > best.msgs) best = row
    return best
  }

  return { read, currentSelection, sessionsRoot }
}

function localDayOf(ms) {
  const d = new Date(ms)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 从 `now` 往前数 `count` 天的日期键，含今天，升序。 */
function daySeries(now, count) {
  const out = []
  const base = new Date(now)
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i)
    out.push(localDayOf(d.getTime()))
  }
  return out
}
