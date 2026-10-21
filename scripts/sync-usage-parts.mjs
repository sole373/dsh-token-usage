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

let source = readFileSync(CLIENT, 'utf8')

const css = readFileSync(join(LIB, CSS_FILE), 'utf8').trim()
source = replaceBetween(source, CSS_BEGIN, CSS_END, CSS_BEGIN + '\n' + css + '\n' + CSS_END)

const code = PARTS.map((name) => {
  const body = indent(readFileSync(join(LIB, name), 'utf8').trimEnd(), 4)
  return '    // ---- ' + name + ' ----\n' + body
}).join('\n\n')
source = replaceBetween(source, CODE_BEGIN, CODE_END, CODE_BEGIN + '\n' + code + '\n    ' + CODE_END)

writeFileSync(CLIENT, source, 'utf8')
console.log('synced', PARTS.length, 'parts and', css.length, 'chars of CSS into client.js')
