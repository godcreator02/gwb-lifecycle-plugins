import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'
import { initSync, parse, type ImportSpecifier } from 'es-module-lexer'
import { isRecord } from './vocab.js'

// 纯函数：读文件只经调用方给的 readText，测试里给一张假文件表

/** 一个产物文件里的 import，按种类分开 */
export interface ModuleImports {
  /** 包名 import（含 `node:` 前缀的内置模块） */
  bare: string[]
  /** `./`、`../`、`/` 开头的 import */
  relative: string[]
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
}

/** 带协议的地址（`file:`、`data:`、`https:`）不是包名 import；`node:` 是内置模块，算包名 import */
function isUrl(spec: string): boolean {
  return URL_SCHEME.test(spec) && !spec.startsWith('node:')
}

const SINGLE_STRING_LITERAL = /^(['"])[\s\S]*\1$/

/**
 * 按 JS 语法找（es-module-lexer）：字符串、模板、正则、注释里的 `import(…)` 不算，压成一行照样认。
 * 记静态 import / `export … from`，以及参数是单个字符串字面量的 `import()`；`import(x)`、`import(\`t\`)` 不记。
 * 读不下去就抛错，错误信息是出错的行列号
 */
export function importsOf(code: string): ModuleImports {
  const bare = new Set<string>()
  const relative = new Set<string>()
  for (const name of lexedImports(code)) {
    if (isRelative(name)) relative.add(name)
    else if (!isUrl(name)) bare.add(name)
  }
  return { bare: [...bare], relative: [...relative] }
}

function lexedImports(code: string): string[] {
  // 没初始化时 parse 不抛错，而是返回一个 Promise；initSync 重复调用直接返回
  initSync()
  let found: readonly ImportSpecifier[]
  try {
    found = parse(code)[0]
  } catch (err) {
    const at = (err as { idx?: unknown }).idx
    if (typeof at !== 'number') throw err
    const { line, column } = lineColumnOf(code, at)
    throw new Error(`第 ${String(line)} 行第 ${String(column)} 列`, { cause: err })
  }
  const lexed: string[] = []
  for (const one of found) {
    if (one.d === -2 || one.n === undefined) continue
    if (one.d === -1 || SINGLE_STRING_LITERAL.test(code.slice(one.s, one.e))) lexed.push(one.n)
  }
  return lexed
}

/** 行列号都从 1 数 */
function lineColumnOf(code: string, offset: number): { line: number; column: number } {
  const before = code.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  return { line: before.split('\n').length, column: offset - lineStart + 1 }
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

/** 运行时的 js 文件；`./styles.css` 这类 exports 目标不是模块 */
const RUNTIME_MODULE = /\.[cm]?js$/

/** Vite 生态的资源写法带查询串（`./paths.svg?raw`），文件系统上没有这个尾巴，查存在性前剥掉 */
function withoutQuery(spec: string): string {
  const query = spec.indexOf('?')
  return query === -1 ? spec : spec.slice(0, query)
}

/**
 * 库的运行时入口（相对包目录）：`exports` 每个子路径指到的 js 文件（带 `*` 的通配子路径不算），没有 `exports` 时取 `main`；
 * 外加 `bin` 里的脚本。库可以只有子路径导出、包根没有入口
 */
export function libraryEntries(manifest: Record<string, unknown>): string[] {
  const entries = new Set<string>()
  const exported = manifest.exports
  if (isRecord(exported) && Object.keys(exported).some((key) => key.startsWith('.'))) {
    for (const [subpath, target] of Object.entries(exported)) {
      if (subpath.includes('*')) continue
      const file = runtimeTarget(target)
      if (file !== undefined) entries.add(file)
    }
  } else {
    const file = exportTarget(manifest, '.')
    if (file !== undefined) entries.add(file)
  }
  const bin = manifest.bin
  if (typeof bin === 'string') entries.add(bin)
  else if (isRecord(bin)) for (const script of Object.values(bin)) if (typeof script === 'string') entries.add(script)
  return [...entries].filter((file) => RUNTIME_MODULE.test(file))
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
  /** 提供方代码出口算出的映射；缺省时仅支持旧内核静态 importmap。 */
  browserImports?: Readonly<Record<string, string>>
}

interface WalkedModules {
  /** 走到的文件（绝对路径）→ 它的 import */
  modules: Map<string, ModuleImports>
  /** 指向不存在文件的相对 import、按语法读不下去的文件，已写成回执里的一句话 */
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
    let imports: ModuleImports
    try {
      imports = importsOf(code)
    } catch (err) {
      broken.push(`产物 ${relativeToPackage(pkgDir, file)} 按 JS 语法读不下去，找不全它的 import：${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    modules.set(file, imports)
    for (const spec of imports.relative) {
      const target = withoutQuery(spec).startsWith('/') ? withoutQuery(spec) : path.resolve(path.dirname(file), withoutQuery(spec))
      if (io.readText(target) === undefined) {
        broken.push(`${relativeToPackage(pkgDir, file)} 里 import 的 '${spec}' 指向的文件不在`)
        continue
      }
      // 非 js 的资源（css、图片、字体）只查在不在，不按 JS 语法解析——库的资源 import 交给用它的打包器处理
      if (RUNTIME_MODULE.test(target)) filesToRead.push(target)
    }
  }
  return { modules, broken }
}

function relativeToPackage(pkgDir: string, file: string): string {
  return path.relative(pkgDir, file).replaceAll('\\', '/')
}

/** 浏览器侧入口：模板 `build.ts` 用 esbuild 输出的 `dist/client.js` */
export const BROWSER_ENTRY = 'dist/client.js'

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
  const importmap = io.browserImports === undefined
    ? kernelImportmapNamesOf(pkgDir, io)
    : { names: new Set(Object.keys(io.browserImports)), problems: [] }
  const problems = [...importmap.problems]
  for (const { file, spec } of browserBare) {
    if (importmap.names.has(spec)) continue
    problems.push(
      `浏览器侧产物 ${relativeToPackage(pkgDir, file)} import 了 '${spec}'：页面 importmap 里没有这个名字` +
        `（只有 ${importmap.names.size === 0 ? '无' : [...importmap.names].join('、')}）。提供方写进 peer，从其 browser-imports 代码出口取外置名单；其余依赖打包进产物`,
    )
  }
  return problems
}

/** node 侧从哪些入口走起：插件只有 `exports["."]`（内核的 loader 按包名 import 它），库是 `libraryEntries` */
function nodeEntriesOf(manifest: Record<string, unknown>, plugin: boolean): { entries: string[]; problem?: string } {
  if (plugin) {
    const entry = exportTarget(manifest, '.')
    if (entry === undefined) return { entries: [], problem: '清单里没有 exports["."]（或 main），找不到 node 侧入口：内核的 loader 按包名 import 插件' }
    return { entries: [entry] }
  }
  const entries = libraryEntries(manifest)
  if (entries.length === 0) return { entries, problem: '清单的 exports（没有 exports 时是 main）与 bin 里没有一个指向 js 文件的入口，查不了产物' }
  return { entries }
}

/**
 * `plugin` 为 false（库、工具包）时只查相对 import 指向的文件在不在，从 exports 的每个 js 入口、bin 走起；
 * 包名 import 的两份名单只管插件：库的 import 由用它的插件打包时解析，不在 home 里按包名解析
 */
export function artifactProblems(pkgDir: string, manifest: Record<string, unknown>, plugin: boolean, io: ArtifactIo): string[] {
  const problems: string[] = []
  const nodeEntries = nodeEntriesOf(manifest, plugin)
  if (nodeEntries.problem !== undefined) problems.push(nodeEntries.problem)
  const node = walkModules(pkgDir, nodeEntries.entries.map((entry) => path.resolve(pkgDir, entry)), io)
  const clientFile = path.resolve(pkgDir, BROWSER_ENTRY)
  const providedFiles = Object.values(io.browserImports ?? {}).map(url => fileURLToPath(url)).filter(file => {
    const rel = path.relative(pkgDir, file)
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && !rel.startsWith(`node_modules${path.sep}`)
  })
  const browser = walkModules(pkgDir, [...new Set([...(io.readText(clientFile) === undefined ? [] : [clientFile]), ...providedFiles])], io)

  problems.push(...node.broken, ...browser.broken)
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
    return { names: new Set(), problems: [`内核包的页面入口读不到（${file}），算不出页面 importmap 里的名字：包目录的 node_modules 里没装内核包，peer 写上 ${KERNEL_PACKAGE}，再在仓根 pnpm install`] }
  }
  try {
    const names = importmapNamesOf(html)
    if (names === undefined) return { names: new Set(), problems: [`内核包的页面入口里没有 <script type="importmap">（${file}）`] }
    return { names: new Set(names), problems: [] }
  } catch (err) {
    return { names: new Set(), problems: [`内核包页面入口里的 importmap 不是合法 JSON（${file}）：${String(err)}`] }
  }
}
