import fs from 'node:fs'
import path from 'node:path'
import { packageNameOf } from './artifact-check.js'
import type { RunResult } from './dev.js'
import { isRecord } from './vocab.js'

/** 模板窗格用到的 shadcn 官方组件：建仓与加插件写完文件后，在插件包目录经官方 CLI 添加，模板里不带组件文件 */
export const TEMPLATE_COMPONENTS = ['button']

/** 组件文件所在目录，相对插件包根：`template/pkg/components.json` 的 `aliases.ui` 按两份 tsconfig 的 `@/` 别名解析到这里 */
export const COMPONENTS_UI_DIR = 'src/client/components/ui'

/** 一次 pnpm 调用的上限：dlx 第一次要下载 CLI，CLI 装组件依赖时整个 workspace 装一遍 */
export const COMPONENT_STEP_TIMEOUT_MS = 600_000

/** 在插件包目录运行一条 pnpm 命令（参数不含 pnpm 本身）到结束 */
export type PnpmInPluginDir = (args: string[]) => Promise<RunResult>

/** `--yes` 跳过确认；子进程的 stdin 是 ignore，CLI 真要提问时拿到 EOF 直接失败，不会挂到超时 */
export function shadcnAddArgs(components: readonly string[]): string[] {
  return ['dlx', 'shadcn@latest', 'add', ...components, '--yes']
}

/** 模块头部的 `import … from "x"`、`import "x"`、`export … from "x"`。组件文件是 TSX，按 JS 语法的词法器读不了 JSX，这里只认语句开头 */
const IMPORT_STATEMENT = /^[ \t]*(?:import|export)\b[^;'"()=]*?\bfrom[ \t]*["']([^"']+)["']|^[ \t]*import[ \t]*["']([^"']+)["']/gm

/** 一份组件源码按包名 import 了哪些包：相对路径、`@/` 别名、`node:` 内置模块不算 */
export function importedPackagesOf(source: string): string[] {
  const packages = new Set<string>()
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    const spec = match[1] ?? match[2] ?? ''
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('node:')) continue
    packages.add(packageNameOf(spec))
  }
  return [...packages].sort()
}

interface DependencyTables {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function dependencyTablesOf(manifest: unknown): DependencyTables {
  if (!isRecord(manifest)) throw new Error('package.json 不是一个对象')
  const table = (key: string): Record<string, string> | undefined => {
    const value = manifest[key]
    if (value === undefined) return undefined
    if (!isRecord(value) || Object.values(value).some((range) => typeof range !== 'string')) throw new Error(`package.json 的 ${key} 不是「包名: 范围」的表`)
    return value as Record<string, string>
  }
  const tables: DependencyTables = {}
  const dependencies = table('dependencies')
  const devDependencies = table('devDependencies')
  const peerDependencies = table('peerDependencies')
  if (dependencies !== undefined) tables.dependencies = dependencies
  if (devDependencies !== undefined) tables.devDependencies = devDependencies
  if (peerDependencies !== undefined) tables.peerDependencies = peerDependencies
  return tables
}

/**
 * CLI 跑完之后要交给 `pnpm add -D` 的包：`dependencies` 里的逐个带原范围挪过去（模板的清单没有 `dependencies`，
 * 这里有的都是 CLI 写的），组件 import 了、三张表里都没有的补上（CLI 不一定装全）。组件打包进 `client.js`，一律写 dev
 */
export function devDependencySpecs(manifest: unknown, imported: readonly string[]): string[] {
  const tables = dependencyTablesOf(manifest)
  const moved = Object.entries(tables.dependencies ?? {}).map(([name, range]) => `${name}@${range}`)
  const declared = new Set([...Object.keys(tables.dependencies ?? {}), ...Object.keys(tables.devDependencies ?? {}), ...Object.keys(tables.peerDependencies ?? {})])
  const missing = imported.filter((name) => !declared.has(name))
  return [...moved.sort(), ...[...missing].sort()]
}

/** 挪完之后还不对的地方：`dependencies` 里还有包、组件 import 的包不在 dev 与 peer 里。空表就是对了 */
export function componentDependencyProblems(manifest: unknown, imported: readonly string[]): string[] {
  const tables = dependencyTablesOf(manifest)
  const problems = Object.keys(tables.dependencies ?? {}).map((name) => `${name} 还在 dependencies 里，要在 devDependencies`)
  const available = new Set([...Object.keys(tables.devDependencies ?? {}), ...Object.keys(tables.peerDependencies ?? {})])
  for (const name of imported) if (!available.has(name)) problems.push(`组件 import 了 ${name}，devDependencies 里没有`)
  return problems
}

export type ComponentsOutcome = { ok: true; components: string[] } | { ok: false; error: string }

/** 组件这一步没成时的回执：插件的其余文件已经写好、不回滚，写明怎么手动补完 */
export function componentsStepFailure(pluginDir: string, error: string): string {
  return (
    `插件文件已写到 ${pluginDir}，添加 shadcn 组件这一步没成：${error}\n` +
    `修好原因后在 ${pluginDir} 运行 pnpm ${shadcnAddArgs(TEMPLATE_COMPONENTS).join(' ')}，` +
    '再照说明书 gwb-shell 的「接入 shadcn 组件」把 CLI 写进 dependencies 的包、组件 import 了却没装的包 pnpm add -D 进 devDependencies'
  )
}

/**
 * 在插件包目录用 shadcn 官方 CLI 添加 `TEMPLATE_COMPONENTS`，再把组件依赖整理进 devDependencies（一次 `pnpm add -D`）。
 * 失败时回 error，写明卡在哪一步；插件的其余文件此时已经写好，由调用方在回执里说明
 */
export async function addTemplateComponents(pluginDir: string, pnpm: PnpmInPluginDir): Promise<ComponentsOutcome> {
  const addArgs = shadcnAddArgs(TEMPLATE_COMPONENTS)
  const added = await pnpm(addArgs)
  if (!added.ok) return { ok: false, error: `pnpm ${addArgs.join(' ')} 没成：\n${added.tail}` }

  const componentFiles = TEMPLATE_COMPONENTS.map((component) => path.join(pluginDir, COMPONENTS_UI_DIR, `${component}.tsx`))
  const absent = componentFiles.filter((file) => !fs.existsSync(file))
  if (absent.length > 0) {
    return { ok: false, error: `CLI 报成功，组件文件却不在 ${absent.join('、')}：看 components.json 的 aliases 与两份 tsconfig 的 @/ 别名。CLI 输出的最后几行：\n${added.tail}` }
  }
  const imported = [...new Set(componentFiles.flatMap((file) => importedPackagesOf(fs.readFileSync(file, 'utf8'))))].sort()

  const manifestPath = path.join(pluginDir, 'package.json')
  const specs = devDependencySpecs(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), imported)
  if (specs.length > 0) {
    const addDevArgs = ['add', '-D', ...specs]
    const moved = await pnpm(addDevArgs)
    if (!moved.ok) return { ok: false, error: `组件已添加，整理依赖的 pnpm ${addDevArgs.join(' ')} 没成：\n${moved.tail}` }
  }
  const problems = componentDependencyProblems(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), imported)
  if (problems.length > 0) return { ok: false, error: `组件已添加，依赖整理完还不对：${problems.join('；')}` }
  return { ok: true, components: [...TEMPLATE_COMPONENTS] }
}
