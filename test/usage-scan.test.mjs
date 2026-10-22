/**
 * 用量自我检查：用本机所有真实会话日志验证「多帧解压 + 求和口径 + 增量缓存」三件事。
 *
 * 跑法：node test/usage-scan.test.mjs
 * 这不是单元测试框架，是一条会打脸的断言脚本——本仓库的其余测试也是这个风格。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { decompressAll, frameBounds, localDayKey, scanSessionFiles } from '../lib/usage-scan.js'
import { createUsageStore } from '../lib/usage-store.js'

let checks = 0
function ok(cond, message) {
  checks += 1
  assert.ok(cond, message)
  console.log(`  ok ${checks} - ${message}`)
}

// ---- 1. 帧切分：拿本机第一份真实日志做真值比对 -------------------------------
const { homeDirForTest } = { homeDirForTest: process.env.USERPROFILE }
const { readdir } = await import('node:fs/promises')

/**
 * 找出**第一个含计费记录**的真实会话日志。
 *
 * 为什么要遍历而不是取第一个匹配文件：本机 `~/.dsh/sessions` 下混着两类日志——
 * 正常会话（带 `assistant/message`）和**空会话种子**（只有 session / permission/preset /
 * sandbox/mode / approval/policy 等元事件，没有任何 assistant/message）。
 * 只按 readdir 枚举顺序取第一个文件，等于赌它不是空种子——本机实测 82 份候选里
 * 有 12 份是空种子，命中就必然误报失败。这是环境依赖型脆弱测试，不是插件 bug。
 * 所以这里逐个解压，只认真正含 `assistant/message` 的那份。
 */
async function firstLog() {
  const root = join(homeDirForTest, '.dsh', 'sessions')
  let dirs
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined // 本机没有会话目录：交给调用方走 skip 分支
  }
  let scanned = 0
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const sub = join(root, d.name)
    let subs
    try {
      subs = await readdir(sub, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of subs) {
      if (!s.isDirectory()) continue
      let files
      try {
        files = await readdir(join(sub, s.name))
      } catch {
        continue
      }
      for (const f of files) {
        if (!/^session(\.\w+)?\.jsonl\.zstd$/.test(f)) continue
        const path = join(sub, s.name, f)
        scanned += 1
        let text
        try {
          const buf = await (await import('node:fs/promises')).readFile(path)
          text = decompressAll(buf).toString('utf8')
        } catch {
          continue // 正在写入或已损坏的文件直接跳过，不影响找下一个
        }
        // 空种子只有元事件，没有 assistant/message —— 跳过，继续找下一份。
        if (!text.includes('"assistant/message"')) continue
        return path
      }
    }
  }
  if (scanned > 0) {
    throw new Error(
      `本机没有含 assistant/message 的会话日志：${scanned} 份候选日志全是空会话种子` +
        '（只有 session / permission/preset / sandbox/mode / approval/policy 等元事件）',
    )
  }
  return undefined
}

const sample = await firstLog()
if (sample !== undefined) {
  const buf = await (await import('node:fs/promises')).readFile(sample)
  const bounds = frameBounds(buf)
  ok(bounds.length > 1, `多帧识别：${bounds.length} 帧`)
  ok(bounds[bounds.length - 1][1] === buf.length, '帧切分恰好覆盖整个文件，无残留字节')
  const text = decompressAll(buf).toString('utf8')
  ok(text.includes('"assistant/message"'), '解压后包含 assistant/message')
  const lines = text.split('\n').filter(Boolean)
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })
  ok(parsed.every((r) => r !== undefined), `全部 ${lines.length} 行都是合法 JSON`)
} else {
  console.log('  skip - 本机没有会话日志，跳过真实样本检查')
}

// ---- 1b. 合成多帧固件：不依赖本机日志，多帧解压永远可验证 --------------------
//
// 核心坑是「Node 的 zstdDecompressSync 只解第一帧」。这个断言必须能在没有本机
// 日志的干净环境里跑，所以用 node:zlib 造两段内容、分别压缩、首尾相接拼成
// 一个 buffer，模拟真实会话日志的多帧结构。
{
  const partA = '{"type":"assistant/message","tag":"frame-A"}\n'
  const partB = '{"type":"assistant/message","tag":"frame-B"}\n'
  const frameA = zstdCompressSync(Buffer.from(partA, 'utf8'))
  const frameB = zstdCompressSync(Buffer.from(partB, 'utf8'))
  const buf = Buffer.concat([frameA, frameB])

  const bounds = frameBounds(buf)
  ok(bounds.length === 2, `合成固件：帧切分识别出 2 帧，实际 ${bounds.length}`)
  ok(bounds[0][0] === 0 && bounds[0][1] === frameA.length, '第一帧边界精确贴合')
  ok(bounds[1][0] === frameA.length && bounds[1][1] === buf.length, '第二帧边界精确贴合')

  const all = decompressAll(buf).toString('utf8')
  ok(all.includes('frame-A'), 'decompressAll 解出第一段内容')
  ok(all.includes('frame-B'), 'decompressAll 解出第二段内容')

  // 固化「Node 原生只解第一帧」这个坑：直接用 zstdDecompressSync 会静默丢掉 99% 内容。
  const native = zstdDecompressSync(buf).toString('utf8')
  ok(native.includes('frame-A'), 'Node 原生解压能拿到第一段')
  ok(!native.includes('frame-B'), 'Node 原生解压拿不到第二段（只解第一帧，正是要绕开的坑）')
}

// ---- 2. 合成样本：求和口径与来源分组 ----------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'usage-scan-'))
try {
  const day1 = Date.UTC(2026, 9, 17, 4, 0, 0)
  const day2 = Date.UTC(2026, 9, 18, 4, 0, 0)
  const rec = (type, time, data) => JSON.stringify({ type, time, data })
  const file = join(dir, 'session.v4.jsonl')
  await writeFile(
    file,
    [
      rec('assistant/message', day1, {
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 5, totalTokens: 112 },
        message: { source: { provider: 'alpha', model: 'm1' } },
      }),
      rec('assistant/message', day2, {
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
        message: { source: { provider: 'alpha', model: 'm1' } },
      }),
      rec('assistant/message', day2, {
        usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 },
        message: { source: { provider: 'beta', model: 'm2' } },
      }),
      // 没有来源的记录：必须计入「未知来源」而不是被丢掉
      rec('assistant/message', day2, {
        usage: { inputTokens: 4, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 4 },
      }),
      // model/selection 事件
      rec('model/selection', day2, { provider: 'beta', model: 'm2' }),
      // 无 usage 的 assistant 记录（标题生成等）
      rec('assistant/message', day2, { message: { source: { provider: 'alpha', model: 'm1' } } }),
      'not json',
      '',
    ].join('\n'),
    'utf8',
  )

  const result = await scanSessionFiles([file])
  const alpha = result.bySource.get('alpha\u0000m1')
  ok(alpha.total === 119, `alpha 总量 = 119（10+2+100+5 + 1+1），实际 ${alpha.total}`)
  ok(alpha.cacheRead === 100, 'cacheRead 单独统计，不混进 input')
  ok(alpha.calls === 2, '调用次数 = 2（无 usage 的记录不计）')
  const beta = result.bySource.get('beta\u0000m2')
  ok(beta.total === 10, 'beta 总量 = 10')
  const unknown = result.bySource.get('\u0000')
  ok(unknown !== undefined && unknown.total === 4, '无来源记录归入未知来源桶，不丢失')
  ok(result.messages === 4, '计入的 assistant 消息 = 4')
  ok(result.unknownSource === 1, '未知来源计数 = 1')
  ok(result.selected.get('beta\u0000m2').msgs === 1, 'model/selection 被记录')

  const store = createUsageStore({ sessionsRoot: dir, ttlMs: 0 })
  const doc = await store.read({ force: true, now: day2 + 3600_000 })
  ok(doc.totals.all === 133, `总计 = 133（119+10+4），实际 ${doc.totals.all}`)
  ok(doc.sources.length === 3, '来源明细 3 条')
  ok(doc.sources[0].provider === 'alpha', '按总量降序，alpha 第一')
  ok(doc.providers.length === 3, '按 provider 聚合 3 条')
  const seriesSum = doc.series.reduce((a, b) => a + b.total, 0)
  ok(seriesSum === 133, '时间序列求和 = 总量')
  ok(doc.totals.today === 16, `今天 = 16（day2 的 2+10+4），实际 ${doc.totals.today}`)

  // 增量：文件没变时必须整份命中缓存
  const second = await store.read({ force: true, now: day2 + 3600_000 })
  ok(second.scan.reusedFiles === 1 && second.scan.scannedFiles === 0, '未变化的文件整份走缓存')

  // 追加一行后只重扫这一个文件
  await writeFile(
    file,
    (await (await import('node:fs/promises')).readFile(file, 'utf8')) +
      '\n' +
      rec('assistant/message', day2, {
        usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100 },
        message: { source: { provider: 'alpha', model: 'm1' } },
      }),
    'utf8',
  )
  const third = await store.read({ force: true, now: day2 + 3600_000 })
  ok(third.totals.all === 233, `追加后总计 = 233，实际 ${third.totals.all}`)
  ok(third.scan.scannedFiles === 1, '只重扫变化的文件')
} finally {
  await rm(dir, { recursive: true, force: true })
}

// ---- 3. 日期键按本地时区切天 ------------------------------------------------
ok(localDayKey(new Date(2026, 9, 19, 23, 30).getTime()) === '2026-10-19', '本地日切天不受 UTC 影响')

console.log(`\n${checks} checks passed`)
