/**
 * 用量统计路由：`GET {prefix}/usage`。
 *
 * 与插件其余路由同一套守卫（回环 + 方法），JSON 一律 `no-store`：
 * 「刚刷新完还是旧数字」是这类面板最伤信任的失败模式。
 */

import { isLoopbackRequest } from './loopback.js'

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 注册用量路由。
 *
 * @param {object} wctx 已注入 webServer 的 ctx
 * @param {object} deps
 * @param {(options?: {force?: boolean, days?: number}) => Promise<object>} deps.readUsage
 * @param {string} deps.prefix 插件的 statusRoute 前缀
 * @param {Function} deps.effect 宿主 effect 注册器
 * @returns {string} 实际注册的路径
 */
export function registerUsageRoutes(wctx, deps) {
  const { readUsage, prefix, effect } = deps
  const base = String(prefix ?? '').trim().replace(/\/+$/, '')
  const path = `${base === '/' ? '' : base}/usage`

  effect(() =>
    wctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, { ok: false, status: 'forbidden', detail: '只接受本机回环请求' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, status: 'method-not-allowed', detail: '只接受 GET' })
          return
        }
        try {
          const url = new URL(req.url ?? path, 'http://127.0.0.1')
          const force = url.searchParams.get('refresh') === '1'
          const daysParam = Number.parseInt(url.searchParams.get('days') ?? '', 10)
          const days = Number.isFinite(daysParam) ? daysParam : undefined
          const doc = await readUsage({ force, days })
          sendJson(res, 200, { ok: true, ...doc })
        } catch (error) {
          sendJson(res, 500, { ok: false, status: 'scan-failed', detail: String(error?.message ?? error) })
        }
      },
    }),
  )
  return path
}
