import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { tailLines, withHomeRegistryAuth } from '@godcreator/gwb-plugin-manager'
import { PACK_TIMEOUT_MS, PUBLISH_TIMEOUT_MS, pnpmPlan, type DevDeps, type RunPlan, type RunResult } from './dev.js'
import { dirtyLines, type ReleaseDeps } from './release.js'
import type { TailwindCompiler, TailwindLookup } from './style-check.js'
import { removeTree, runCaptured } from './node-home-deps.js'
import { nodeFs } from './node-probe-deps.js'
import { VERSION } from './vocab.js'
import { runWithTreeTimeout, timeoutNote } from './node-process-tree.js'
import { collectBrowserImports } from './browser-providers.js'
import { githubGateway, githubTokenFromGit } from './node-github.js'

// DevDeps 与 ReleaseDeps 在这台机器上的实现：读写磁盘、启动进程、经 bin/cdp.mjs 连 CDP。
// 真机器操作的部分没有单元测试，判断都在 dev.ts 与 release.ts 里；distManifest、读 catalog 与找工作区的两个函数有测试

/** CDP 驱动脚本。从源码运行时本模块在 `src/`、从构建产物运行时在 `dist/`，都是包根下一层 */
export const CDP_ENTRY = fileURLToPath(new URL('../bin/cdp.mjs', import.meta.url))

/** 回执里输出留最后几行：报错在最后 */
const TAIL_LINES = 40

/** 退出码与 JSON 两样都要：命令没成功时驱动照样打印完整回执，只是退出码非零 */
async function runCdp(home: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; data: unknown; tail: string }> {
  let out = ''
  let err = ''
  const end = await runWithTreeTimeout(
    {
      command: process.execPath,
      args: [CDP_ENTRY, home, ...args],
      // 插件运行在 Electron 主进程里，process.execPath 是 electron.exe：不带 ELECTRON_RUN_AS_NODE 它会开一个窗口，而不是运行脚本
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // 驱动的路径一概不看工作目录；给一个无关的，别把内核的工作目录带进去
      cwd: os.tmpdir(),
    },
    timeoutMs,
    {
      stdout: (chunk) => {
        out += chunk.toString()
      },
      stderr: (chunk) => {
        err += chunk.toString()
      },
    },
  )
  switch (end.kind) {
    case 'failed-to-start':
      return { ok: false, data: undefined, tail: end.error }
    case 'timed-out':
      return { ok: false, data: undefined, tail: `${timeoutNote(timeoutMs, end.kill)}。${tailLines(err, TAIL_LINES)}` }
    case 'exited': {
      let data: unknown
      try {
        data = JSON.parse(out)
      } catch {
        data = undefined
      }
      return { ok: end.code === 0, data, tail: tailLines(err === '' ? out : err, TAIL_LINES) }
    }
  }
}

/** 发布用的清单。`[key: string]` 让别的字段原样带过去，一个都不丢 */
interface DistManifest {
  name: string
  version: string
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

/**
 * 工作区里各包当前的版本号（`workspace:` 依赖换成范围时用）。扫目录、不写死 `packages/`、`plugins/` 这类目录名；
 * 只扫两层，跳过 `node_modules`、`dist` 与点开头的目录。读不懂的 package.json 直接抛，写明是哪个文件
 */
export function workspaceVersions(repoDir: string, depth = 2): Map<string, string> {
  const versionsByName = new Map<string, string>()
  const walk = (dir: string, levelsLeft: number): void => {
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest)) {
      let doc: { name?: unknown; version?: unknown }
      try {
        doc = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
      } catch (err) {
        throw new Error(`工作区里的 ${manifest} 读不懂:${err instanceof Error ? err.message : String(err)}`)
      }
      if (typeof doc.name === 'string' && typeof doc.version === 'string') versionsByName.set(doc.name, doc.version)
    }
    if (levelsLeft <= 0) return
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      if (child.name.startsWith('.') || child.name === 'node_modules' || child.name === 'dist') continue
      walk(path.join(dir, child.name), levelsLeft - 1)
    }
  }
  walk(repoDir, depth)
  return versionsByName
}

/** 工作区里的包目录：仓根往下两层里有 package.json 的目录，跳过的目录与 `workspaceVersions` 相同 */
export function workspacePackageDirs(repoDir: string, depth = 2): string[] {
  const dirs: string[] = []
  const walk = (dir: string, levelsLeft: number): void => {
    if (fs.existsSync(path.join(dir, 'package.json'))) dirs.push(dir)
    if (levelsLeft <= 0) return
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      if (child.name.startsWith('.') || child.name === 'node_modules' || child.name === 'dist') continue
      walk(path.join(dir, child.name), levelsLeft - 1)
    }
  }
  walk(repoDir, depth)
  return dirs
}

/** 从包目录往上第一个有 `pnpm-workspace.yaml` 的目录：包在 `plugins/<名>/` 时，它依赖的库可能在 `packages/` 下 */
export function workspaceRootOf(pkgDir: string): string {
  let dir = path.resolve(pkgDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = path.dirname(dir)
    if (up === dir) throw new Error(`从 ${pkgDir} 往上找到盘根都没有 pnpm-workspace.yaml——这个包不在 pnpm 工作区里`)
    dir = up
  }
}

/** 工作区 `pnpm-workspace.yaml` 里的 catalog：catalog 名 → 包名 → 范围。默认 catalog 记在 `default` 下 */
export interface WorkspaceCatalogs {
  /** 读的是哪个文件，报错里写它 */
  file: string
  rangesByCatalog: Map<string, Map<string, string>>
}

const DEFAULT_CATALOG = 'default'

/**
 * 按 pnpm 的写法读 catalog：默认 catalog 是顶层 `catalog`（或 `catalogs.default`，两处都写 pnpm 自己拒），具名的是 `catalogs.<名>`。
 * 没有这两个键回空表；YAML 写坏了、或这两个键的形状不是「名字: 范围」的表，直接抛，写明文件
 */
export function workspaceCatalogsFromYaml(text: string, file: string): WorkspaceCatalogs {
  const doc = parseDocument(text)
  const [syntaxError] = doc.errors
  if (syntaxError !== undefined) throw new Error(`${file} 不是合法的 YAML:${syntaxError.message}`)
  const root: unknown = doc.toJS()
  const rangesByCatalog = new Map<string, Map<string, string>>()
  if (root === null || root === undefined) return { file, rangesByCatalog }
  if (!isPlainTable(root)) throw new Error(`${file} 的顶层要是「键: 值」`)
  if (root.catalogs !== undefined) {
    if (!isPlainTable(root.catalogs)) throw new Error(`${file} 的 catalogs 要是「catalog 名: 包表」`)
    for (const [catalogName, ranges] of Object.entries(root.catalogs)) {
      rangesByCatalog.set(catalogName, catalogRangesOf(ranges, `catalogs.${catalogName}`, file))
    }
  }
  if (root.catalog !== undefined) {
    if (rangesByCatalog.has(DEFAULT_CATALOG)) throw new Error(`${file} 里顶层 catalog 与 catalogs.default 都写了,默认 catalog 只能写一处`)
    rangesByCatalog.set(DEFAULT_CATALOG, catalogRangesOf(root.catalog, 'catalog', file))
  }
  return { file, rangesByCatalog }
}

/** 仓根 `pnpm-workspace.yaml` 里的 catalog；仓根由 `workspaceRootOf` 找，文件一定在 */
export function workspaceCatalogs(repoDir: string): WorkspaceCatalogs {
  const file = path.join(repoDir, 'pnpm-workspace.yaml')
  return workspaceCatalogsFromYaml(fs.readFileSync(file, 'utf8'), file)
}

function catalogRangesOf(value: unknown, key: string, file: string): Map<string, string> {
  if (!isPlainTable(value)) throw new Error(`${file} 的 ${key} 要是「包名: 范围」`)
  const ranges = new Map<string, string>()
  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== 'string') throw new Error(`${file} 的 ${key} 里 ${name} 的范围要是一条字符串`)
    ranges.set(name, range)
  }
  return ranges
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 版本号换成这次的；删掉 `scripts` 与 `devDependencies`；临时目录不在工作区里，pnpm 不会替换 `workspace:` 与 `catalog:`，在这里改写：
 * `workspace:` 换成 `^<工作区里的版本号>`，`catalog:` 换成工作区 catalog 里写的范围，找不到都抛；
 * 同一次发的包（`siblings`）在 dependencies 里一律换成给的写法（正式版给 `^新版本号`，开发版的打包给空表）
 */
export function distManifest(
  manifest: DistManifest,
  version: string,
  siblings: Record<string, string>,
  workspace: Map<string, string>,
  catalogs: WorkspaceCatalogs,
): DistManifest {
  const distributed: DistManifest = { ...manifest, version }
  delete distributed.scripts
  delete distributed.devDependencies
  if (distributed.dependencies !== undefined) {
    distributed.dependencies = publishableRanges('dependencies', distributed.dependencies, { dependent: manifest.name, siblings, workspace, catalogs })
  }
  if (distributed.peerDependencies !== undefined) {
    // peer 不写同一次发的准确版本号：写了就是逼消费方也换版本，peer 的意思本来是「你自己带一个」
    distributed.peerDependencies = publishableRanges('peerDependencies', distributed.peerDependencies, { dependent: manifest.name, siblings: {}, workspace, catalogs })
  }
  return distributed
}

type DependencyField = 'dependencies' | 'peerDependencies'

/** 改写一张依赖表要查的几处：同一次发的写法优先，其次工作区里的版本号与 catalog */
interface RangeSources {
  dependent: string
  siblings: Record<string, string>
  workspace: Map<string, string>
  catalogs: WorkspaceCatalogs
}

function publishableRanges(field: DependencyField, table: Record<string, string>, sources: RangeSources): Record<string, string> {
  const rewritten: Record<string, string> = {}
  for (const [name, range] of Object.entries(table)) rewritten[name] = publishableRange(field, name, range, sources)
  return rewritten
}

function publishableRange(field: DependencyField, name: string, range: string, sources: RangeSources): string {
  const sibling = sources.siblings[name]
  if (sibling !== undefined) return sibling
  if (range.startsWith('workspace:')) return `^${workspaceVersionOf(name, sources.workspace)}`
  if (range.startsWith('catalog:')) return catalogRangeOf(field, name, range, sources)
  return range
}

function workspaceVersionOf(name: string, workspace: Map<string, string>): string {
  const version = workspace.get(name)
  if (version === undefined) throw new Error(`依赖 ${name} 写的是 workspace:,可工作区里找不到这个包(只扫仓根往下两层)`)
  return version
}

/** `catalog:` 与 `catalog:default` 取默认 catalog，`catalog:<名>` 取 `catalogs.<名>` */
function catalogRangeOf(field: DependencyField, name: string, range: string, { dependent, catalogs }: RangeSources): string {
  const catalogName = range.slice('catalog:'.length) || DEFAULT_CATALOG
  const where = `${dependent} 的 ${field} 里 ${name} 写的是 ${range}`
  const ranges = catalogs.rangesByCatalog.get(catalogName)
  const catalogKey = catalogName === DEFAULT_CATALOG ? '顶层 catalog(或 catalogs.default)' : `catalogs.${catalogName}`
  if (ranges === undefined) throw new Error(`${where},可 ${catalogs.file} 里没有 ${catalogKey}`)
  const resolved = ranges.get(name)
  if (resolved === undefined) throw new Error(`${where},可 ${catalogs.file} 的 ${catalogKey} 里没有 ${name}`)
  return resolved
}

/** `files` 里组装发布内容时认不了的写法：否定式（`!` 开头）与通配。这里只按字面复制，悄悄漏掉文件的表现是「发出去了、装上了、新写的东西没生效」 */
export function unsupportedFileEntries(files: readonly string[]): string[] {
  return files.filter((one) => one.startsWith('!') || /[*?]/.test(one))
}

/**
 * `pnpm view <包>@<版本> version` 的结果 → 这个版本号在源上有没有。退出码 0 是有；pnpm 报没有这个版本或没有这个包（404）是没有；
 * 别的失败（源连不上、超时）问不出，直接抛
 */
export function publishedFromView(seen: { ok: boolean; tail: string }, spec: string, registry: string): boolean {
  if (seen.ok) return true
  if (/ERR_PNPM_PACKAGE_NOT_FOUND|ERR_PNPM_FETCH_404/.test(seen.tail)) return false
  throw new Error(`问不出 ${spec} 在 ${registry} 上有没有:\n${seen.tail}`)
}

/** 发布内容清单的 `publishConfig.registry` 换成发布目标，`publishConfig` 的别的字段原样；`pnpm publish` 按它发 */
export function withPublishRegistry(manifest: DistManifest, registry: string): DistManifest {
  const publishConfig = typeof manifest.publishConfig === 'object' && manifest.publishConfig !== null ? manifest.publishConfig : {}
  return { ...manifest, publishConfig: { ...publishConfig, registry } }
}

/**
 * `pnpm view` 钉住去问哪个源的参数。带范围的包名要用 `--config.<范围>:registry=`：pnpm 12 里 `--registry` 盖不过
 * `.npmrc` 的范围行（probes/2609251140_pnpm-publish-config-registry）
 */
export function registryPinArgs(spec: string, registry: string): string[] {
  const scope = /^(@[^/]+)\//.exec(spec)?.[1]
  return scope === undefined ? ['--registry', registry] : [`--config.${scope}:registry=${registry}`]
}

/**
 * 在临时目录组装发布内容（`files` 白名单里的东西、README、改写后的清单），交给 `action` 在那个目录里发布或打包，
 * 做完删掉临时目录；仓里的 package.json 一个字都不改。`deps` 是同一次发的包的依赖写法（正式版给 `^新版本号`，开发版不给）。
 * `publishRegistry` 只有正式版给：写进清单的 `publishConfig.registry`。
 * `action` 超时、进程树没终止掉时临时目录不删：它派生的 pnpm 可能还在读
 */
async function withStagedDistribution(
  input: { pkgDir: string; version: string; deps: Record<string, string>; publishRegistry?: string },
  action: (stage: string) => Promise<RunResult>,
): Promise<RunResult> {
  let manifest: DistManifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(input.pkgDir, 'package.json'), 'utf8')) as DistManifest
  } catch (err) {
    return { ok: false, tail: `读不动 ${input.pkgDir} 的 package.json:${String(err)}` }
  }
  const files = manifest.files ?? []
  if (files.length === 0) return { ok: false, tail: `${manifest.name} 的 package.json 里 files 是空的,不知道该带什么进分发包` }
  const unsupported = unsupportedFileEntries(files)
  if (unsupported.length > 0) {
    return {
      ok: false,
      tail: `${manifest.name} 的 files 里有否定式或通配(${unsupported.join('、')}),这里只认字面路径。写成实在的目录名与文件名`,
    }
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-stage-'))
  let stageMayStillBeRead = false
  try {
    const repoDir = workspaceRootOf(input.pkgDir)
    for (const rel of files) {
      const from = path.join(input.pkgDir, rel)
      if (!fs.existsSync(from)) return { ok: false, tail: `产物不在:${from}` }
      const to = path.join(stage, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      // cpSync 不用 copyFileSync：files 里可以是目录（dist、skills、template 都是）
      fs.cpSync(from, to, { recursive: true })
    }
    const readme = [path.join(input.pkgDir, 'README.md'), path.join(repoDir, 'README.md')].find((one) => fs.existsSync(one))
    if (readme !== undefined) fs.copyFileSync(readme, path.join(stage, 'README.md'))
    const distributed = distManifest(manifest, input.version, input.deps, workspaceVersions(repoDir), workspaceCatalogs(repoDir))
    const staged = input.publishRegistry === undefined ? distributed : withPublishRegistry(distributed, input.publishRegistry)
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(staged, null, 2) + '\n')
    const done = await action(stage)
    if (done.timedOut !== 'kill-failed') return done
    stageMayStillBeRead = true
    return { ...done, tail: `${done.tail}\n临时目录 ${stage} 没删:进程树没终止掉,pnpm 可能还在读它` }
  } catch (err) {
    return { ok: false, tail: String(err) }
  } finally {
    if (!stageMayStillBeRead) {
      // 不用 fs.rmSync 递归删：宿主的 Node 会跟进 junction，见 removeTree
      try {
        removeTree(stage)
      } catch {
        // 临时目录删不掉不影响这次的结论，留在 tmp 里
      }
    }
  }
}

/** 组装好的发布内容发到 `registry`（写在发布内容清单的 `publishConfig.registry` 里），标 latest */
async function publishStaged(input: { pkgDir: string; version: string; registry: string; ranges: Record<string, string>; pnpm: string; homeDir?: string }): Promise<RunResult> {
  const staging = { pkgDir: input.pkgDir, version: input.version, deps: input.ranges, publishRegistry: input.registry }
  const sent = await withStagedDistribution(staging, (stage) =>
    runWithHomeAuth(input.homeDir, pnpmPlan(['publish', '--no-git-checks', '--tag', 'latest'], stage, input.pnpm), PUBLISH_TIMEOUT_MS),
  )
  if (sent.timedOut !== 'kill-failed') return sent
  return { ...sent, tail: `${sent.tail}\n这一版可能照样发出去了——过一会儿用 pnpm view 查源上有没有这个号` }
}

/** 正式版的发布内容（同 `publishStaged`）打成包文件放进 `destination`，交给 Actions 去发；回新出现的那个包文件 */
async function packReleaseStaged(input: { pkgDir: string; version: string; registry: string; ranges: Record<string, string>; destination: string; pnpm: string }): Promise<{ ok: true; file: string } | { ok: false; tail: string }> {
  fs.mkdirSync(input.destination, { recursive: true })
  const before = new Set(fs.readdirSync(input.destination))
  const staging = { pkgDir: input.pkgDir, version: input.version, deps: input.ranges, publishRegistry: input.registry }
  const packed = await withStagedDistribution(staging, (stage) => runCaptured(pnpmPlan(['pack', '--pack-destination', input.destination], stage, input.pnpm), PACK_TIMEOUT_MS))
  if (!packed.ok) return { ok: false, tail: packed.tail }
  const added = fs.readdirSync(input.destination).filter((one) => !before.has(one) && one.endsWith('.tgz'))
  if (added.length !== 1) return { ok: false, tail: `pnpm pack 之后 ${input.destination} 里新出现 ${String(added.length)} 个包文件(${added.join('、')}),认不出是哪个` }
  return { ok: true, file: path.join(input.destination, added[0]!) }
}

/**
 * 组装好的发布内容打成包文件，放进 `destination`（目标 home 的 dev-packs）。pnpm pack 再按清单的 `files` 挑一遍文件，
 * 漏写的文件同样进不了包文件
 */
function packStaged(input: { pkgDir: string; version: string; destination: string; pnpm: string }): Promise<RunResult> {
  return withStagedDistribution({ pkgDir: input.pkgDir, version: input.version, deps: {} }, (stage) => {
    fs.mkdirSync(input.destination, { recursive: true })
    return runCaptured(pnpmPlan(['pack', '--pack-destination', input.destination], stage, input.pnpm), PACK_TIMEOUT_MS)
  })
}

/** 目录下（递归）全部文件的绝对路径；目录不在回空表。不进 `node_modules` */
export function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...filesUnder(full))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

/**
 * 被检查包构建样式用的那份 Tailwind。devkit 不自带：包的 dev 里有 `@tailwindcss/cli`（构建要用），
 * 从它在 pnpm 虚拟存储里的真实目录解析 `@tailwindcss/node`（cli 自己的依赖，就在它旁边），与构建用的是同一个版本
 */
export async function tailwindOf(pkgDir: string): Promise<TailwindLookup> {
  const cliLink = path.join(pkgDir, 'node_modules', '@tailwindcss', 'cli')
  if (!fs.existsSync(path.join(cliLink, 'package.json'))) {
    return {
      ok: false,
      error: `包目录 node_modules 里没有 @tailwindcss/cli（${cliLink}），样式检查找不到这个包构建样式用的 Tailwind：dev 里写上 @tailwindcss/cli（构建 dist/style.css 本来就要它），再在仓根 pnpm install`,
    }
  }
  const cliDir = fs.realpathSync(cliLink)
  let tailwindNode: unknown
  try {
    tailwindNode = createRequire(path.join(cliDir, 'package.json'))('@tailwindcss/node')
  } catch (err) {
    return { ok: false, error: `从 @tailwindcss/cli 的真实目录 ${cliDir} 解析不到 @tailwindcss/node（它是 cli 自己的依赖）：${err instanceof Error ? err.message : String(err)}` }
  }
  const compile = (tailwindNode as { compile?: unknown }).compile
  if (typeof compile !== 'function') return { ok: false, error: `${cliDir} 旁边的 @tailwindcss/node 没有导出 compile：Tailwind 版本不是 4？` }
  const compileWithBase = compile as (css: string, options: { base: string; onDependency: (file: string) => void }) => Promise<TailwindCompiler>
  return { ok: true, compile: (css, base) => compileWithBase(css, { base, onDependency: () => {} }) }
}

/** 「改一版看一版」在这台机器上的实现。`pnpm` 是命令开头找到的那个；停止与启动 home 要用到测试 home 的启停，由 index.ts 接上 */
export const devDepsWith = (pnpm: string, homeDir?: string): Omit<DevDeps, 'stopHome' | 'startHome'> => ({
  run: (plan: RunPlan, timeoutMs: number) => runWithHomeAuth(homeDir, plan, timeoutMs),
  cdp: runCdp,
  pack: (input) => packStaged({ ...input, pnpm }),
  readText: nodeFs.readText,
  exists: nodeFs.exists,
  filesUnder,
  tailwindOf,
  size(file) {
    return fs.statSync(file).size
  },
  slice(file, from) {
    const fd = fs.openSync(file, 'r')
    try {
      const end = fs.fstatSync(fd).size
      // 日志被轮转或清过,`from` 会大过现在的长度。那时从头读,别回一段空的
      const start = from > end ? 0 : from
      const buffer = Buffer.alloc(end - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pnpm,
})

/** git status 的上限。卡住说明 git 本身出了问题 */
const GIT_TIMEOUT_MS = 30_000

/** git 是 exe，直接启动。runCaptured 回的是 stdout 与 stderr 合在一起的最后几行，改动由 `dirtyLines` 按 porcelain 条目的样子认 */
async function gitStatusOf(repoDir: string): Promise<{ ok: true; dirty: string[] } | { ok: false; error: string }> {
  const out = await runCaptured({ command: 'git', args: ['status', '--porcelain=v1'], cwd: repoDir }, GIT_TIMEOUT_MS)
  if (!out.ok) return { ok: false, error: out.tail === '' ? 'git status 没成(git 不在?)' : out.tail }
  return { ok: true, dirty: dirtyLines(out.tail) }
}

async function headCommitOf(repoDir: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const out = await runCaptured({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: repoDir }, GIT_TIMEOUT_MS)
  const sha = /\b[0-9a-f]{40}\b/.exec(out.tail)?.[0]
  if (!out.ok || sha === undefined) return { ok: false, error: out.tail === '' ? 'git rev-parse HEAD 没成(git 不在?)' : out.tail }
  return { ok: true, sha }
}

/** 发正式版在这台机器上的实现。`pnpm` 是命令开头找到的那个；组装发布内容与开发版的打包共用 withStagedDistribution */
export const releaseDepsWith = (pnpm: string, homeDir?: string): ReleaseDeps => ({
  browserProviders: (pkgDir, manifest) => collectBrowserImports(pkgDir, manifest, {
    readText: nodeFs.readText,
    realpath: fs.realpathSync,
    importModule: (url) => import(`${url}?release=${Date.now()}`),
  }),
  run: (plan: RunPlan, timeoutMs: number) => runWithHomeAuth(homeDir, plan, timeoutMs),
  publish: (input) => publishStaged({ ...input, pnpm, ...(homeDir === undefined ? {} : { homeDir }) }),
  packRelease: (input) => packReleaseStaged({ ...input, pnpm }),
  headCommit: headCommitOf,
  github: githubGateway(githubTokenFromGit),
  tempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-release-')),
  removeDir: (dir) => removeTree(dir),
  now: () => Date.now(),
  published: async (spec, registry) =>
    publishedFromView(await runWithHomeAuth(homeDir, pnpmPlan(['view', spec, 'version', ...registryPinArgs(spec, registry)], os.tmpdir(), pnpm), 60_000), spec, registry),
  latest: async (pkg) => {
    const seen = await runWithHomeAuth(homeDir, pnpmPlan(['view', pkg, 'dist-tags.latest'], os.tmpdir(), pnpm), 60_000)
    if (!seen.ok) return undefined
    const lines = seen.tail.split(/\r?\n/).map((line) => line.trim())
    return lines.reverse().find((line) => VERSION.test(line))
  },
  gitStatus: gitStatusOf,
  readText: nodeFs.readText,
  realpath: fs.realpathSync,
  exists: nodeFs.exists,
  filesUnder,
  tailwindOf,
  workspacePackageDirs: (repoDir) => workspacePackageDirs(repoDir),
  pnpm,
})

/** The initiating home owns authentication, including bootstrap installs into a newly created home. */
export function runWithHomeAuth(homeDir: string | undefined, plan: RunPlan, timeoutMs: number): Promise<RunResult> {
  if (homeDir === undefined || !/^pnpm(?:\.exe)?$/i.test(path.basename(plan.command))) return runCaptured(plan, timeoutMs)
  return withHomeRegistryAuth(plan.command, homeDir, ({ env }) => runCaptured({ ...plan, env }, timeoutMs), plan.env ?? process.env, plan.cwd)
}
