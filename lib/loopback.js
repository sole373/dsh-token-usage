/**
 * 回环守卫：只让本机请求读到用量数据。
 *
 * 用量统计读的是 DSH 自己的会话日志——里面是**全部对话的 token 账单**，
 * 虽不含对话正文，但足以暴露用户用了哪些模型、在什么时段工作、用量多寡。
 * 所以它只服务本机回环：Host 不在回环一律拒绝，Origin 存在时也必须是回环。
 *
 * 这段判据从 dsh-agent-checkin 的 platforms.js 原样搬过来（那边被看板、
 * 设置读接口、设置写接口三处共用）。搬而不是共用，是为了两个插件之间
 * **零运行时依赖**——各自独立安装、独立升级，一个不在场时另一个照常工作。
 *
 * @module dsh-token-usage/loopback
 */

/**
 * 主机名字符串是否指向本机回环。
 *
 * @param {unknown} value 形如 `127.0.0.1`、`127.0.0.1:14021`、`localhost:8080`
 */
export function isLoopbackHost(value) {
  if (typeof value !== 'string' || value === '') return false
  return (
    value === 'localhost' ||
    value.startsWith('localhost:') ||
    value === '127.0.0.1' ||
    value.startsWith('127.0.0.1:') ||
    value === '[::1]' ||
    value.startsWith('[::1]:')
  )
}

/**
 * 请求是否来自本机回环。
 *
 * `host` 缺失即判否：HTTP/1.1 要求必带 Host，缺失说明不是正常浏览器流量。
 * `origin` 缺失（同源 GET、curl）判是；存在时必须同样是回环，否则拒绝——
 * 这一条挡住的是「外部页面用浏览器打本机端口」的路径。
 *
 * 注意这**只**是读接口的门槛。本插件全是只读端点，没有写接口，
 * 所以不需要「Origin 与 Host 严格同源」那一层。
 *
 * @param {{headers?: Record<string, string|undefined>}} req
 */
export function isLoopbackRequest(req) {
  if (!isLoopbackHost(req?.headers?.host)) return false
  const origin = req?.headers?.origin
  if (origin === undefined) return true
  try {
    return isLoopbackHost(new URL(origin).host)
  } catch {
    return false
  }
}
