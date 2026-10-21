// 直接跑一次用量 store，验证后端在真实会话日志上的输出
import { createUsageStore } from '../lib/usage-store.js'

const store = createUsageStore()
const doc = await store.read({ windowDays: 30, force: true })
console.log(JSON.stringify({
  generatedAt: doc.generatedAt,
  scan: doc.scan,
  totals: doc.totals,
  topSources: (doc.sources ?? []).slice(0, 5),
  topProviders: (doc.providers ?? []).slice(0, 5),
  seriesPoints: (doc.series ?? []).length,
}, null, 2))
