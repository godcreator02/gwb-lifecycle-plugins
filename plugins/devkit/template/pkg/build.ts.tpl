import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * 浏览器侧构建。外置名单里的包名不打包，运行时由页面的 importmap 解析，插件之间用同一份；其余依赖
 * 全部打包进 dist/client.js——外置了 importmap 里没有的包名，运行时就是「Failed to resolve module specifier」。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

/** 外置名单只从提供方读：react 的四个包名由内核包提供，名单是它清单里 gwb.shared 的键，构建时从装好的内核包里读（peer 写了它，pnpm 装在本包的 node_modules 里） */
function sharedNamesOfKernel(): string[] {
  const manifestPath = fileURLToPath(import.meta.resolve('@godcreator/gwb-kernel-desktop/package.json'))
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const gwb = isRecord(manifest) ? manifest['gwb'] : undefined
  const shared = isRecord(gwb) ? gwb['shared'] : undefined
  if (!isRecord(shared)) {
    throw new Error(`${manifestPath} 里没有 gwb.shared：装的内核包版本不提供 react，把 peer 里的 @godcreator/gwb-kernel-desktop 抬到 ^0.4.1 起`)
  }
  return Object.keys(shared)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'dist/client.js',
  external: sharedNamesOfKernel(),
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
