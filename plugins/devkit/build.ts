import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'

/**
 * node 侧构建：src/index.ts 顺着相对 import 打成一个 dist/index.js。产物里的包名 import 只许留 node 内置模块、
 * electron 与 peer 里写了的包（发版前检查的 node 侧名单），所以外置名单就是这几类，其余依赖全部打包进去。
 * 类型声明另由 tsc 输出到 dist/（package.json 的 build 脚本）。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const manifest: unknown = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
const peerNames = isRecord(manifest) && isRecord(manifest['peerDependencies']) ? Object.keys(manifest['peerDependencies']) : []

/**
 * `bin/cdp.mjs` 是 node 直接运行的独立脚本，随包发布、不经打包；node-cli 与 `CDP_ENTRY` 按包内路径运行它。
 * src/index.ts 从它 import 的函数留成相对 import：dist/ 与 src/ 同在包根下一层，`../bin/cdp.mjs` 两处指的是同一个文件
 */
const cdpScriptStaysOutside: Plugin = {
  name: 'cdp-script-stays-outside',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/bin\/cdp\.mjs$/ }, () => ({ path: '../bin/cdp.mjs', external: true }))
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 上一次构建留下的文件会随 files 白名单一起发出去，先清空
fs.rmSync(path.join(here, 'dist'), { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  // cordis 不在 peer 里：外置它，是为了哪天有人按值 import 了它，产物里留下包名、被发版前检查拦住，而不是悄悄打包进一份拷贝
  external: ['electron', 'cordis', ...peerNames],
  plugins: [cdpScriptStaysOutside],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  bundle: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: here,
})

console.log('[devkit] dist/index.js ← src/index.ts')
