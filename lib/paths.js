/**
 * DSH 主目录解析：**全插件只有这一个口径**。
 *
 * 为什么单独抽一个模块：早期 `lib/index.js` 里写的是
 *
 * ```js
 * const paths = ctx.get('homePaths')
 * return paths?.dshHome || process.env.DSH_HOME || joinHome()
 * ```
 *
 * 三个键依次落空，末位兜底还少一层 `.dsh`，于是状态目录被写到了用户主目录
 * 根部（`~/dsh-token-usage`），而会话日志读的是 `~/.dsh/sessions`——两个本该
 * 同处一地的文件被拆散。根因不是"少写了一个 if"，而是**没有一处权威解析**。
 *
 * 宿主把主目录作为**服务**提供，名字是 `dshHomePath`，但它的值是**函数**
 * （`dshHomePath(...segments)` → 绝对路径），不是字符串：
 *
 * ```js
 * ctx.provide('dshHomePath', dshHomePath)
 * function dshHomePath(...segments) { return join(resolveDshHome(), ...segments) }
 * ```
 *
 * 所以 `typeof service === 'string'` 这种判断永远进不去，必须**调用**它。
 *
 * 优先级与宿主 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 对齐：
 * **宿主服务 → `$DSH_HOME` → `~/.dsh`**。宿主把空白 `DSH_HOME` 视为未设置，
 * 这里同样处理（空白值绝不能把主目录解析成当前工作目录）。
 *
 * @module dsh-token-usage/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 宿主提供主目录解析的服务名。值是函数 `dshHomePath(...segments)`。 */
export const DSH_HOME_SERVICE = 'dshHomePath'

/** 非空字符串才算有效路径；空白视为未设置（与宿主口径一致）。 */
function isUsablePath(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 解析 DSH 主目录（绝对路径）。
 *
 * @param {object} [ctx] cordis 上下文。提供时优先使用宿主服务。
 * @param {Record<string, string | undefined>} [env] 环境变量映射，便于测试注入。
 * @returns {string} DSH 主目录绝对路径。
 */
export function resolveDshHome(ctx, env = process.env) {
  const service = typeof ctx?.get === 'function' ? ctx.get(DSH_HOME_SERVICE) : undefined

  // 宿主服务（当前形态：函数）。调用它拿到宿主自己解析出来的 home。
  if (typeof service === 'function') {
    try {
      const resolved = service()
      if (isUsablePath(resolved)) return resolved.trim()
    } catch {
      // 服务不可用时落到环境变量与默认路径，不让插件因此加载失败。
    }
  }
  // 兼容宿主将来把它换成字符串直出的形态。
  if (isUsablePath(service)) return service.trim()

  if (isUsablePath(env?.DSH_HOME)) return env.DSH_HOME.trim()
  return join(homedir(), '.dsh')
}

/**
 * 会话日志根目录。
 *
 * @param {object} [ctx] cordis 上下文。
 * @param {Record<string, string | undefined>} [env] 环境变量映射，便于测试注入。
 * @returns {string} 会话日志根目录绝对路径。
 */
export function resolveSessionsRoot(ctx, env = process.env) {
  return join(resolveDshHome(ctx, env), 'sessions')
}

/**
 * 插件状态目录：`<dshHome>/dsh-token-usage`（榜单缓存落在这里，与插件本体分离）。
 *
 * @param {object} [ctx] cordis 上下文。
 * @returns {string} 状态目录绝对路径。
 */
export function resolveStateDir(ctx) {
  return join(resolveDshHome(ctx), 'dsh-token-usage')
}
