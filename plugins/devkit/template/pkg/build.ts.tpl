import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * 浏览器侧构建。外置名单里的包名不打包，运行时由页面的 importmap 解析，插件之间用同一份；其余依赖
 * 全部打包进 dist/client.js——外置了 importmap 里没有的包名，运行时就是「Failed to resolve module specifier」。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

/** 外置名单只从提供方读：importmap 的提供方是外壳，名单是它清单里 gwb.shared 的键，构建时从装好的外壳包里读 */
function sharedNamesOfShell(): string[] {
  const manifestPath = fileURLToPath(import.meta.resolve('@godcreator/gwb-shell/package.json'))
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const gwb = isRecord(manifest) ? manifest['gwb'] : undefined
  const shared = isRecord(gwb) ? gwb['shared'] : undefined
  if (!isRecord(shared)) {
    throw new Error(`${manifestPath} 里没有 gwb.shared：装的外壳版本不提供 importmap，升级 dev 里的 @godcreator/gwb-shell`)
  }
  return Object.keys(shared)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'dist/client.js',
  external: sharedNamesOfShell(),
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
