import { builtinModules } from 'node:module'
import path from 'node:path'
import { isRecord } from './vocab.js'

/**
 * 发版前的构建产物检查，纯函数：读盘只经调用方给的 `readText`，测试里给一张假文件表。
 *
 * **哪些文件算 node 侧、哪些算浏览器侧**，照模板生成的插件包的构建约定
 * （`template/pkg/build.ts.tpl` 与 `package.json.tpl` 的 `exports`）：
 *
 * - node 侧：`exports["."]` 的运行时入口（条件按对象里的顺序取第一个 `node` / `import` /
 *   `module-sync` / `default`；清单没有 `exports` 时取 `main`），加上从它顺着相对 import 走得到的
 *   文件。内核的 loader 按包名 import 插件，加载的就是这些。模板里是 tsc 从 `src/index.ts` 输出的
 *   `dist/index.js`
 * - 浏览器侧：`dist/client.js`（模板的 `build.ts` 用 esbuild 以 `platform: 'browser'` 输出的那个文件，
 *   node 侧用 `new URL('./client.js', import.meta.url)` 报给外壳），加上本包 `gwb.shared` 声明的子路径
 *   经 `exports` 指到的文件，再加上从它们顺着相对 import 走得到的文件
 * - 两边都走不到的文件不查：内核和页面都不会加载它
 *
 * 包名 import 指直接写包名、不带相对路径的 import。只认产物里的三种写法：行首的
 * `import … from '<名>'` / `export … from '<名>'` / `import '<名>'`（tsc 与 esbuild 输出的顶层 import
 * 都顶格写），以及非注释行里带字面量的 `import('<名>')`。
 */

/** 一个产物文件里的 import，按种类分开 */
export interface ModuleImports {
  /** 包名 import（含 `node:` 前缀的内置模块） */
  bare: string[]
  /** `./`、`../`、`/` 开头的 import */
  relative: string[]
  /** `import {} from '<名>'` / `export {} from '<名>'`：源码里 `import { type X }` 在 verbatimModuleSyntax 下留下的空 import */
  empty: string[]
}

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

const NODE_SIDE_PACKAGES = new Set(['electron', 'cordis'])

/** node 侧允许的包名 import：node 内置模块、`electron`、`cordis`（含它们的子路径） */
export function allowedOnNodeSide(spec: string): boolean {
  if (spec.startsWith('node:')) return true
  if (builtinModules.includes(spec)) return true
  return NODE_SIDE_PACKAGES.has(packageNameOf(spec))
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

/** `exports` 里某个子路径（`.`、`./react`）指到的运行时文件，相对包目录 */
export function exportTarget(manifest: Record<string, unknown>, subpath: string): string | undefined {
  const exported = manifest.exports
  if (exported === undefined) return subpath === '.' && typeof manifest.main === 'string' ? manifest.main : undefined
  const hasSubpaths = isRecord(exported) && Object.keys(exported).some((key) => key.startsWith('.'))
  if (!hasSubpaths) return subpath === '.' ? runtimeTarget(exported) : undefined
  return runtimeTarget((exported as Record<string, unknown>)[subpath])
}

/** 清单里 `gwb.shared` 声明的名字。形状照内核计算 importmap 的那段：键是包名，值是非空的 `exports` 子路径 */
export function sharedDeclarations(manifest: unknown): Record<string, string> {
  if (!isRecord(manifest) || !isRecord(manifest.gwb) || !isRecord(manifest.gwb.shared)) return {}
  const out: Record<string, string> = {}
  for (const [name, subpath] of Object.entries(manifest.gwb.shared)) {
    if (name !== '' && typeof subpath === 'string' && subpath !== '') out[name] = subpath
  }
  return out
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

function walkModules(pkgDir: string, entries: string[], io: ArtifactIo): WalkedModules {
  const modules = new Map<string, ModuleImports>()
  const broken: string[] = []
  const pending = [...entries]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (modules.has(file)) continue
    const code = io.readText(file)
    if (code === undefined) {
      broken.push(`产物 ${shown(pkgDir, file)} 不在：构建之后它该在`)
      continue
    }
    const imports = importsOf(code)
    modules.set(file, imports)
    for (const spec of imports.relative) {
      const target = spec.startsWith('/') ? spec : path.resolve(path.dirname(file), spec)
      if (io.readText(target) === undefined) {
        broken.push(`${shown(pkgDir, file)} 里 import 的 '${spec}' 不在：node 与浏览器都不补扩展名，相对 import 要写到带 .js 的文件名`)
        continue
      }
      pending.push(target)
    }
  }
  return { modules, broken }
}

function shown(pkgDir: string, file: string): string {
  return path.relative(pkgDir, file).replaceAll('\\', '/')
}

/** 浏览器侧入口：模板 `build.ts` 输出的 `dist/client.js` */
export const BROWSER_ENTRY = 'dist/client.js'

export interface ArtifactFindings {
  problems: string[]
  /** node 侧产物里有没有 import `cordis`（按值 import 才会留在产物里） */
  nodeImportsCordis: boolean
}

/**
 * 查一个被发包的构建产物。`plugin` 为 false（库、工具包）时只查空 import 与相对 import 指向的文件在不在；
 * 包名 import 的两份名单只管插件：库的 import 由用它的插件打包时解析，不在 home 里按包名解析。
 */
export function artifactFindings(pkgDir: string, manifest: Record<string, unknown>, plugin: boolean, io: ArtifactIo): ArtifactFindings {
  const problems: string[] = []
  const pkgName = typeof manifest.name === 'string' ? manifest.name : pkgDir

  const nodeEntry = exportTarget(manifest, '.')
  if (nodeEntry === undefined) problems.push('清单里没有 exports["."]（或 main），找不到 node 侧入口')
  const node = walkModules(pkgDir, nodeEntry === undefined ? [] : [path.resolve(pkgDir, nodeEntry)], io)

  const ownShared = sharedDeclarations(manifest)
  const browserEntries: string[] = []
  const clientFile = path.resolve(pkgDir, BROWSER_ENTRY)
  if (io.readText(clientFile) !== undefined) browserEntries.push(clientFile)
  for (const [name, subpath] of Object.entries(ownShared)) {
    const target = exportTarget(manifest, subpath)
    if (target === undefined) {
      problems.push(`gwb.shared 的 ${name} 指向 ${subpath}，exports 里没有这个子路径`)
      continue
    }
    browserEntries.push(path.resolve(pkgDir, target))
  }
  const browser = walkModules(pkgDir, browserEntries, io)

  problems.push(...node.broken, ...browser.broken)
  for (const [file, imports] of [...node.modules, ...browser.modules]) {
    for (const spec of imports.empty) {
      problems.push(`${shown(pkgDir, file)} 里有空 import：import {} from '${spec}'。源码里只引类型的写成 import type { X }，不写 import { type X }`)
    }
  }

  let nodeImportsCordis = false
  for (const imports of node.modules.values()) if (imports.bare.some((spec) => packageNameOf(spec) === 'cordis')) nodeImportsCordis = true

  if (!plugin) return { problems, nodeImportsCordis }

  for (const [file, imports] of node.modules) {
    for (const spec of imports.bare.filter((one) => !allowedOnNodeSide(one))) {
      problems.push(
        `node 侧产物 ${shown(pkgDir, file)} import 了 '${spec}'：node 侧只能 import node 内置模块、electron、cordis。` +
          `另一个插件改成只 import 类型、运行时经 inject 与命令使用；自用的库打包进产物`,
      )
    }
  }

  const browserBare = [...browser.modules].flatMap(([file, imports]) => imports.bare.map((spec) => ({ file, spec })))
  if (browserBare.length === 0) return { problems, nodeImportsCordis }
  const importmap = importmapNamesOf(pkgDir, manifest, ownShared, io)
  problems.push(...importmap.problems)
  for (const { file, spec } of browserBare) {
    if (importmap.names.has(spec)) continue
    problems.push(
      `浏览器侧产物 ${shown(pkgDir, file)} import 了 '${spec}'：${pkgName} 用得到的 importmap 里没有这个名字` +
        `（现有 ${importmap.names.size === 0 ? '无' : [...importmap.names].join('、')}）。打包进产物，或者从声明它的插件那里取外置名单`,
    )
  }
  return { problems, nodeImportsCordis }
}

/**
 * 本包能用的 importmap 名字：本包自己 `gwb.shared` 的键，加上本包依赖到的（dependencies、devDependencies、
 * peerDependencies）、声明了 `gwb.shared` 的包的键。依赖的清单从被发包自己的 `node_modules` 现读——pnpm 把
 * 直接依赖链接在那里；读不到就是没装，报出来，不猜。
 */
function importmapNamesOf(
  pkgDir: string,
  manifest: Record<string, unknown>,
  ownShared: Record<string, string>,
  io: ArtifactIo,
): { names: Set<string>; problems: string[] } {
  const names = new Set(Object.keys(ownShared))
  const problems: string[] = []
  const dependencyNames = new Set<string>()
  for (const table of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]) {
    if (isRecord(table)) for (const name of Object.keys(table)) dependencyNames.add(name)
  }
  for (const name of dependencyNames) {
    const file = path.join(pkgDir, 'node_modules', ...name.split('/'), 'package.json')
    const text = io.readText(file)
    if (text === undefined) {
      problems.push(`依赖 ${name} 的清单读不到（${file}），算不出 importmap 里的名字：先在仓根 pnpm install`)
      continue
    }
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch (err) {
      problems.push(`依赖 ${name} 的清单不是合法 JSON（${file}）：${String(err)}`)
      continue
    }
    for (const shared of Object.keys(sharedDeclarations(doc))) names.add(shared)
  }
  return { names, problems }
}
