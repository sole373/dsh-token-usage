/**
 * 模型排名路由：`GET {prefix}/model-rank`。
 *
 * 与用量路由同一套守卫（只回环 + 只 GET/HEAD + 一律 `no-store`）。
 * 参数只有 `refresh=1`：强制重新拉榜单（绕过 6 小时 TTL）。
 *
 * 这个端点是**只读**的，不参与模型选择——选择权仍在
 * `/dsh-agent-checkin/models` 与设置页「平台与模型」。排名页只回答
 * 「我现在能用的模型里，哪个更适合干什么」，不改任何东西。
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
 * @param {object} wctx 已注入 webServer 的 ctx
 * @param {object} deps
 * @param {(options?: {force?: boolean, rows?: Array<object>}) => Promise<object>} deps.readRank
 * @param {string} deps.prefix
 * @param {Function} deps.effect
 * @returns {string} 实际注册的路径
 */
export function registerModelRankRoutes(wctx, deps) {
  const { readRank, prefix, effect } = deps
  const base = String(prefix ?? '').trim().replace(/\/+$/, '')
  const path = `${base === '/' ? '' : base}/model-rank`

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
          const doc = await readRank({ force })
          sendJson(res, 200, { ok: true, ...doc })
        } catch (error) {
          sendJson(res, 500, { ok: false, status: 'rank-failed', detail: String(error?.message ?? error) })
        }
      },
    }),
  )
  return path
}
