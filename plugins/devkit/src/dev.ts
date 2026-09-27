import path from 'node:path'
import { INSTALL_COMMAND, KERNEL_PACKAGE, LIST_COMMAND, UPDATE_COMMAND } from '@godcreator/gwb-plugin-manager'
import { styleProblems, type StyleCheckIo } from './style-check.js'
import { isRecord, packageManifestOf, VERSION } from './vocab.js'

/** 日常用的那个 home 的名字。开发版装进它就是悄悄换了日常代码，所以当场拒；删它要 `force` */
export const DAILY_HOME = 'default'

/** 目标 home 的日志。跟着 home 走，每个 home 的日志是分开的 */
export const LOG_FILE = 'gwb.log'

/** 开发版的包文件放在目标 home 下的这个目录。只增不删：home 清单还引用着的包文件一删，这个 home 里之后的 pnpm add 全部失败 */
export const DEV_PACKS_DIR = 'dev-packs'

export const BUILD_TIMEOUT_MS = 300_000
export const PUBLISH_TIMEOUT_MS = 180_000
export const PACK_TIMEOUT_MS = 180_000
/** 一次 CDP 动作的上限。`reload` 还要等页面回来，所以给得比别的宽 */
export const CDP_TIMEOUT_MS = 120_000
/** 经页面调插件管理的 install / update：里面有一次 pnpm add 与逐条重新加载 */
export const PLUGIN_MANAGER_TIMEOUT_MS = 600_000

/** 取证时日志新增部分里最多回几行 */
export const LOG_TAIL_LINES = 40

/** 插件包的标记：`keywords` 里有它 */
export const PLUGIN_KEYWORD = 'gwb-plugin'

/** 重启之后问内核版本的那条命令：回执 `versions.kernel` 是运行中的内核自己报的 */
export const SHELL_ENV_COMMAND = 'shell.env'

/** 重启之后轮询 `shell.env` 的间隔与总上限 */
export const RESTART_POLL_MS = 1000
export const RESTART_TIMEOUT_MS = 90_000

/** 插件管理自己的条目在回执之后才重新加载：轮询 `plugin-manager.list` 的间隔与总上限 */
export const DEFERRED_POLL_MS = 500
export const DEFERRED_TIMEOUT_MS = 60_000

// ── 版本号 ────────────────────────────────────────────────────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * `<patch+1>-dev.<yyyyMMddHHmmss>`。开发版号只用来让每一版的包文件路径不同：版本号决定包文件名，包文件名决定
 * home 里的真实目录。同一秒跑两次撞到同一个包文件，当场拒
 */
export function devVersion(version: string, now: number): string {
  const match = VERSION.exec(version)
  if (match === null) throw new Error(`包清单里的版本号 "${version}" 不是 x.y.z(可带预发布段),算不出开发版号`)
  const [, major, minor, patch] = match
  const nowDate = new Date(now)
  const stamp = `${String(nowDate.getFullYear())}${pad(nowDate.getMonth() + 1)}${pad(nowDate.getDate())}${pad(nowDate.getHours())}${pad(nowDate.getMinutes())}${pad(nowDate.getSeconds())}`
  return `${String(major)}.${String(minor)}.${String(Number(patch) + 1)}-dev.${stamp}`
}

// ── 检查目标 ──────────────────────────────────────────────────────────────────

export type HomeGuard = { ok: true; home: string; name: string } | { ok: false; error: string }

/** 开发套件只支持 Windows：路径一律不分大小写比较 */
export function samePath(a: string, b: string): boolean {
  const normalized = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return normalized(a) === normalized(b)
}

/**
 * `home` 是页面自报的 home 目录（`bin/cdp.mjs` 连上时已核对过它报得出、名字就是点名的那个）。
 * `default` 当场拒；目标是自己所在的 home 就拒（重新加载条目会把正在运行的这条命令自己停掉）
 */
export function guardHome(home: string, ownHome: string): HomeGuard {
  const name = path.basename(home.replace(/[\\/]+$/, ''))
  if (name === DAILY_HOME) {
    return { ok: false, error: `目标是 ${DAILY_HOME},这是日常那份 home,开发版不进它——换个隔离 home(devkit.home.new)再来` }
  }
  if (samePath(home, ownHome)) {
    return {
      ok: false,
      error: `目标就是本插件自己所在的这个 home(${home})——重新加载条目会把正在运行的这条命令自己停掉。换 devkit 自己用另一条路:发正式版,再 plugin-manager.update {"all":true}`,
    }
  }
  return { ok: true, home, name }
}

// ── 包清单 ────────────────────────────────────────────────────────────────────

export interface Manifest {
  name: string
  version: string
  files?: string[]
  /** `keywords` 里有 `gwb-plugin` */
  plugin: boolean
}

/** `files` 里必须真在磁盘上的产物。否定式与通配不算（拿去查存在必然「不在」）：组装发布内容时这两种直接拒，见 node-dev-deps 的 `unsupportedFileEntries` */
export function literalArtifacts(files: readonly string[]): string[] {
  return files.filter((one) => !one.startsWith('!') && !/[*?]/.test(one))
}

/** 缺 name/version 就不是个能装的包 */
export function parseManifest(text: string | undefined): Manifest | undefined {
  const doc = packageManifestOf(text)
  if (doc === undefined) return undefined
  const { name, version, files, keywords } = doc
  return {
    name,
    version,
    ...(Array.isArray(files) ? { files: files.filter((one): one is string => typeof one === 'string') } : {}),
    plugin: Array.isArray(keywords) && keywords.includes(PLUGIN_KEYWORD),
  }
}

/** `pnpm pack` 的默认文件名：`@scope/name` 1.2.3 → `scope-name-1.2.3.tgz` */
export function packFileName(pkg: string, version: string): string {
  return `${pkg.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}

/** 交给插件管理的写法。相对 home：清单里不写 home 所在位置，路径里的空白也不会被插件管理的写法检查拒掉 */
export function devPackSpec(fileName: string): string {
  return `file:./${DEV_PACKS_DIR}/${fileName}`
}

// ── 条目 ──────────────────────────────────────────────────────────────────────

export interface EntryView {
  entryId: string
  active: boolean
}

/** `plugin-manager.list` 回执的 `data` 是包的数组，取这个包的全部条目：同一个包可能有两条条目 */
export function entriesOf(data: unknown, pkg: string): EntryView[] {
  const packages = Array.isArray(data) ? data : []
  for (const packageView of packages) {
    if (!isRecord(packageView) || packageView.pkg !== pkg) continue
    const entries = Array.isArray(packageView.entries) ? packageView.entries : []
    return entries
      .filter(isRecord)
      .filter((one): one is Record<string, unknown> & { entryId: string } => typeof one.entryId === 'string' && one.entryId !== '')
      .map((one) => ({ entryId: one.entryId, active: one.active === true }))
  }
  return []
}

// ── 装进目标 home ─────────────────────────────────────────────────────────────

/** 目标 home 自己的依赖清单（pnpm 的项目清单，home 根下）。本包只读它，写它的是插件管理启动的 pnpm */
export const HOME_MANIFEST = 'package.json'

/** home 里装上的那份包清单在哪。scope 包是两层目录 */
export function installedManifest(homeDir: string, pkg: string): string {
  return path.join(homeDir, 'node_modules', ...pkg.split('/'), 'package.json')
}

export interface InstalledRow {
  pkg: string
  /** 这次打包的版本号 */
  expected: string
  /** home 里实际装上的版本号。读不到是 null */
  actual: string | null
}

/** 读 `node_modules` 下装好的那份 package.json：清单写的是「要什么」、锁写的是「解析成什么」，只有它说的是「import 的到底是谁」 */
export function checkInstalled(
  homeDir: string,
  shipped: readonly { pkg: string; version: string }[],
  readText: (file: string) => string | undefined,
): { rows: InstalledRow[]; wrong: InstalledRow[] } {
  const rows = shipped.map((one) => ({
    pkg: one.pkg,
    expected: one.version,
    actual: parseManifest(readText(installedManifest(homeDir, one.pkg)))?.version ?? null,
  }))
  return { rows, wrong: rows.filter((row) => row.actual !== row.expected) }
}

/** 装上的版本号对不上时那句话 */
export function installedNote(homeName: string, wrong: readonly InstalledRow[]): string {
  const lines = wrong.map((row) =>
    row.actual === null
      ? `${row.pkg}:这次打包的是 ${row.expected},${homeName} 的 node_modules 里读不到它的 package.json`
      : `${row.pkg}:这次打包的是 ${row.expected},${homeName} 里实际装上的是 ${row.actual}`,
  )
  return `新代码没进 ${homeName}——${lines.join(';')}。重新加载拿到的会是装上的那一版,别当它验过了`
}

/** 目标 home 清单的 `dependencies`。读不到、不是 JSON、没有这一格都当场报错：这不像一个装过插件的 home */
export function homeDependenciesOf(text: string | undefined, manifestFile: string): { ok: true; dependencies: Record<string, unknown> } | { ok: false; error: string } {
  if (text === undefined) return { ok: false, error: `读不到 ${manifestFile}——这不像一个装过插件的 home` }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `${manifestFile} 不是合法 JSON:${String(err)}` }
  }
  if (!isRecord(doc) || !isRecord(doc.dependencies)) return { ok: false, error: `${manifestFile} 里没有 dependencies——这不像一个装过插件的 home` }
  return { ok: true, dependencies: doc.dependencies }
}

export interface PlannedDevPackage {
  pkgDir: string
  manifest: Manifest
  version: string
  /** 包文件名，放在目标 home 的 `dev-packs` 下 */
  packFile: string
}

/** 交给插件管理的两种调用：已在 home 的 dependencies 里的包合成一条 update，不在的插件逐个 install */
export interface PluginManagerCalls {
  specs: Record<string, string>
  installs: { pkg: string; spec: string }[]
}

/**
 * 已在 dependencies 里的走 `plugin-manager.update {specs}`（内核包也走这条；cordis 由插件管理照装上的内核包 peer 自己对齐，specs 里不放）；
 * 不在的插件走 `plugin-manager.install`（新建一条条目）；内核包不在目标 home 里直接拒
 */
export function pluginManagerCallsFor(
  planned: readonly PlannedDevPackage[],
  homeDependencies: Readonly<Record<string, unknown>>,
): { ok: true; calls: PluginManagerCalls } | { ok: false; error: string } {
  const specs: Record<string, string> = {}
  const installs: { pkg: string; spec: string }[] = []
  for (const one of planned) {
    const spec = devPackSpec(one.packFile)
    if (homeDependencies[one.manifest.name] !== undefined) {
      specs[one.manifest.name] = spec
    } else if (one.manifest.name === KERNEL_PACKAGE) {
      return { ok: false, error: `目标 home 的 dependencies 里没有内核包 ${KERNEL_PACKAGE}——内核没装进这个 home,开发版的内核包换不进去。用 devkit.home.new 开的 home 都装着它` }
    } else {
      installs.push({ pkg: one.manifest.name, spec })
    }
  }
  return { ok: true, calls: { specs, installs } }
}

// ── 日志 ──────────────────────────────────────────────────────────────────────

/** 从这个内核版本起 `gwb.log` 一行一个 JSON；更早的内核写的是文本行 */
export const JSONL_LOG_KERNEL = '0.10.0'

/** `gwb.log` 一行的五个键，顺序是内核定的 */
const LOG_RECORD_KEYS = ['ts', 'level', 'source', 'name', 'msg'] as const
type LogRecord = Record<(typeof LOG_RECORD_KEYS)[number], string>

/** 报错时带上认不出的那一行的前多少个字符 */
const BAD_LINE_HEAD_CHARS = 60

export type LogScan = { ok: true; errors: string[]; warns: string[] } | { ok: false; error: string }

/** 一行解析成一条记录；认不出时回的是原因 */
function parseLogLine(line: string): LogRecord | string {
  let doc: unknown
  try {
    doc = JSON.parse(line)
  } catch {
    return '不是 JSON'
  }
  if (!isRecord(doc)) return '不是 JSON 对象'
  const missingKey = LOG_RECORD_KEYS.find((key) => typeof doc[key] !== 'string')
  if (missingKey !== undefined) return `缺字符串字段 ${missingKey}`
  return doc as LogRecord
}

/** 给人看的一行：`<ts> <level> <name> <正文第一行>`，堆栈之类的后续行不进回执 */
function displayLineOf(record: LogRecord): string {
  const [firstLine] = record.msg.split(/\r?\n/, 1)
  return `${record.ts} ${record.level} ${record.name} ${firstLine ?? ''}`
}

/**
 * 读 `gwb.log` 基线之后新增的部分：一行一个 JSON，每行以换行结尾。有一行认不出就整段不判，直接报错。
 * 只把 error 算失败，warn 另报：插件启动时 warn 一句「某个可选服务不在」是常态，算成失败这条命令就天天红，人很快学会无视它
 */
export function errorLines(tail: string): LogScan {
  const lines = tail.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const errors: string[] = []
  const warns: string[] = []
  for (const line of lines) {
    const record = parseLogLine(line)
    if (typeof record === 'string') {
      return {
        ok: false,
        error: `目标 home 的 gwb.log 不是一行一个 JSON——目标 home 的内核要 ${JSONL_LOG_KERNEL} 起。认不出的一行(${record})开头是:${line.slice(0, BAD_LINE_HEAD_CHARS)}`,
      }
    }
    if (record.level === 'error') errors.push(displayLineOf(record))
    else if (record.level === 'warn') warns.push(displayLineOf(record))
  }
  return { ok: true, errors: errors.slice(-LOG_TAIL_LINES), warns: warns.slice(-LOG_TAIL_LINES) }
}

// ── 注入的依赖 ────────────────────────────────────────────────────────────────

export interface RunPlan {
  command: string
  args: string[]
  cwd: string
  /** 子进程的整份环境；不给就用宿主进程的环境 */
  env?: Record<string, string | undefined>
}

/**
 * 直接启动 pnpm 的原生可执行文件（`locatePnpm` 找到并核对过版本的那个），不经 shell；用在插件仓、临时目录这些不是 home 的地方。
 * 插件仓里不关自动补装 peer：仓里开发靠它把 peer 里的内核包与插件装进 node_modules；在 home 里运行的 pnpm 见 `home.ts` 的 `pnpmAddPlan`
 */
export function pnpmPlan(args: string[], cwd: string, pnpm: string): RunPlan {
  return { command: pnpm, args, cwd }
}

/** 前台运行一条命令的结果：成没成加输出的最后几行 */
export interface RunResult {
  ok: boolean
  tail: string
  /**
   * 超时才有。`tree-killed`：整棵进程树已终止并确认都已退出；`kill-failed`：没能确认，它派生的子进程可能还在改磁盘，
   * 调用方别接着删临时目录
   */
  timedOut?: 'tree-killed' | 'kill-failed'
}

export interface DevDeps {
  /** 前台运行一条命令到结束；超时终止整棵进程树 */
  run(plan: RunPlan, timeoutMs: number): Promise<RunResult>
  /** 对目标 home 的页面执行一个 `devkit.cdp` 动作，回它打印的 JSON。按 home 名调用、启动子进程运行 */
  cdp(home: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; data: unknown; tail: string }>
  /** 在临时目录组装发布内容（与发正式版同一套组装），`pnpm pack` 到 `destination` 目录。不改仓里任何文件 */
  pack(input: { pkgDir: string; version: string; destination: string }): Promise<{ ok: boolean; tail: string }>
  readText(file: string): string | undefined
  exists(target: string): boolean
  filesUnder: StyleCheckIo['filesUnder']
  tailwindOf: StyleCheckIo['tailwindOf']
  /** 文件现在多大。取日志基线用 */
  size(file: string): number
  /** 从某个字节读到末尾。取日志新增部分用 */
  slice(file: string, from: number): string
  now(): number
  /** 等一会儿。轮询时用 */
  sleep(ms: number): Promise<void>
  /** 停掉目标 home 的进程，再用同一个 home 启动。主进程里的内核换不掉，内核包换了版本只有重启才生效 */
  restartHome(home: string): Promise<{ ok: true; note: string } | { ok: false; error: string }>
  /** pnpm 的可执行文件：命令开头 `locatePnpm` 找到并核对过版本的那个 */
  pnpm: string
}

// ── 一次流程 ──────────────────────────────────────────────────────────────────

export interface DevInput {
  /** 目标 home 的名字。只认名字：端口是按记录查的，每次连上都要拿页面自报的名字核对 */
  home: string
  /** 仓根。构建在这里运行 */
  repoDir: string
  /** 要装的包目录，相对仓根。至少一个，命令入口 `packagesArgOf` 查过 */
  packages: string[]
  /** 刷新之后等页面上这个选择器出现才算刷回来了。不给就只等 readyState */
  waitFor?: string
  /** 本插件自己所在的 home 目录。目标是它就拒 */
  ownHome: string
}

export interface ShippedPackage {
  pkg: string
  version: string
  dir: string
  /** 包文件的绝对路径，在目标 home 的 `dev-packs` 下 */
  packFile: string
  /** 经哪条命令装进目标 home：已在 dependencies 里的走 update，不在的插件走 install */
  via: 'update' | 'install'
  /** install 新建的条目 */
  entryId?: string
}

/** 这次装了内核包时：重启了目标 home，页面上报的内核版本就是这次打包的版本号 */
export interface KernelRestart {
  version: string
  restart: string
}

export interface DevReport {
  home: string
  homeName: string
  shipped: ShippedPackage[]
  /** `plugin-manager.update` 的回执原样。这次没有已装的包就没有这一格 */
  update?: unknown
  /** 整页重新加载的结果。装了内核包时没有这一格，重启的结果在 `kernel` */
  reload?: unknown
  kernel?: KernelRestart
  /** 取证：该运行的条目在不在运行、日志新增部分里有没有新错 */
  evidence: Evidence
}

export interface Evidence {
  ok: boolean
  /** 逐包：这次打包的版本号与 home 里实际装上的版本号 */
  installed: InstalledRow[]
  entries: { pkg: string; entryId: string; active: boolean }[]
  dead: string[]
  errors: string[]
  warns: string[]
  note: string
}

export type DevOutcome = { ok: true; data: DevReport } | { ok: false; error: string; data?: unknown }

/** `devkit.cdp <名> cmd <命令> <参数>` 把工作台那条命令的回执原样放在这个字段里 */
const RECEIPT = '回执'

/** 从 cdp 打印的 JSON 里取出工作台命令的回执 */
function receiptOf(data: unknown): { ok: boolean; data: unknown; error?: string } {
  const raw = isRecord(data) ? data[RECEIPT] : undefined
  if (!isRecord(raw)) return { ok: false, data: raw, error: '这张页没回一张认得出的回执——它可能不是工作台的外壳页' }
  return {
    ok: raw.ok === true,
    data: raw.data,
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  }
}

/** 经 CDP 在目标页面里调一条工作台命令，取回它的回执 */
async function runCommandOnPage(home: string, command: string, timeoutMs: number, deps: DevDeps, args?: unknown): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const cdpArgs = ['cmd', command, ...(args === undefined ? [] : [JSON.stringify(args)])]
  return receiptOf((await deps.cdp(home, cdpArgs, timeoutMs)).data)
}

type Failure = { ok: false; error: string; data?: unknown }

/** 驱动的 `home` 动作：连上时核对页面自报的 home 就是点名的那个（核对不过退出码非零），回执里带着它的绝对路径 */
async function probeTargetHome(input: DevInput, deps: DevDeps): Promise<Failure | { ok: true; home: string; name: string }> {
  const probe = await deps.cdp(input.home, ['home'], CDP_TIMEOUT_MS)
  if (!probe.ok) return { ok: false, error: `连不上 ${input.home}:${probe.tail}` }
  if (!isRecord(probe.data) || typeof probe.data.home !== 'string') {
    return { ok: false, error: `${input.home} 的驱动回执里没有 home 路径:${JSON.stringify(probe.data)}` }
  }
  return guardHome(probe.data.home, input.ownHome)
}

/**
 * 每个包：清单读得出、`files` 里的产物都在、是插件或内核包、
 * 这次的包文件在目标 home 里还不存在（同一路径覆盖写，pnpm 全部退出码 0 但装着旧代码）
 */
function planDevPackages(input: DevInput, homeDir: string, deps: DevDeps): Failure | PlannedDevPackage[] {
  const planned: PlannedDevPackage[] = []
  for (const rel of input.packages) {
    const pkgDir = path.resolve(input.repoDir, rel)
    const manifest = parseManifest(deps.readText(path.join(pkgDir, 'package.json')))
    if (manifest === undefined) {
      return { ok: false, error: `${pkgDir} 下没有能读的 package.json(或缺 name/version)——包目录给的是相对仓根的路径` }
    }
    const missing = literalArtifacts(manifest.files ?? []).filter((one) => !deps.exists(path.join(pkgDir, one)))
    if (missing.length > 0) {
      return { ok: false, error: `${manifest.name} 的产物不全,没打包:${missing.join('、')} 不在。仓根 pnpm build 刚跑过还缺,多半是 files 白名单里那一项根本没人生成` }
    }
    const isKernel = manifest.name === KERNEL_PACKAGE
    if (!isKernel && !manifest.plugin) {
      return { ok: false, error: `${manifest.name} 的 keywords 里没有 ${PLUGIN_KEYWORD},不是插件也不是内核包:库打包进用它的插件,不单独装进 home。packages 里只给插件与内核包的目录` }
    }
    const version = devVersion(manifest.version, deps.now())
    const packFile = packFileName(manifest.name, version)
    const packPath = path.join(homeDir, DEV_PACKS_DIR, packFile)
    if (deps.exists(packPath)) {
      return { ok: false, error: `${packPath} 已经在了:同一路径覆盖写,pnpm 退出码 0 却装着旧代码。同一秒里跑了两次的话,过一秒再来` }
    }
    planned.push({ pkgDir, manifest, version, packFile })
  }
  return planned
}

/** 构建之后、打包之前：带界面插件的样式检查，所有包的问题一次列全 */
async function styleCheckFailure(planned: readonly PlannedDevPackage[], homeName: string, deps: DevDeps): Promise<Failure | undefined> {
  const failed: { pkg: string; problems: string[] }[] = []
  for (const one of planned) {
    const problems = await styleProblems(one.pkgDir, one.manifest, deps)
    if (problems.length > 0) failed.push({ pkg: one.manifest.name, problems })
  }
  if (failed.length === 0) return undefined
  const problemCount = failed.reduce((sum, one) => sum + one.problems.length, 0)
  const blocks = failed.map((one) => `${one.pkg}:\n${one.problems.map((line) => `  - ${line}`).join('\n')}`)
  return {
    ok: false,
    error: `构建之后的样式检查没过(${String(failed.length)} 个包 ${String(problemCount)} 条),停在打包之前,一个都没装进 ${homeName}。逐条改完再来:\n${blocks.join('\n')}`,
  }
}

/** 按给的顺序打包；pnpm 退出码 0 还要确认包文件就在算好的路径上，插件管理照这个路径装 */
async function packDevPackages(planned: readonly PlannedDevPackage[], calls: PluginManagerCalls, homeDir: string, deps: DevDeps): Promise<Failure | ShippedPackage[]> {
  const destination = path.join(homeDir, DEV_PACKS_DIR)
  const installedByInstall = new Set(calls.installs.map((one) => one.pkg))
  const packed: ShippedPackage[] = []
  for (const one of planned) {
    const packPath = path.join(destination, one.packFile)
    const done = await deps.pack({ pkgDir: one.pkgDir, version: one.version, destination })
    if (!done.ok) return { ok: false, error: `${one.manifest.name}@${one.version} 打包没成:\n${done.tail}`, data: { shipped: packed } }
    if (!deps.exists(packPath)) {
      return { ok: false, error: `pnpm pack 退出码 0,但 ${packPath} 不在——pnpm 的包文件命名和 packFileName 算的对不上`, data: { shipped: packed } }
    }
    packed.push({ pkg: one.manifest.name, version: one.version, dir: one.pkgDir, packFile: packPath, via: installedByInstall.has(one.manifest.name) ? 'install' : 'update' })
  }
  return packed
}

/** 不在 home 的 dependencies 里的插件：逐个 `plugin-manager.install`，装包并新建一条条目 */
async function installNewPlugins(home: string, installs: PluginManagerCalls['installs'], shipped: ShippedPackage[], deps: DevDeps): Promise<Failure | undefined> {
  for (const one of installs) {
    const reply = await runCommandOnPage(home, INSTALL_COMMAND, PLUGIN_MANAGER_TIMEOUT_MS, deps, one)
    if (!reply.ok) return { ok: false, error: `装 ${one.pkg} 没成(${INSTALL_COMMAND}):${reply.error ?? '没说原因'}`, data: { shipped, install: reply.data } }
    const row = shipped.find((packed) => packed.pkg === one.pkg)
    if (row !== undefined && isRecord(reply.data) && typeof reply.data.entryId === 'string') row.entryId = reply.data.entryId
  }
  return undefined
}

/** update 回执里 action 是 deferred 的条目属于哪些包：插件管理自己的条目在回执之后才重新加载 */
function deferredPackagesOf(updateReceipt: unknown): string[] {
  if (!isRecord(updateReceipt)) return []
  const rows = [
    ...(Array.isArray(updateReceipt.updated) ? updateReceipt.updated : []),
    ...(Array.isArray(updateReceipt.dependents) ? updateReceipt.dependents : []),
  ].filter(isRecord)
  return rows.flatMap((row) =>
    typeof row.pkg === 'string' && Array.isArray(row.entries) && row.entries.some((entry) => isRecord(entry) && entry.action === 'deferred') ? [row.pkg] : [],
  )
}

/** 轮询 `plugin-manager.list` 直到这几个包的条目全都 active */
async function waitForDeferredEntries(home: string, pkgs: readonly string[], shipped: ShippedPackage[], deps: DevDeps): Promise<Failure | undefined> {
  const maxPolls = Math.ceil(DEFERRED_TIMEOUT_MS / DEFERRED_POLL_MS)
  let lastObservation = '一次都没问到'
  for (let i = 0; i < maxPolls; i += 1) {
    await deps.sleep(DEFERRED_POLL_MS)
    const listed = await runCommandOnPage(home, LIST_COMMAND, CDP_TIMEOUT_MS, deps)
    if (!listed.ok) {
      lastObservation = `${LIST_COMMAND} 没答话(${listed.error ?? '没说原因'})`
      continue
    }
    const notActive = pkgs.flatMap((pkg) => {
      const entries = entriesOf(listed.data, pkg)
      return entries.length === 0 ? [`${pkg}(表里没有它的条目)`] : entries.filter((entry) => !entry.active).map((entry) => entry.entryId)
    })
    if (notActive.length === 0) return undefined
    lastObservation = `${LIST_COMMAND} 答话了,还没 active 的:${notActive.join('、')}`
  }
  return {
    ok: false,
    error: `${pkgs.join('、')} 的条目在回执之后才重新加载,等了 ${String(DEFERRED_TIMEOUT_MS / 1000)} 秒没等到它们回来。卡在:${lastObservation}`,
    data: { shipped },
  }
}

/** `shell.env` 回执里运行中的内核版本。答不上来是 undefined */
function runningKernelOf(receipt: { ok: boolean; data: unknown }): string | undefined {
  if (!receipt.ok || !isRecord(receipt.data) || !isRecord(receipt.data.versions)) return undefined
  const kernel = receipt.data.versions.kernel
  return typeof kernel === 'string' ? kernel : undefined
}

/** 重启目标 home，轮询 `shell.env` 直到页面报出内核版本；报出的不是这次打包的版本号当场判失败 */
async function restartForKernel(home: string, expected: string, shipped: ShippedPackage[], deps: DevDeps): Promise<Failure | KernelRestart> {
  const restarted = await deps.restartHome(home)
  if (!restarted.ok) return { ok: false, error: `内核包 ${expected} 装上了,重启 ${home} 没成:${restarted.error}`, data: { shipped } }
  const maxPolls = Math.ceil(RESTART_TIMEOUT_MS / RESTART_POLL_MS)
  let lastObservation = '一次都没问到'
  for (let i = 0; i < maxPolls; i += 1) {
    const receipt = await runCommandOnPage(home, SHELL_ENV_COMMAND, CDP_TIMEOUT_MS, deps)
    const running = runningKernelOf(receipt)
    if (running === expected) return { version: running, restart: restarted.note }
    if (running !== undefined) {
      return { ok: false, error: `重启了 ${home},页面上报的内核版本是 ${running},不是这次打包的 ${expected}——启动器加载的不是 home 里装上的那份内核包`, data: { shipped } }
    }
    lastObservation = receipt.ok ? `${SHELL_ENV_COMMAND} 答话了,回执里没有 versions.kernel` : `${SHELL_ENV_COMMAND} 没答话(${receipt.error ?? '没说原因'})`
    await deps.sleep(RESTART_POLL_MS)
  }
  return {
    ok: false,
    error: `重启了 ${home},等了 ${String(RESTART_TIMEOUT_MS / 1000)} 秒没从 ${SHELL_ENV_COMMAND} 问到内核版本。卡在:${lastObservation}`,
    data: { shipped },
  }
}

/**
 * 已装的包合成一条 `plugin-manager.update {specs}`：插件管理装包、重新加载这些包与真实目录变了的别的包。
 * 装了内核包时它回 `restartRequired`，这边重启目标 home；插件管理自己的条目推迟到回执之后时这边轮询到它回来
 */
async function updateInstalledPackages(
  home: string,
  specs: Record<string, string>,
  kernelShipped: ShippedPackage | undefined,
  shipped: ShippedPackage[],
  deps: DevDeps,
): Promise<Failure | { update: unknown; kernel?: KernelRestart }> {
  const reply = await runCommandOnPage(home, UPDATE_COMMAND, PLUGIN_MANAGER_TIMEOUT_MS, deps, { specs })
  if (!reply.ok) return { ok: false, error: `${UPDATE_COMMAND} 没成:${reply.error ?? '没说原因'}`, data: { shipped, update: reply.data } }
  const restartRequired = isRecord(reply.data) && reply.data.restartRequired === true
  if (kernelShipped !== undefined) {
    if (!restartRequired) {
      return { ok: false, error: `装了内核包 ${kernelShipped.version},${UPDATE_COMMAND} 的回执里却没有 restartRequired: true——目标 home 的插件管理不认 specs 里的内核包`, data: { shipped, update: reply.data } }
    }
    const kernel = await restartForKernel(home, kernelShipped.version, shipped, deps)
    if ('ok' in kernel) return kernel
    return { update: reply.data, kernel }
  }
  if (isRecord(reply.data) && reply.data.selfDeferred === true) {
    const deferred = deferredPackagesOf(reply.data)
    if (deferred.length === 0) {
      return { ok: false, error: `${UPDATE_COMMAND} 的回执说 selfDeferred,可 updated 与 dependents 里没有 action 是 deferred 的条目`, data: { shipped, update: reply.data } }
    }
    const waited = await waitForDeferredEntries(home, deferred, shipped, deps)
    if (waited !== undefined) return waited
  }
  return { update: reply.data }
}

/**
 * 页面代码要整页重新加载才会按 file:// 重新取；给了选择器就等它出现，不然量到的是刷新途中或上一版的画面。
 * cdp 退出码非零、或回执里「等到了」不是 true，都算刷新没成：接着取证量到的会是旧页面
 */
async function reloadPage(home: string, waitFor: string | undefined, deps: DevDeps): Promise<{ ok: true; data: unknown } | { ok: false; error: string; data: unknown }> {
  const reloaded = await deps.cdp(home, ['reload', ...(waitFor === undefined ? [] : [waitFor])], CDP_TIMEOUT_MS)
  const data = reloaded.data
  if (reloaded.ok && isRecord(data) && data.等到了 === true) return { ok: true, data }
  const waitedFor = isRecord(data) && typeof data.等的是 === 'string' ? data.等的是 : (waitFor ?? 'readyState')
  const lastSeen = isRecord(data) && data.最后看到 !== undefined ? JSON.stringify(data.最后看到) : reloaded.tail === '' ? '没有输出' : reloaded.tail
  return { ok: false, error: `装上了,整页刷新没成:等的是 ${waitedFor},最后看到的是 ${lastSeen}`, data }
}

/**
 * 问目标页面 → 仓根构建 → 样式检查 → 打包进目标 home 的 dev-packs → 经目标 home 的插件管理装（先 update 已装的、再 install 新插件）
 * → 整页刷新 → 取证。任何一步失败当场停。装了内核包时整页刷新换成重启目标 home
 */
export async function runDev(input: DevInput, deps: DevDeps): Promise<DevOutcome> {
  const target = await probeTargetHome(input, deps)
  if (!target.ok) return { ok: false, error: target.error }

  // 在仓根构建，不在包目录：工作区里的插件常常用着同仓另一个包的产物
  const built = await deps.run(pnpmPlan(['build'], input.repoDir, deps.pnpm), BUILD_TIMEOUT_MS)
  if (!built.ok) return { ok: false, error: `仓根 pnpm build 没成,一步都没往下走。输出的最后几行:\n${built.tail}` }

  const planned = planDevPackages(input, target.home, deps)
  if (!Array.isArray(planned)) return planned
  const styleFailure = await styleCheckFailure(planned, target.name, deps)
  if (styleFailure !== undefined) return styleFailure
  const manifestFile = path.join(target.home, HOME_MANIFEST)
  const homeDependencies = homeDependenciesOf(deps.readText(manifestFile), manifestFile)
  if (!homeDependencies.ok) return { ok: false, error: homeDependencies.error }
  const routed = pluginManagerCallsFor(planned, homeDependencies.dependencies)
  if (!routed.ok) return { ok: false, error: routed.error }

  const shipped = await packDevPackages(planned, routed.calls, target.home, deps)
  if (!Array.isArray(shipped)) return shipped

  // 日志基线取在安装之前：从这一刻起新增的每一行都是这次引起的
  const logFile = path.join(target.home, LOG_FILE)
  const baseline = deps.size(logFile)

  // 先换已装的、再装新插件：新插件加载时 import 到的别的包（比如这次一起改的插件管理）要已经是这次装的，反过来它会先对着旧版加载失败一次
  const kernelShipped = shipped.find((one) => one.pkg === KERNEL_PACKAGE)
  let update: unknown
  let kernel: KernelRestart | undefined
  if (Object.keys(routed.calls.specs).length > 0) {
    const updated = await updateInstalledPackages(input.home, routed.calls.specs, kernelShipped, shipped, deps)
    if ('ok' in updated) return updated
    update = updated.update
    kernel = updated.kernel
  }
  const installFailure = await installNewPlugins(input.home, routed.calls.installs, shipped, deps)
  if (installFailure !== undefined) return installFailure
  let reload: unknown
  if (kernel === undefined) {
    const reloaded = await reloadPage(input.home, input.waitFor, deps)
    if (!reloaded.ok) return { ok: false, error: reloaded.error, data: { shipped, update, reload: reloaded.data } }
    reload = reloaded.data
  }

  const evidence = await collect(input.home, target.home, shipped, logFile, baseline, deps)
  const report: DevReport = {
    home: target.home,
    homeName: target.name,
    shipped,
    ...(update === undefined ? {} : { update }),
    ...(kernel === undefined ? { reload } : { kernel }),
    evidence,
  }
  if (!evidence.ok) return { ok: false, error: evidence.note, data: report }
  return { ok: true, data: report }
}

/** 日志认不出时排在最前：它说的是目标 home 本身不对，别的几样修好了也照样判不了日志 */
function evidenceNote(
  homeDir: string,
  logFile: string,
  logScan: LogScan,
  landed: { rows: InstalledRow[]; wrong: InstalledRow[] },
  listed: { ok: boolean; error?: string },
  entryCount: number,
  dead: string[],
): string {
  if (!logScan.ok) return `${logScan.error}\n文件:${logFile}`
  const { errors, warns } = logScan
  if (landed.wrong.length > 0) return installedNote(path.basename(homeDir), landed.wrong)
  if (!listed.ok) return `取不到证:${LIST_COMMAND} 没回(${listed.error ?? '没说原因'})`
  if (dead.length > 0) return `这几条没加载成功(fiber 没到 ACTIVE):${dead.join('、')}——日志里有原因`
  if (errors.length > 0) return `装完之后日志里新增 ${String(errors.length)} 条 error,别当它验过了:\n${errors.join('\n')}`
  return `装上的是这次的版本号(${landed.rows.map((row) => `${row.pkg}@${row.expected}`).join('、')}),${String(entryCount)} 条条目都在运行,日志新增部分里没有 error${warns.length > 0 ? `(有 ${String(warns.length)} 条 warn,另看)` : ''}`
}

/** 三样：装上的就是这次打包的版本号；条目的 fiber 真的是 ACTIVE；日志从基线往后没有 error。只在 runDev 里调用：判断要基线 */
export async function collect(
  home: string,
  homeDir: string,
  shipped: readonly { pkg: string; version: string }[],
  logFile: string,
  baseline: number,
  deps: DevDeps,
): Promise<Evidence> {
  const landed = checkInstalled(homeDir, shipped, deps.readText)
  const listed = await runCommandOnPage(home, LIST_COMMAND, CDP_TIMEOUT_MS, deps)
  const entries: Evidence['entries'] = []
  const dead: string[] = []
  for (const one of shipped) {
    const entriesOfPackage = entriesOf(listed.data, one.pkg)
    // 内核包本来就没有条目；插件在条目表里一条都没有，就是装上了却没在运行
    if (listed.ok && entriesOfPackage.length === 0 && one.pkg !== KERNEL_PACKAGE) dead.push(`${one.pkg}(条目表里没有它)`)
    for (const entry of entriesOfPackage) {
      entries.push({ pkg: one.pkg, entryId: entry.entryId, active: entry.active })
      if (!entry.active) dead.push(`${entry.entryId}(${one.pkg})`)
    }
  }
  const logScan = errorLines(deps.slice(logFile, baseline))
  const { errors, warns } = logScan.ok ? logScan : { errors: [], warns: [] }
  const ok = logScan.ok && landed.wrong.length === 0 && listed.ok && dead.length === 0 && errors.length === 0
  const note = evidenceNote(homeDir, logFile, logScan, landed, listed, entries.length, dead)
  return { ok, installed: landed.rows, entries, dead, errors, warns, note }
}
