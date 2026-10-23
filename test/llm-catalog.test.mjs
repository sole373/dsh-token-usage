/**
 * 「可调用模型」目录自我检查：服务解析、目录枚举、去重、缓存与失效。
 *
 * 跑法：node test/llm-catalog.test.mjs
 *
 * 这里的每一条都对应一个「会静默出错」的点：服务名探测错了会让排名页永远
 * 报「目录不可用」；去重键错了会把两个平台的同名模型合成一条（或把同一平台
 * 的重复广告全留着）；TTL 失效了会让每次打开页面都重新枚举一遍。
 */

import { strict as assert } from 'node:assert'

import { createCallableCatalog, resolveLlmRuntime } from '../lib/llm-catalog.js'

let checks = 0
function ok(cond, message) {
  checks += 1
  assert.ok(cond, message)
  console.log(`  ok ${checks} - ${message}`)
}

// ---- 1. 服务解析：探测候选名，鸭子判定形状 ------------------------------------
// 文档 surface 记的是 ctx.llm，但插件契约只保证 ctx.get(name)；两个都要兜住。
{
  const full = { listProviders: () => [], listModels: async () => [] }
  ok(resolveLlmRuntime({ get: (name) => (name === 'llm' ? full : null) }) === full, 'ctx.get("llm") 命中合格服务')
  ok(resolveLlmRuntime({ get: (name) => (name === '@deepseek-ai/llm' ? full : null) }) === full, '带包名前缀的候选名也能命中')
  ok(resolveLlmRuntime({ get: () => ({ listProviders: () => [] }) }) === null, '只有 listProviders 的服务不算 LlmRuntime（鸭子判定挡住形状不对的）')
  ok(resolveLlmRuntime({ get: () => { throw new Error('no such service') } }) === null, 'ctx.get 抛错不算异常路径，返回 null')
  ok(resolveLlmRuntime({}) === null, 'ctx 连 get 都没有时返回 null')
  ok(resolveLlmRuntime(null) === null, 'ctx 为空时返回 null 而不是炸')
}

// ---- 2. 枚举：平台路由 → 模型行，去重不猜「同名同模型」 ------------------------
let providerCalls = []
let modelCalls = []
let enumerations = 0
const runtime = {
  listProviders() {
    providerCalls.push('call')
    return [
      { id: 'bailian', name: '百炼' },
      { id: 'zhipu', name: '智谱' },
      { id: '' }, // 形状不对的条目直接跳过，不让一个脏条目炸掉整个目录
    ]
  },
  async listModels(provider) {
    modelCalls.push(provider)
    if (provider === 'bailian') {
      return [
        { provider, id: 'qwen-max', name: 'Qwen-Max' },
        { provider, id: 'qwen-max' }, // 同平台重复广告：只留一条
        { provider, id: 'qwen-turbo', name: '' }, // 名字缺失：回退到 id
        null, // 脏条目：跳过
      ]
    }
    if (provider === 'zhipu') {
      return [
        // 不同平台广告同名模型：各自保留（不猜「这两个是不是同一个」）
        { provider, id: 'glm-6-air', name: 'GLM-6-Air' },
        { provider, id: 'qwen-max', name: 'Qwen-Max（转接）' },
      ]
    }
    return 'not an array' // 非数组：按空处理，不炸
  },
}
let fakeNow = 1_000
const catalog = createCallableCatalog({
  resolveRuntime: () => {
    enumerations += 1
    return runtime
  },
  ttlMs: 30_000,
  logger: { warn: () => {} },
  now: () => fakeNow,
})
providerCalls = []
modelCalls = []

const rows = await catalog.read()
ok(enumerations === 1, 'read() 枚举一遍')
ok(rows.length === 4, '去重后 4 行（同平台重复合并、跨平台同名保留）')
ok(rows[0].provider === 'bailian' && rows[0].id === 'qwen-max' && rows[0].name === 'Qwen-Max', '行带 provider/id/name')
ok(rows.some((row) => row.id === 'qwen-turbo' && row.name === 'qwen-turbo'), '名字缺失回退到 id')
ok(rows.filter((row) => row.id === 'qwen-max').length === 2, '不同平台广告的 qwen-max 各占一行')
ok(!rows.some((row) => row.provider === ''), '形状不对的平台路由被跳过')
ok(modelCalls.includes('bailian') && modelCalls.includes('zhipu'), '每个平台都被枚举到')

// ---- 3. 缓存：TTL 内不重枚举，force 绕过，invalidate 立即失效 ------------------
await catalog.read()
ok(enumerations === 1, 'TTL 内第二次 read() 用缓存，不重新枚举')
fakeNow += 31_000
await catalog.read()
ok(enumerations === 2, 'TTL 过期后重新枚举')
fakeNow = 1_000 // 重置回 TTL 内，验证 force 与 invalidate 各自独立生效
await catalog.read({ force: true })
ok(enumerations === 3, 'force: true 绕过 TTL 重新枚举')
catalog.invalidate()
await catalog.read()
ok(enumerations === 4, 'invalidate() 后缓存失效，下次 read() 重新枚举')

// 并发读共享同一次枚举（inflight 串行化）——打开页面瞬间多个组件同时读时
// 不能把宿主打成筛子。注意：上一条的 read() 已把缓存填回 TTL 内，所以这里
// 先 invalidate，让三个并发读都真正落到枚举路径上。
catalog.invalidate()
const concurrent = await Promise.all([catalog.read(), catalog.read(), catalog.read()])
ok(enumerations === 5, '三个并发 read() 只枚举一次')
ok(concurrent[0] === concurrent[1] && concurrent[1] === concurrent[2], '并发读拿到同一份快照')

// ---- 4. 失败路径：如实报错，绝不编空目录 ---------------------------------------
{
  const missing = createCallableCatalog({ resolveRuntime: () => null, logger: { warn: () => {} }, now: () => fakeNow })
  let code = null
  try {
    await missing.read()
  } catch (error) {
    code = error.code
  }
  ok(code === 'LLM_RUNTIME_UNAVAILABLE', '宿主没有 LlmRuntime 时抛 LLM_RUNTIME_UNAVAILABLE，不编空目录')

  const defaulted = createCallableCatalog({ now: () => fakeNow })
  let failed = false
  try {
    await defaulted.read()
  } catch {
    failed = true
  }
  ok(failed === true, '不传 resolveRuntime（默认取不到服务）时同样如实失败')

  // 单个平台 listModels 失败：warn + 跳过，其余平台照常
  const warnings = []
  const flaky = {
    listProviders: () => [{ id: 'good' }, { id: 'bad' }],
    async listModels(provider) {
      if (provider === 'bad') throw new Error('gateway down')
      return [{ provider, id: 'm1', name: 'M1' }]
    },
  }
  const partial = createCallableCatalog({ resolveRuntime: () => flaky, ttlMs: 30_000, logger: { warn: (m) => warnings.push(m) }, now: () => fakeNow })
  const partialRows = await partial.read()
  ok(partialRows.length === 1 && partialRows[0].provider === 'good', '单平台失败被跳过，好平台照常给出')
  ok(warnings.some((line) => line.includes('bad')), '失败的平台被 warn 点名')
}

console.log(`\nllm-catalog: ${checks} passed, 0 failed`)
