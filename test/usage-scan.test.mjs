/**
 * 用量自我检查：用本机所有真实会话日志验证「多帧解压 + 求和口径 + 增量缓存」三件事。
 *
 * 跑法：node test/usage-scan.test.mjs
 * 这不是单元测试框架，是一条会打脸的断言脚本——本仓库的其余测试也是这个风格。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { decompressAll, frameBounds, localDayKey, scanSessionFiles } from '../lib/usage-scan.js'
import { createUsageStore } from '../lib/usage-store.js'

// 路由日志对账默认会去读本机 `~/.config/magpie/usage.jsonl`。测试必须可复现，
// 所以统一指到一个不存在的路径（等价于「这台机器没装 magpie」）；要验证对账
// 的场景（第 5 节）显式传 routeLogPath，不受这里影响。
process.env.MAGPIE_USAGE_LOG = join(tmpdir(), 'no-such-magpie-usage.jsonl')

let checks = 0
function ok(cond, message) {
  checks += 1
  assert.ok(cond, message)
  console.log(`  ok ${checks} - ${message}`)
}

// ---- 1. 帧切分：拿本机第一份真实日志做真值比对 -------------------------------
// 跨平台取家目录：Windows 认 USERPROFILE，Linux/macOS 认 HOME，都取不到时用 os.homedir()。
// 早先这里写死 process.env.USERPROFILE，GitHub Actions 的 ubuntu runner 上该变量为空，
// join(undefined, ...) 让 readdir 抛 ERR_INVALID_ARG_TYPE，把整条 CI 发布链卡死。
const homeDirForTest = process.env.USERPROFILE || process.env.HOME || homedir()
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

// ---- 4. magpie 是本地路由器：按 model id 第一段拆成真实来源 -------------------
{
  const dir = await mkdtemp(join(tmpdir(), 'usage-magpie-'))
  try {
    const day = Date.UTC(2026, 9, 17, 4, 0, 0)
    const rec = (type, time, data) => JSON.stringify({ type, time, data })
    // group/auto 行带 responseModel（真实日志里有这个字段）；partner 行不带
    const magpieRow = (model, total, responseModel) => {
      const src = { provider: 'magpie', model }
      if (responseModel) src.replayState = { response: { responseModel } }
      return rec('assistant/message', day, {
        usage: { inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: total },
        message: { source: src },
      })
    }
    const file = join(dir, 'session.v4.jsonl')
    await writeFile(
      file,
      [
        magpieRow('qoder/qfmodel', 100),
        // group 行：两个不同 responseModel 应拆成两行（按真实模型聚合）
        magpieRow('group/cheap-first', 200, 'deepseek-v4.1-flash'),
        magpieRow('group/group', 300, 'minimax-m3.1-flash'),
        // 大小写归一：MiniMax-M3.1-Flash 应与 minimax-m3.1-flash 合并
        magpieRow('group/group', 50, 'MiniMax-M3.1-Flash'),
        magpieRow('auto/GLM-5.3', 40, 'glm-5.3'),
        magpieRow('cline/cline-free/nemotron-3.5-super-vl', 5),
        magpieRow('workbuddy-ai/hy3', 10),
        magpieRow('officeace/xxx', 8),
        magpieRow('raccoon/yyy', 6),
        magpieRow('codearts/zzz', 9),
        // 缺 responseModel 的 group 行：退回原始 model id
        magpieRow('group/cheap-first', 10),
        rec('assistant/message', day, {
          usage: { inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 50 },
          message: { source: { provider: 'freeroute', model: 'm' } },
        }),
      ].join('\n'),
      'utf8',
    )
    const result = await scanSessionFiles([file])
    const gotProviders = new Set([...result.bySource.keys()].map((k) => k.split('\u0000')[0]))
    const want = ['magpie-qoder', 'magpie-group', 'magpie-auto', 'magpie-cline', 'magpie-workbuddy-ai', 'magpie-officeace', 'magpie-raccoon', 'magpie-codearts']
    for (const p of want) ok(gotProviders.has(p), `magpie 行按 model 第一段拆分出 ${p}`)

    // group 行按 responseModel 拆分：deepseek-v4.1-flash、minimax-m3.1-flash（合并大小写）、
    // 缺 responseModel 的退回原始 id group/cheap-first，共 3 行
    const groupRows = [...result.bySource.entries()].filter(([k]) => k.startsWith('magpie-group\u0000'))
    ok(groupRows.length === 3, 'group 行按 responseModel 拆分：3 个不同模型')
    const groupModels = groupRows.map(([k]) => k.split('\u0000')[1])
    ok(groupModels.includes('deepseek-v4.1-flash'), 'group 行拆出 deepseek-v4.1-flash')
    ok(groupModels.includes('minimax-m3.1-flash'), 'group 行拆出 minimax-m3.1-flash（小写归一）')
    ok(groupModels.includes('group/cheap-first'), '缺 responseModel 的 group 行退回原始 model id')

    // 大小写归一验证：MiniMax-M3.1-Flash(50) 合并进 minimax-m3.1-flash(300)，总 350
    const mmRow = result.bySource.get('magpie-group\u0000minimax-m3.1-flash')
    ok(mmRow && mmRow.total === 350, `MiniMax 大小写归一合并：total=350，实际 ${mmRow?.total}`)

    // auto 行也按 responseModel 拆分
    const autoRow = result.bySource.get('magpie-auto\u0000glm-5.3')
    ok(autoRow && autoRow.total === 40, 'auto 行拆到真实模型 glm-5.3')

    // groupName 透传：有 responseModel 的行 groupName 是原始 group id
    const dsRow = result.bySource.get('magpie-group\u0000deepseek-v4.1-flash')
    ok(dsRow && dsRow.groupName === 'group/cheap-first', 'groupName 透传原始 group id')

    // 缺 responseModel 的行 groupName 为空
    const fallbackRow = result.bySource.get('magpie-group\u0000group/cheap-first')
    ok(fallbackRow && fallbackRow.groupName === '', '缺 responseModel 的行 groupName 为空')

    // partner 行不受影响
    const qoderRow = result.bySource.get('magpie-qoder\u0000qoder/qfmodel')
    ok(qoderRow && qoderRow.total === 100, 'partner 行保持原始 model id')

    const store = createUsageStore({ sessionsRoot: dir, ttlMs: 0 })
    const doc = await store.read({ force: true, now: day + 3600_000 })
    const providers = new Set(doc.providers.map((p) => p.provider))
    for (const p of want) ok(providers.has(p), `来源分布表 doc.providers 含拆分来源 ${p}`)
    ok(providers.has('freeroute'), '非 magpie 来源保持原 provider 不变')
    ok(!providers.has('magpie'), '环形图不再出现裸 magpie 来源（已拆成路由来源）')

    // groupName 透传到 sources
    const srcDs = doc.sources.find((s) => s.provider === 'magpie-group' && s.model === 'deepseek-v4.1-flash')
    ok(srcDs && srcDs.groupName === 'group/cheap-first', 'sources 透传 groupName 到前端')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---- 5. 缺 responseModel 的 group/auto 行：用 magpie 路由日志对账到 served 模型 ----
// 为什么需要：会话日志里 `group/group-4`、部分 `auto/*` 没有 responseModel，只剩路由 id，
// 模型维度就会统计出一个「group-4」这种假模型。magpie 自己的日志逐行记了 req 与 served，
// 用 req + in/out token + 时间窗就能把真正应答的模型找回来。
{
  const dir = await mkdtemp(join(tmpdir(), 'usage-magpie-route-'))
  try {
    const base = Date.UTC(2026, 10, 2, 6, 0, 0)
    const at = (offsetMs) => base + offsetMs
    const iso = (ms) => new Date(ms).toISOString()

    const routeLog = join(dir, 'magpie-usage.jsonl')
    await writeFile(
      routeLog,
      [
        // 正常命中：DSH 落盘比 magpie 路由完成晚 5 秒
        JSON.stringify({ route_id: 1, t: iso(at(0)), req: 'group/group-4', model: 'hy4flash-exp4', served: 'hy3', in: 1000, out: 20 }),
        // magpie 内部把按模型的自动路由记成 group/auto-*，而 DSH 的 responseModel 就是这个路由 id
        JSON.stringify({ route_id: 2, t: iso(at(60_000)), req: 'group/auto-hy4free', served: 'hy4-free', in: 2000, out: 30 }),
        // auto/* 单测：候选 req 要能试出 group/auto/* 这一形态
        JSON.stringify({ route_id: 3, t: iso(at(120_000)), req: 'group/auto/glm-5.3', served: 'glm-5.3-max', in: 3000, out: 40 }),
        // 干扰行：同一 req 但 token 不同，不能拿来冒充
        JSON.stringify({ route_id: 4, t: iso(at(180_000)), req: 'group/group-3', served: 'nvidia/nemotron-3.5-super-vl:free', in: 11, out: 12 }),
        // 没有 route_id 的行（provider_test 之类）不参与对账
        JSON.stringify({ t: iso(at(180_000)), req: 'group/group-3', served: 'none-should-match', in: 4000, out: 50 }),
        '',
      ].join('\n'),
      'utf8',
    )

    const rec = (time, model, inTok, outTok, responseModel) => {
      const source = { provider: 'magpie', model }
      if (responseModel) source.replayState = { response: { responseModel } }
      return JSON.stringify({
        type: 'assistant/message',
        time,
        data: {
          usage: { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inTok + outTok },
          message: { source },
        },
      })
    }
    const file = join(dir, 'session.v4.jsonl')
    await writeFile(
      file,
      [
        rec(at(5_000), 'group/group-4', 1000, 20), // 缺 responseModel → 对账到 hy3
        rec(at(63_000), 'auto/hy4free', 2000, 30, 'group/auto-hy4free'), // responseModel 仍是路由 id → hy4-free
        rec(at(123_000), 'auto/glm-5.3', 3000, 40), // auto/* → 试 group/auto/glm-5.3 → glm-5.3-max
        rec(at(183_000), 'group/group-3', 4000, 50), // 只有无 route_id 的干扰行 → 保持原样
        rec(at(183_000), 'group/cheap-first', 7777, 88), // 日志里没有这次调用 → 保持原样
      ].join('\n'),
      'utf8',
    )

    const joined = await scanSessionFiles([file], { routeLogPath: routeLog })
    const row = (key) => joined.bySource.get(key)
    const hy3 = row('magpie-group\u0000hy3')
    ok(hy3?.total === 1020, `group/group-4 对账到 hy3（total=1020，实际 ${hy3?.total}）`)
    ok(hy3?.groupName === 'group/group-4', '拆到真实模型后 groupName 仍记原始路由 id')
    const hy4 = row('magpie-auto\u0000hy4-free')
    ok(hy4?.total === 2030, `responseModel 是路由 id 时也解到 hy4-free（实际 ${hy4?.total}）`)
    const glmMax = row('magpie-auto\u0000glm-5.3-max')
    ok(glmMax?.total === 3040, `auto/* 用 group/auto/* 形态对上 glm-5.3-max（实际 ${glmMax?.total}）`)
    ok(row('magpie-group\u0000group/group-3')?.total === 4050, 'token 对不上时保留原始路由 id，不冒认')
    ok(row('magpie-group\u0000group/cheap-first')?.total === 7865, '日志里没有这次调用时保留原始路由 id')
    ok(row('magpie-group\u0000none-should-match') === undefined, '没有 route_id 的行不参与对账')

    // 按模型榜：store 透传 routeLogPath 后，应出现 hy3、不再出现 group-4
    const store = createUsageStore({ sessionsRoot: dir, ttlMs: 0, routeLogPath: routeLog })
    const doc = await store.read({ force: true, now: at(600_000) })
    const byModel = new Map(doc.modelTotals.map((m) => [m.model, m]))
    ok(byModel.has('hy3'), '按模型榜出现 hy3（拆到具体模型）')
    ok(!byModel.has('group-4') && !byModel.has('group/group-4'), '按模型榜不再出现 group-4 这类路由 id')
    ok(byModel.get('hy3')?.merged === true, '合并行带 merged 标记（前端不拼来源）')

    // 关闭对账：退回原行为，路由 id 原样保留
    const raw = await scanSessionFiles([file], { routeLogPath: null })
    ok(raw.bySource.get('magpie-group\u0000group/group-4')?.total === 1020, 'routeLogPath:null 时退回原始路由 id')
    ok(raw.bySource.get('magpie-auto\u0000hy4-free') === undefined, 'routeLogPath:null 时不出现 served 行')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log(`\n${checks} checks passed`)
