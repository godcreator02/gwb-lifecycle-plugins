import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * 浏览器侧构建。外置名单里的包名不打包，运行时由页面的 importmap 解析，插件之间用同一份；其余依赖
 * 全部打包进 dist/client.js——外置了 importmap 里没有的包名，运行时就是「Failed to resolve module specifier」。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 外置名单只从提供方读：react 的四个包名由内核包提供，写死在它页面入口 dist/index.html 的 importmap 里，
 * 构建时从装好的内核包里读（peer 写了它，pnpm 装在本包的 node_modules 里）
 */
function importmapNamesOfKernel(): string[] {
  const manifestPath = fileURLToPath(import.meta.resolve('@godcreator/gwb-kernel-desktop/package.json'))
  const pageEntry = path.join(path.dirname(manifestPath), 'dist', 'index.html')
  const importmapScript = /<script type="importmap">([\s\S]*?)<\/script>/.exec(fs.readFileSync(pageEntry, 'utf8'))
  if (importmapScript === null) {
    throw new Error(`${pageEntry} 里没有 <script type="importmap">：外置名单只从内核包页面入口的这段 importmap 读，读不到就不构建`)
  }
  const importmap: unknown = JSON.parse(importmapScript[1]!)
  const imports = isRecord(importmap) ? importmap['imports'] : undefined
  if (!isRecord(imports)) throw new Error(`${pageEntry} 的 importmap 里没有 imports`)
  return Object.keys(imports)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'dist/client.js',
  external: importmapNamesOfKernel(),
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  bundle: true,
  minify: false,
  legalComments: 'none',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  absWorkingDir: here,
})

console.log('[{{name}}] dist/client.js ← src/client/index.tsx')
