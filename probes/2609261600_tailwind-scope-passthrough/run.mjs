// 真实 Tailwind 4 编一份写了 @scope 的样式入口：@scope 原样留下吗、压缩后长什么样、当根用的前缀类单独编得出规则吗
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, 'package.json'))
const { compile, optimize } = require('@tailwindcss/node')

const entry = `@import 'tailwindcss/theme.css' theme(reference) prefix(bn);
@import 'tailwindcss/utilities.css';
@scope (.bn\\:render-root) to (.bn\\:hole) {
  .katex { font: normal 1.21em KaTeX_Main; }
  .katex .mfrac > span { text-align: center; }
}
@media (min-width: 10px) { @scope (.bn\\:render-root) { .katex-display { margin: 1em 0; } } }
`

const compiler = await compile(entry, { base: path.join(here, 'node_modules'), onDependency() {} })
const withFlex = compiler.build(['bn:flex'])
const withRoot = compiler.build(['bn:render-root'])
console.log(`bn:render-root 单独编得出规则：${String(withFlex !== withRoot)}`)
console.log('--- 编译输出 ---')
console.log(withRoot)
console.log('--- optimize({ minify: true }) ---')
console.log(optimize(withRoot, { minify: true }).code)
