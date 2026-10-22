/**
 * 把 lib/client-*.js 的片段与 client-usage.css 同步进 lib/client.js 的标记区。
 *
 * 为什么要这一步：宿主的 client bundle 只认 package.json `exports` 里那一个
 * `./client` 入口，运行期不可能临时 require 另一个本地文件；而 client.js 本身
 * 只能 require `react` / `react/jsx-runtime`。所以新功能只能落进同一个 factory
 * 作用域——片段单独成文件（好读、好审、能 `node --check`），由这个脚本拼进去。
 *
 * 标记区里的内容一律视为生成物：改内容请改片段文件，然后重跑本脚本。
 * 不要手改标记区，否则下次同步会被覆盖（本脚本不会吞掉标记外的任何东西）。
 *
 * 行尾策略：**读写一律按 LF 归一化**。片段文件在 Windows 上被检出成 CRLF
 * （`core.autocrlf=true`）时，若直接 `split('\n')`，每行末尾会残留一个 `\r`，
 * 拼进 client.js 后就会在标记区内部混入「一半 CRLF、一半 LF」的混合行尾——
 * 同样的代码内容在两个平台上字节不同，diff 全是噪声。
 * 所以读入时统一 `replace(/\r\n/g, '\n')`，写回时也只写 LF。
 * 归一化只动行尾符，不动任何字符内容，故脚本保持幂等。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const CLIENT = join(LIB, 'client.js')
const PARTS = ['client-usage-shared.js', 'client-usage-charts.js', 'client-usage-ability.js', 'client-usage.js', 'client-model-rank.js']
const CSS_FILE = 'client-usage.css'

const CSS_BEGIN = '/* >>> usage-panel css（由 scripts/sync-usage-parts.mjs 生成，勿手改本段） >>> */'
const CSS_END = '/* <<< usage-panel css <<< */'
const CODE_BEGIN = '// >>> usage-panel parts（由 scripts/sync-usage-parts.mjs 生成，勿手改本段） >>>'
const CODE_END = '// <<< usage-panel parts <<<'

/**
 * 读入文本并把行尾统一成 LF。
 *
 * Windows 检出（`core.autocrlf=true`）会让片段文件带 CRLF；直接 split('\n')
 * 会在每行末尾留下 `\r`，拼进 client.js 后造成标记区内部行尾混杂。
 * 这里只替换行尾符，不碰任何其它字符，所以对内容零影响。
 */
function readNormalized(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** 用起止标记替换老内容；标记缺失时直接报错，而不是猜位置。 */
function replaceBetween(source, begin, end, body) {
  const from = source.indexOf(begin)
  if (from < 0) throw new Error('start marker missing: ' + begin)
  const to = source.indexOf(end, from)
  if (to < 0) throw new Error('end marker missing: ' + end)
  return source.slice(0, from) + body + source.slice(to + end.length)
}

/**
 * 把片段插进去，顺带把缩进补齐。
 *
 * 片段文件是顶层代码（缩进从 0 开始，这样单独 `node --check` 才诚实）；
 * client.js 里它们位于 factory 内，需要右移。**只加前缀空格，不动行内内容**
 * ——任何改写都可能碰到字符串常量。
 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line.trim() === '' ? line : pad + line))
    .join('\n')
}

let source = readNormalized(CLIENT)

const css = readNormalized(join(LIB, CSS_FILE)).trim()
source = replaceBetween(source, CSS_BEGIN, CSS_END, CSS_BEGIN + '\n' + css + '\n' + CSS_END)

const code = PARTS.map((name) => {
  const body = indent(readNormalized(join(LIB, name)).trimEnd(), 4)
  return '    // ---- ' + name + ' ----\n' + body
}).join('\n\n')
source = replaceBetween(source, CODE_BEGIN, CODE_END, CODE_BEGIN + '\n' + code + '\n    ' + CODE_END)

// source 已整体归一成 LF（readNormalized），片段也是 LF，
// 因此输出文件全文行尾一致（纯 LF），与仓库存储格式一致。
writeFileSync(CLIENT, source, 'utf8')
console.log('synced', PARTS.length, 'parts and', css.length, 'chars of CSS into client.js')
