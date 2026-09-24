import { builtinModules } from 'node:module'
import path from 'node:path'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'
import { isRecord } from './vocab.js'

// 纯函数：读文件只经调用方给的 readText，测试里给一张假文件表

/** 一个产物文件里的 import，按种类分开 */
export interface ModuleImports {
  /** 包名 import（含 `node:` 前缀的内置模块） */
  bare: string[]
  /** `./`、`../`、`/` 开头的 import */
  relative: string[]
  /** `import {} from '<名>'` / `export {} from '<名>'`：源码里 `import { type X }` 在 verbatimModuleSyntax 下留下的空 import */
  empty: string[]
}

// 只认产物里的三种写法：顶格的 `import … from` / `export … from` / `import '<名>'`（tsc 与 esbuild 输出的顶层 import 都顶格写），以及非注释行里带字面量的 `import('<名>')`
const STATIC_IMPORT = /^(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?(['"])([^'"\n]+)\1/gm
const EMPTY_IMPORT = /^(?:import|export)\s*\{\s*\}\s*from\s*(['"])([^'"\n]+)\1/gm
const DYNAMIC_IMPORT = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
}

/** 带协议的地址（`file:`、`data:`、`https:`）不是包名 import；`node:` 是内置模块，算包名 import */
function isUrl(spec: string): boolean {
  return URL_SCHEME.test(spec) && !spec.startsWith('node:')
}

export function importsOf(code: string): ModuleImports {
  const specs: string[] = []
  for (const match of code.matchAll(STATIC_IMPORT)) specs.push(match[2]!)
  for (const line of code.split(/\r?\n/)) {
    if (COMMENT_LINE.test(line)) continue
    for (const match of line.matchAll(DYNAMIC_IMPORT)) specs.push(match[2]!)
  }
  const bare = new Set<string>()
  const relative = new Set<string>()
  for (const spec of specs) {
    if (isRelative(spec)) relative.add(spec)
    else if (!isUrl(spec)) bare.add(spec)
  }
  const empty = [...new Set([...code.matchAll(EMPTY_IMPORT)].map((match) => match[2]!))]
  return { bare: [...bare], relative: [...relative], empty }
}

/** `@scope/name/sub` → `@scope/name`；`name/sub` → `name` */
export function packageNameOf(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/**
 * node 侧允许的包名 import（含子路径）：node 内置模块、`electron`、本包 peer 里写了的包。
 * peer 由发版检查限定为 cordis、内核包与插件，都是 home 里装着的，按包名解析得到
 */
export function allowedOnNodeSide(spec: string, peers: ReadonlySet<string>): boolean {
  if (spec.startsWith('node:')) return true
  if (builtinModules.includes(spec)) return true
  const pkg = packageNameOf(spec)
  return pkg === 'electron' || peers.has(pkg)
}

const RUNTIME_CONDITIONS = new Set(['node', 'import', 'module-sync', 'default'])

/** 一条 `exports` 目标里的运行时文件：字符串原样；条件对象按键的顺序取第一个运行时条件（`types` 不算） */
function runtimeTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target
  if (!isRecord(target)) return undefined
  for (const [condition, value] of Object.entries(target)) {
    if (!RUNTIME_CONDITIONS.has(condition)) continue
    const found = runtimeTarget(value)
    if (found !== undefined) return found
  }
  return undefined
}

/** `exports` 里某个子路径（`.`、`./react`）指到的运行时文件，相对包目录；没有 `exports` 时 `.` 取 `main` */
export function exportTarget(manifest: Record<string, unknown>, subpath: string): string | undefined {
  const exported = manifest.exports
  if (exported === undefined) return subpath === '.' && typeof manifest.main === 'string' ? manifest.main : undefined
  const hasSubpaths = isRecord(exported) && Object.keys(exported).some((key) => key.startsWith('.'))
  if (!hasSubpaths) return subpath === '.' ? runtimeTarget(exported) : undefined
  return runtimeTarget((exported as Record<string, unknown>)[subpath])
}

const IMPORTMAP_SCRIPT = /<script type="importmap">([\s\S]*?)<\/script>/

/** 页面入口 html 里那段 importmap 的名字；没有这段 importmap 回 undefined，JSON 不合法当场抛错 */
export function importmapNamesOf(html: string): string[] | undefined {
  const script = IMPORTMAP_SCRIPT.exec(html)
  if (script === null) return undefined
  const importmap: unknown = JSON.parse(script[1]!)
  return isRecord(importmap) && isRecord(importmap.imports) ? Object.keys(importmap.imports) : []
}

export interface ArtifactIo {
  readText(file: string): string | undefined
}

interface WalkedModules {
  /** 走到的文件（绝对路径）→ 它的 import */
  modules: Map<string, ModuleImports>
  /** 指向不存在文件的相对 import，已写成回执里的一句话 */
  broken: string[]
}

/** 从入口顺着相对 import 走到的全部文件 */
function walkModules(pkgDir: string, entries: string[], io: ArtifactIo): WalkedModules {
  const modules = new Map<string, ModuleImports>()
  const broken: string[] = []
  const filesToRead = [...entries]
  while (filesToRead.length > 0) {
    const file = filesToRead.pop()!
    if (modules.has(file)) continue
    const code = io.readText(file)
    if (code === undefined) {
      broken.push(`产物 ${relativeToPackage(pkgDir, file)} 不在：构建之后它该在`)
      continue
    }
    const imports = importsOf(code)
    modules.set(file, imports)
    for (const spec of imports.relative) {
      const target = spec.startsWith('/') ? spec : path.resolve(path.dirname(file), spec)
      if (io.readText(target) === undefined) {
        broken.push(`${relativeToPackage(pkgDir, file)} 里 import 的 '${spec}' 不在：node 与浏览器都不补扩展名，相对 import 要写到带 .js 的文件名`)
        continue
      }
      filesToRead.push(target)
    }
  }
  return { modules, broken }
}

function relativeToPackage(pkgDir: string, file: string): string {
  return path.relative(pkgDir, file).replaceAll('\\', '/')
}

/** 浏览器侧入口：模板 `build.ts` 用 esbuild 输出的 `dist/client.js` */
export const BROWSER_ENTRY = 'dist/client.js'



function emptyImportProblems(pkgDir: string, modules: [string, ModuleImports][]): string[] {
  return modules.flatMap(([file, imports]) =>
    imports.empty.map((spec) => `${relativeToPackage(pkgDir, file)} 里有空 import：import {} from '${spec}'。源码里只引类型的写成 import type { X }，不写 import { type X }`),
  )
}

function peersOf(manifest: Record<string, unknown>): Set<string> {
  return new Set(isRecord(manifest.peerDependencies) ? Object.keys(manifest.peerDependencies) : [])
}

function nodeSideBareImportProblems(pkgDir: string, nodeModules: Map<string, ModuleImports>, peers: ReadonlySet<string>): string[] {
  const problems: string[] = []
  for (const [file, imports] of nodeModules) {
    for (const spec of imports.bare.filter((one) => !allowedOnNodeSide(one, peers))) {
      problems.push(
        `node 侧产物 ${relativeToPackage(pkgDir, file)} import 了 '${spec}'：node 侧只能 import node 内置模块、electron 与 peer 里写了的包（cordis、内核包、用到的插件）。` +
          `用到的插件写进 peer；自用的库打包进产物`,
      )
    }
  }
  return problems
}

function browserSideBareImportProblems(pkgDir: string, browserModules: Map<string, ModuleImports>, io: ArtifactIo): string[] {
  const browserBare = [...browserModules].flatMap(([file, imports]) => imports.bare.map((spec) => ({ file, spec })))
  if (browserBare.length === 0) return []
  const importmap = kernelImportmapNamesOf(pkgDir, io)
  const problems = [...importmap.problems]
  for (const { file, spec } of browserBare) {
    if (importmap.names.has(spec)) continue
    problems.push(
      `浏览器侧产物 ${relativeToPackage(pkgDir, file)} import 了 '${spec}'：页面 importmap 里没有这个名字` +
        `（只有 ${importmap.names.size === 0 ? '无' : [...importmap.names].join('、')}）。打包进产物，外置名单从内核包的页面入口 dist/index.html 里那段 importmap 读`,
    )
  }
  return problems
}

/**
 * `plugin` 为 false（库、工具包）时只查空 import 与相对 import 指向的文件在不在；
 * 包名 import 的两份名单只管插件：库的 import 由用它的插件打包时解析，不在 home 里按包名解析
 */
export function artifactProblems(pkgDir: string, manifest: Record<string, unknown>, plugin: boolean, io: ArtifactIo): string[] {
  const problems: string[] = []
  const nodeEntry = exportTarget(manifest, '.')
  if (nodeEntry === undefined) problems.push('清单里没有 exports["."]（或 main），找不到 node 侧入口')
  const node = walkModules(pkgDir, nodeEntry === undefined ? [] : [path.resolve(pkgDir, nodeEntry)], io)
  const clientFile = path.resolve(pkgDir, BROWSER_ENTRY)
  const browser = walkModules(pkgDir, io.readText(clientFile) === undefined ? [] : [clientFile], io)

  problems.push(...node.broken, ...browser.broken)
  problems.push(...emptyImportProblems(pkgDir, [...node.modules, ...browser.modules]))
  if (!plugin) return problems

  problems.push(...nodeSideBareImportProblems(pkgDir, node.modules, peersOf(manifest)))
  problems.push(...browserSideBareImportProblems(pkgDir, browser.modules, io))
  return problems
}

/**
 * 页面 importmap 里的名字：内核包页面入口 `dist/index.html` 里写死的那段 importmap 的键。从本包的 `node_modules` 读
 * （插件 peer 写了内核包，pnpm 把它链接在那里），读不到就报出来，不猜
 */
function kernelImportmapNamesOf(pkgDir: string, io: ArtifactIo): { names: Set<string>; problems: string[] } {
  const file = path.join(pkgDir, 'node_modules', ...KERNEL_PACKAGE.split('/'), 'dist', 'index.html')
  const html = io.readText(file)
  if (html === undefined) {
    return { names: new Set(), problems: [`内核包的页面入口读不到（${file}），算不出页面 importmap 里的名字：peer 写上内核包 ^0.6.0 起，再在仓根 pnpm install`] }
  }
  try {
    const names = importmapNamesOf(html)
    if (names === undefined) return { names: new Set(), problems: [`内核包的页面入口里没有 <script type="importmap">（${file}）`] }
    return { names: new Set(names), problems: [] }
  } catch (err) {
    return { names: new Set(), problems: [`内核包页面入口里的 importmap 不是合法 JSON（${file}）：${String(err)}`] }
  }
}
