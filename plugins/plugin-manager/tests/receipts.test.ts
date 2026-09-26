import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 子路径 `./receipts`：各条命令回执的类型，给界面的浏览器侧 `import type`。只有类型，引用链上不许有包名 import——
 * 界面的浏览器侧 tsconfig 只有 DOM 类型，这里引进一个包（含 `node:`），界面就得为它多列一个 dev 依赖。
 * 构建产物那几条在没有 `dist/` 时跳过：`pnpm check` 不依赖 build。
 */

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(packageDir, 'dist')
const RECEIPTS_DECLARATION = 'receipts.d.ts'
const built = fs.existsSync(path.join(distDir, RECEIPTS_DECLARATION))

if (!built) console.warn('[gwb-plugin-manager] dist/receipts.d.ts 还没构建，子路径 ./receipts 的产物检查跳过（pnpm build 之后再跑）')

/** 界面要用的回执类型；删掉或改名其中一个，界面的类型检查跟着坏 */
const RECEIPT_TYPE_NAMES = [
  'Outcome',
  'EntrySnapshot',
  'ReconciledPackage',
  'UnmetPeer',
  'PeerStatus',
  'PluginPackageView',
  'Installed',
  'EntryAdded',
  'Uninstalled',
  'UpdateInfo',
  'OutdatedMap',
  'OutdatedFound',
  'PluginRow',
  'SearchFound',
  'VersionChange',
  'RemountedEntry',
  'UpdatedPackage',
  'DependentPackage',
  'Updated',
  'KernelInstalledButCordisNot',
]

/** 一份 TS 源码或声明文件里引用到的模块：`from '…'`、`import('…')`、`import '…'`、`/// <reference types|path="…" />` */
function moduleReferencesIn(text: string): string[] {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\/\/\/\s*<reference\s+(?:types|path)\s*=\s*['"]([^'"]+)['"]/g,
  ]
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!))
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/** 从入口 d.ts 顺着相对引用走到的全部 d.ts（相对 dist/ 的路径）；`.js` 结尾的引用对应同名 `.d.ts` */
function declarationChainFrom(entry: string): string[] {
  const visited = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    for (const specifier of moduleReferencesIn(fs.readFileSync(path.join(distDir, file), 'utf8'))) {
      if (!isRelative(specifier)) continue
      const target = path.join(path.dirname(file), specifier).replace(/\.js$/, '.d.ts')
      pending.push(target.endsWith('.d.ts') ? target : `${target}.d.ts`)
    }
  }
  return [...visited]
}

describe('子路径 ./receipts：命令回执的类型', () => {
  it('package.json 的 exports 只给 types 条件——没有运行时入口，按值 import 会在构建时报错', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(manifest.exports['./receipts']).toEqual({ types: `./dist/${RECEIPTS_DECLARATION}` })
  })

  it('源码 src/receipts.ts 一个模块都不引用，相对路径也不行', () => {
    expect(moduleReferencesIn(fs.readFileSync(path.join(packageDir, 'src/receipts.ts'), 'utf8'))).toEqual([])
  })

  describe.skipIf(!built)('构建产物', () => {
    it('d.ts 链上没有包名引用（含 node:）——界面的浏览器侧类型检查不用为它多列依赖', () => {
      const packageReferences = declarationChainFrom(RECEIPTS_DECLARATION).flatMap((file) =>
        moduleReferencesIn(fs.readFileSync(path.join(distDir, file), 'utf8'))
          .filter((specifier) => !isRelative(specifier))
          .map((specifier) => `${file}: ${specifier}`),
      )
      expect(packageReferences).toEqual([])
    })

    it('导出界面要用的回执类型', () => {
      const declaration = fs.readFileSync(path.join(distDir, RECEIPTS_DECLARATION), 'utf8')
      const missingNames = RECEIPT_TYPE_NAMES.filter((name) => !new RegExp(`export (?:interface|type) ${name}\\b`).test(declaration))
      expect(missingNames).toEqual([])
    })
  })
})
