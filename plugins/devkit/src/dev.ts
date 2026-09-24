import path from 'node:path'
import { KERNEL_PACKAGE } from './kernel-compat.js'
import { isRecord } from './vocab.js'

/** 团队源：gitea 上 godcreator 组织的 npm registry，与用户级 `~/.npmrc` 里 `@godcreator` 那行同一个地址 */
export const DEFAULT_REGISTRY = 'https://git.tianshen02.online:28377/api/packages/godcreator/npm/'

/** 日常用的那个 home 的名字。开发版装进它就是悄悄换了日常代码，所以当场拒 */
export const DAILY_HOME = 'default'

/** 目标 home 的日志。跟着 home 走，每个 home 的日志是分开的 */
export const LOG_FILE = 'gwb.log'

export const BUILD_TIMEOUT_MS = 300_000
export const PUBLISH_TIMEOUT_MS = 180_000
export const ADD_TIMEOUT_MS = 300_000
/** 一次 CDP 动作的上限。`reload` 还要等页面回来，所以给得比别的宽 */
export const CDP_TIMEOUT_MS = 120_000

/** 取证时日志新增部分里最多回几行 */
export const LOG_TAIL_LINES = 40

/** 内核包 peer 里的 cordis 装在 home 根上，与内核包一起写进清单 */
export const CORDIS_PACKAGE = 'cordis'

/** 重启之后问内核版本的那条命令：回执 `versions.kernel` 是运行中的内核自己报的 */
export const SHELL_ENV_COMMAND = 'shell.env'

/** 重启之后轮询 `shell.env` 的间隔与总上限 */
export const RESTART_POLL_MS = 1000
export const RESTART_TIMEOUT_MS = 90_000

// ── 版本号 ────────────────────────────────────────────────────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * `<patch+1>-dev.<yyyyMMddHHmm>`。patch 加一：开发版要排在正式版之后，不然 `>=` 那类范围会把它当成旧版跳过。
 * 时间戳到分钟：同一分钟发两次会撞号，撞了当场拒，比静默覆盖一个已经装出去的号强
 */
export function devVersion(version: string, now: number): string {
  const [major = '0', minor = '0', rest = '0'] = version.split('.')
  // 用 parseInt 不用 Number：底版本本身可能已经是预发布号（`0.3.1-dev.x`），那时该发 0.3.2-dev.y
  const patch = Number.parseInt(rest, 10)
  const nowDate = new Date(now)
  const stamp = `${String(nowDate.getFullYear())}${pad(nowDate.getMonth() + 1)}${pad(nowDate.getDate())}${pad(nowDate.getHours())}${pad(nowDate.getMinutes())}`
  return `${major}.${minor}.${String((Number.isNaN(patch) ? 0 : patch) + 1)}-dev.${stamp}`
}

// ── 检查目标 ──────────────────────────────────────────────────────────────────

/** `devkit.cdp <名> home` 打印的那张表。页面上的 `file://` 地址里带着 home 的绝对路径 */
export interface HomeProbe {
  home: string | null
  why?: string
}

export type HomeGuard = { ok: true; home: string; name: string } | { ok: false; error: string }

/** Windows 上路径不分大小写。平台当参数传，不在这里读 `process.platform`：两种平台都要在测试里跑到 */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const normalized = (p: string): string => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, '')
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalized(a) === normalized(b)
}

/**
 * 页面报不出 home 就停（可能不是工作台的外壳页）；点名的 home 与页面自报的对不上就停；
 * `default` 当场拒；目标是自己所在的 home 就拒（停用条目会把正在运行的这条命令自己停掉）
 */
export function guardHome(probe: HomeProbe, ownHome: string, platform: NodeJS.Platform, expect?: string): HomeGuard {
  if (probe.home === null || probe.home === '') {
    return { ok: false, error: `问不出这张页是哪个 home:${probe.why ?? '没说原因'}——它可能不是工作台的外壳页,或者这个调试端口连到了别的应用` }
  }
  const name = path.basename(probe.home.replace(/[\\/]+$/, ''))
  // 记录回答「你要的是哪个」，页面回答「你连上的实际是哪个」：记录会过时、端口会被复用
  if (expect !== undefined && expect !== name) {
    return { ok: false, error: `你点名要 ${expect},可这个调试端口上的页面自报是 ${name}——记录过时了,或者端口给错了。没动它` }
  }
  if (name === DAILY_HOME) {
    return { ok: false, error: `目标是 ${DAILY_HOME},这是日常那份 home,开发版不进它——换个隔离 home(devkit.home.new)再来` }
  }
  if (samePath(probe.home, ownHome, platform)) {
    return {
      ok: false,
      error: `目标就是本插件自己所在的这个 home(${probe.home})——停用条目会把正在运行的这条命令自己停掉。换 devkit 自己用另一条路:发正式版,再 plugin-manager.update-all`,
    }
  }
  return { ok: true, home: probe.home, name }
}

// ── 包清单 ────────────────────────────────────────────────────────────────────

export interface Manifest {
  name: string
  version: string
  files?: string[]
  /** `peerDependencies.cordis`。只有内核包用得上：home 根上的 cordis 照它装 */
  peerCordis?: string
}

/** home 根上的 cordis 只能照精确版本装，内核包 peer 里写范围就没法定下装哪个 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** `files` 里必须真在磁盘上的产物。否定式（`!py/**\/__pycache__`）与通配不算：拿去查存在必然「不在」 */
export function literalArtifacts(files: readonly string[]): string[] {
  return files.filter((one) => !one.startsWith('!') && !/[*?]/.test(one))
}

/** 缺 name/version 就不是个能发的包 */
export function parseManifest(text: string | undefined): Manifest | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(doc)) return undefined
  const { name, version, files, peerDependencies } = doc
  if (typeof name !== 'string' || name === '') return undefined
  if (typeof version !== 'string' || version === '') return undefined
  const peerCordis = isRecord(peerDependencies) ? peerDependencies[CORDIS_PACKAGE] : undefined
  return {
    name,
    version,
    ...(Array.isArray(files) ? { files: files.filter((one): one is string => typeof one === 'string') } : {}),
    ...(typeof peerCordis === 'string' ? { peerCordis } : {}),
  }
}

// ── 条目 ──────────────────────────────────────────────────────────────────────

export interface EntryView {
  entryId: string
  active: boolean
}

/**
 * `plugin-manager.list` 回执里这个包的全部条目，不是第一条：同一个包可能有两条条目，只重新加载一条，另一条还是旧模块。
 * 回执形状 `{ packages: [...] }` 与裸数组都认
 */
export function entriesOf(data: unknown, pkg: string): EntryView[] {
  const packages = isRecord(data) && Array.isArray(data.packages) ? data.packages : Array.isArray(data) ? data : []
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

/** 目标 home 自己的依赖清单（pnpm 的项目清单，home 根下） */
export const HOME_MANIFEST = 'package.json'

/** 清单里依赖可能在的几个字段。home 里的插件都在 dependencies，别的字段里有这个包就改那个字段 */
const DEP_GROUPS = ['dependencies', 'optionalDependencies', 'devDependencies'] as const

export type PinOutcome = { ok: true; text: string } | { ok: false; error: string }

/**
 * 把这个包的声明写成准确版本号（没有就按名字排进 `dependencies`），缩进与末尾换行照原文。
 * 不用 `pnpm add <包>@<号>`：已有 `^` 声明时它写回的是范围，装上的可能不是这次发的版本，退出码照样是 0
 */
export function pinExact(text: string | undefined, pkg: string, version: string): PinOutcome {
  if (text === undefined) return { ok: false, error: `读不到 ${HOME_MANIFEST}` }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `${HOME_MANIFEST} 不是合法 JSON:${String(err)}` }
  }
  if (!isRecord(doc)) return { ok: false, error: `${HOME_MANIFEST} 顶层不是对象` }
  const manifest = doc
  const tableOf = (key: string): Record<string, unknown> | undefined => {
    const table = manifest[key]
    return isRecord(table) ? table : undefined
  }
  const depGroup = DEP_GROUPS.find((key) => tableOf(key)?.[pkg] !== undefined) ?? 'dependencies'
  const currentTable = tableOf(depGroup) ?? {}
  const nextTable: Record<string, unknown> =
    currentTable[pkg] !== undefined
      ? { ...currentTable, [pkg]: version }
      : Object.fromEntries(Object.entries({ ...currentTable, [pkg]: version }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  '
  const eol = text.endsWith('\n') ? '\n' : ''
  return { ok: true, text: JSON.stringify({ ...manifest, [depGroup]: nextTable }, null, indent) + eol }
}

/** home 里装上的那份包清单在哪。scope 包是两层目录 */
export function installedManifest(homeDir: string, pkg: string): string {
  return path.join(homeDir, 'node_modules', ...pkg.split('/'), 'package.json')
}

export interface InstalledRow {
  pkg: string
  /** 这次发的版本号 */
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
      ? `${row.pkg}:这次发的是 ${row.expected},${homeName} 的 node_modules 里读不到它的 package.json`
      : `${row.pkg}:这次发的是 ${row.expected},${homeName} 里实际装上的是 ${row.actual}`,
  )
  return `新代码没进 ${homeName}——${lines.join(';')}。重新加载拿到的会是装上的那一版,别当它验过了`
}

// ── 日志 ──────────────────────────────────────────────────────────────────────

/**
 * 一行是 `<ISO 时间> <级别> <插件名> <正文>`。只把 error 算失败，warn 另报：插件启动时 warn 一句
 * 「某个可选服务不在」是常态，算成失败这条命令就天天红，人很快学会无视它
 */
export function errorLines(tail: string): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []
  for (const line of tail.split(/\r?\n/)) {
    const level = line.trim().split(/\s+/)[1]
    if (level === 'error') errors.push(line.trim())
    else if (level === 'warn') warns.push(line.trim())
  }
  return { errors: errors.slice(-LOG_TAIL_LINES), warns: warns.slice(-LOG_TAIL_LINES) }
}

// ── 注入的依赖 ────────────────────────────────────────────────────────────────

export interface RunPlan {
  command: string
  args: string[]
  cwd: string
  /** 叠在宿主进程环境上的变量；没有就原样用宿主的环境 */
  env?: Record<string, string>
}

/**
 * 在 home 里运行的 pnpm 不自动补装缺的 peer：插件的 peer 写别的插件，home 里没装那个插件时补装进来，就成了一个没有条目、插件管理也不知道的包。
 * 命令行参数 `--config.auto-install-peers=false` 关不掉，环境变量关得掉（probes/2609242300_peer-between-plugins）。
 * 插件仓里不能带：仓里开发靠自动补装把 peer 里的内核包与插件装进 node_modules，带上它 pnpm 会按新配置重装、把这些 peer 拿掉，构建找不到类型
 */
export const HOME_PNPM_ENV: Readonly<Record<string, string>> = { pnpm_config_auto_install_peers: 'false' }

/** 直接启动 pnpm 的原生可执行文件（`locatePnpm` 找到并核对过版本的那个），不经 shell；用在插件仓、临时目录这些不是 home 的地方 */
export function pnpmPlan(args: string[], cwd: string, pnpm: string): RunPlan {
  return { command: pnpm, args, cwd }
}

/** 同 `pnpmPlan`，在 home 里运行：带上 `HOME_PNPM_ENV` */
export function homePnpmPlan(args: string[], home: string, pnpm: string): RunPlan {
  return { command: pnpm, args, cwd: home, env: { ...HOME_PNPM_ENV } }
}

export interface DevDeps {
  /** 前台运行一条命令到结束：成没成加输出的最后几行 */
  run(plan: RunPlan, timeoutMs: number): Promise<{ ok: boolean; tail: string }>
  /** 对目标 home 的页面执行一个 `devkit.cdp` 动作，回它打印的 JSON。按 home 名调用、启动子进程运行 */
  cdp(home: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; data: unknown; tail: string }>
  /**
   * 在临时目录组装发布内容再 publish，不改仓里的 package.json（中途失败会留下版本号被改过的仓）。
   * `siblings` 是同一次发的包的准确版本号：包里对它们的依赖要换成这几个号，`>=` 那类范围认不到 dev 号
   */
  publish(input: { pkgDir: string; version: string; registry: string; siblings: Record<string, string> }): Promise<{ ok: boolean; tail: string }>
  /** 这个版本号在源上有没有。问不出来当没有（发的时候源会再拒一次，那才是准的） */
  published(spec: string, registry: string): Promise<boolean>
  readText(file: string): string | undefined
  /** 整份写一个文本文件。只用来改目标 home 的清单 */
  writeText(file: string, text: string): { ok: true } | { ok: false; error: string }
  exists(target: string): boolean
  /** 文件现在多大。取日志基线用 */
  size(file: string): number
  /** 从某个字节读到末尾。取日志新增部分用 */
  slice(file: string, from: number): string
  now(): number
  /** 等一会儿。轮询回执之后才重新加载的那一条时用 */
  sleep(ms: number): Promise<void>
  /** 停掉目标 home 的进程，再用同一个 home 启动。主进程里的内核换不掉，内核包换了版本只有重启才生效 */
  restartHome(home: string): Promise<{ ok: true; note: string } | { ok: false; error: string }>
  platform: NodeJS.Platform
  /** pnpm 的可执行文件：命令开头 `locatePnpm` 找到并核对过版本的那个 */
  pnpm: string
}

// ── 一次流程 ──────────────────────────────────────────────────────────────────

export interface DevInput {
  /** 目标 home 的名字。只认名字：端口是按记录查的，每次连上都要拿页面自报的名字核对 */
  home: string
  /** 仓根。构建在这里运行 */
  repoDir: string
  /** 要发的包目录，相对仓根。空表＝仓根自己 */
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
  /** 重新加载了哪几条条目。空表＝这个包在目标 home 里还没有条目 */
  remounted: string[]
  note?: string
}

/** 这一趟发了内核包时：重启了目标 home，页面上报的内核版本就是这次发的号 */
export interface KernelRestart {
  version: string
  restart: string
}

export interface DevReport {
  home: string
  homeName: string
  shipped: ShippedPackage[]
  /** 整页重新加载的结果。发了内核包时没有这一格，重启的结果在 `kernel` */
  reload?: unknown
  kernel?: KernelRestart
  /** 取证：该运行的条目在不在运行、日志新增部分里有没有新错 */
  evidence: Evidence
}

export interface Evidence {
  ok: boolean
  /** 逐包：这次发的版本号与 home 里实际装上的版本号 */
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

type Failure = { ok: false; error: string; data?: unknown }

async function probeTargetHome(input: DevInput, deps: DevDeps): Promise<Failure | { ok: true; home: string; name: string }> {
  const probe = await deps.cdp(input.home, ['home'], CDP_TIMEOUT_MS)
  if (!probe.ok && !isRecord(probe.data)) {
    return { ok: false, error: `连不上 ${input.home}:${probe.tail}` }
  }
  return guardHome(
    isRecord(probe.data) ? { home: typeof probe.data.home === 'string' ? probe.data.home : null, ...(typeof probe.data.why === 'string' ? { why: probe.data.why } : {}) } : { home: null },
    input.ownHome,
    deps.platform,
    input.home,
  )
}

export interface PlannedDevPackage {
  pkgDir: string
  manifest: Manifest
  version: string
}

/** 先把全部版本号算出来再一个个发：包之间互相依赖，发第一个时就得知道第二个将来是什么号 */
async function planDevVersions(input: DevInput, deps: DevDeps): Promise<Failure | { planned: PlannedDevPackage[]; siblings: Record<string, string> }> {
  const dirs = input.packages.length > 0 ? input.packages : ['.']
  const planned: PlannedDevPackage[] = []
  const siblings: Record<string, string> = {}
  for (const rel of dirs) {
    const pkgDir = path.resolve(input.repoDir, rel)
    const manifest = parseManifest(deps.readText(path.join(pkgDir, 'package.json')))
    if (manifest === undefined) {
      return { ok: false, error: `${pkgDir} 下没有能读的 package.json(或缺 name/version)——包目录给的是相对仓根的路径` }
    }
    // 产物在不在照 files 白名单问，不另列一份名单
    const missing = literalArtifacts(manifest.files ?? []).filter((one) => !deps.exists(path.join(pkgDir, one)))
    if (missing.length > 0) {
      return { ok: false, error: `${manifest.name} 的产物不全,没发:${missing.join('、')} 不在。仓根 pnpm build 刚跑过还缺,多半是 files 白名单里那一项根本没人生成` }
    }
    if (manifest.name === KERNEL_PACKAGE && (manifest.peerCordis === undefined || !EXACT_VERSION.test(manifest.peerCordis))) {
      return {
        ok: false,
        error: `内核包的 peerDependencies.cordis 是 ${JSON.stringify(manifest.peerCordis ?? null)},不是精确版本号:home 根上的 cordis 只能照精确版本装(${path.join(pkgDir, 'package.json')})`,
      }
    }
    const version = devVersion(manifest.version, deps.now())
    if (await deps.published(`${manifest.name}@${version}`, DEFAULT_REGISTRY)) {
      return { ok: false, error: `${manifest.name}@${version} 已经在源上了,同一个号永不重发——同一分钟里发了两次的话,等一分钟再来` }
    }
    planned.push({ pkgDir, manifest, version })
    siblings[manifest.name] = version
  }
  return { planned, siblings }
}

/** 按给的顺序发：被依赖的先发，不然装的时候源上还没有它 */
async function publishDevVersions(planned: PlannedDevPackage[], siblings: Record<string, string>, deps: DevDeps): Promise<Failure | ShippedPackage[]> {
  const shipped: ShippedPackage[] = []
  for (const plannedPackage of planned) {
    const sent = await deps.publish({ pkgDir: plannedPackage.pkgDir, version: plannedPackage.version, registry: DEFAULT_REGISTRY, siblings })
    if (!sent.ok) return { ok: false, error: `${plannedPackage.manifest.name}@${plannedPackage.version} 发版没成:\n${sent.tail}`, data: { shipped } }
    shipped.push({ pkg: plannedPackage.manifest.name, version: plannedPackage.version, dir: plannedPackage.pkgDir, remounted: [] })
  }
  return shipped
}

/** 写进目标 home 清单的准确版本号：这一趟发的每个包；发了内核包就再加上它 peer 里的 cordis */
export function pinsFor(planned: readonly PlannedDevPackage[], shipped: readonly ShippedPackage[]): { pkg: string; version: string }[] {
  const pins = shipped.map((one) => ({ pkg: one.pkg, version: one.version }))
  const kernelCordis = planned.find((one) => one.manifest.name === KERNEL_PACKAGE)?.manifest.peerCordis
  return kernelCordis === undefined ? pins : [...pins, { pkg: CORDIS_PACKAGE, version: kernelCordis }]
}

/**
 * 清单里写准确版本号再 `pnpm install`（不用 plugin-manager.install：对装过的包它还会再建一条条目），一次写齐一次装；
 * 装失败把清单放回原样；退出码 0 也要读回核对装上的版本号
 */
async function installIntoHome(
  target: { home: string; name: string },
  pins: readonly { pkg: string; version: string }[],
  shipped: ShippedPackage[],
  deps: DevDeps,
): Promise<Failure | undefined> {
  const manifestFile = path.join(target.home, HOME_MANIFEST)
  const original = deps.readText(manifestFile)
  if (original === undefined) return { ok: false, error: `读不到 ${target.name} 的清单(${manifestFile})——这不像一个装过插件的 home`, data: { shipped } }
  let pinnedText = original
  for (const one of pins) {
    const pinned = pinExact(pinnedText, one.pkg, one.version)
    if (!pinned.ok) return { ok: false, error: `改不了 ${target.name} 的清单(${manifestFile}):${pinned.error}`, data: { shipped } }
    pinnedText = pinned.text
  }
  if (pinnedText !== original) {
    const written = deps.writeText(manifestFile, pinnedText)
    if (!written.ok) return { ok: false, error: `写不进 ${manifestFile}:${written.error}`, data: { shipped } }
  }
  const installed = await deps.run(homePnpmPlan(['install'], target.home, deps.pnpm), ADD_TIMEOUT_MS)
  if (!installed.ok) {
    // 留着「声明了新版本号、磁盘上是旧版本」的清单，下一个在这个 home 里运行 pnpm 的人会不明不白地装上它
    const restored = pinnedText === original ? { ok: true as const } : deps.writeText(manifestFile, original)
    const wanted = pins.map((one) => `${one.pkg}@${one.version}`).join('、')
    return {
      ok: false,
      error: `在 ${target.name} 里装 ${wanted} 没成${restored.ok ? '(清单已放回原样)' : `,清单也没放回去(${restored.error})——手工把 ${manifestFile} 改回来`}:\n${installed.tail}`,
      data: { shipped },
    }
  }
  const landed = checkInstalled(target.home, pins, deps.readText)
  if (landed.wrong.length > 0) {
    return { ok: false, error: installedNote(target.name, landed.wrong), data: { shipped, installed: landed.rows } }
  }
  return undefined
}

/** `shell.env` 回执里运行中的内核版本。答不上来是 undefined */
function runningKernelOf(receipt: { ok: boolean; data: unknown }): string | undefined {
  if (!receipt.ok || !isRecord(receipt.data) || !isRecord(receipt.data.versions)) return undefined
  const kernel = receipt.data.versions.kernel
  return typeof kernel === 'string' ? kernel : undefined
}

/** 重启目标 home，轮询 `shell.env` 直到页面报出内核版本；报出的不是这次发的号当场判失败 */
async function restartForKernel(home: string, expected: string, shipped: ShippedPackage[], deps: DevDeps): Promise<Failure | KernelRestart> {
  const restarted = await deps.restartHome(home)
  if (!restarted.ok) return { ok: false, error: `内核包 ${expected} 装上了,重启 ${home} 没成:${restarted.error}`, data: { shipped } }
  const maxPolls = Math.ceil(RESTART_TIMEOUT_MS / RESTART_POLL_MS)
  let lastObservation = '一次都没问到'
  for (let i = 0; i < maxPolls; i += 1) {
    const receipt = receiptOf((await deps.cdp(home, ['cmd', SHELL_ENV_COMMAND], CDP_TIMEOUT_MS)).data)
    const running = runningKernelOf(receipt)
    if (running === expected) return { version: running, restart: restarted.note }
    if (running !== undefined) {
      return { ok: false, error: `重启了 ${home},页面上报的内核版本是 ${running},不是这次发的 ${expected}——启动器加载的不是 home 里装上的那份内核包`, data: { shipped } }
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

/** 磁盘上换了不等于运行着的换了：每个包的全部条目各发一条 `plugin-manager.remount`；没有条目的包记一条说明 */
async function remountShippedEntries(home: string, homeName: string, shipped: ShippedPackage[], deps: DevDeps): Promise<Failure | undefined> {
  const listed = receiptOf((await deps.cdp(home, ['cmd', 'plugin-manager.list'], CDP_TIMEOUT_MS)).data)
  if (!listed.ok) return { ok: false, error: `问不出目标 home 的条目表(plugin-manager.list:${listed.error ?? '没说原因'})`, data: { shipped } }
  for (const one of shipped) {
    const entries = entriesOf(listed.data, one.pkg)
    if (entries.length === 0) {
      one.note = `装上了,但 ${homeName} 里没有它的条目,没有重新加载——第一次建条目在 ${homeName} 里经 devkit.cdp 的 cmd 调 plugin-manager.install {"pkg":"${one.pkg}","spec":"${one.version}"}(经 MCP 调会装进 default;spec 写这次的版本号,不给会装成 latest),之后每改一版用 devkit.dev`
      continue
    }
    for (const entry of entries) {
      const remounted = await remount(home, one.pkg, entry.entryId, deps)
      if (!remounted.ok) return { ok: false, error: remounted.error, data: { shipped } }
      one.remounted.push(entry.entryId)
    }
  }
  return undefined
}

/**
 * 问目标页面 → 仓根构建 → 发开发版 → 装进目标 home → 重新加载 → 整页刷新 → 取证。任何一步失败当场停。
 * 发了内核包时，重新加载与整页刷新换成重启目标 home：重启之后每条条目都是按新装的包从头加载的
 */
export async function runDev(input: DevInput, deps: DevDeps): Promise<DevOutcome> {
  const target = await probeTargetHome(input, deps)
  if (!target.ok) return { ok: false, error: target.error }

  // 在仓根构建，不在包目录：工作区里的插件常常用着同仓另一个包的产物
  const built = await deps.run(pnpmPlan(['build'], input.repoDir, deps.pnpm), BUILD_TIMEOUT_MS)
  if (!built.ok) return { ok: false, error: `仓根 pnpm build 没成,一步都没往下走。输出的最后几行:\n${built.tail}` }

  const plan = await planDevVersions(input, deps)
  if ('ok' in plan) return plan
  const shipped = await publishDevVersions(plan.planned, plan.siblings, deps)
  if (!Array.isArray(shipped)) return shipped

  // 日志基线取在安装之前：从这一刻起新增的每一行都是这次引起的
  const logFile = path.join(target.home, LOG_FILE)
  const baseline = deps.size(logFile)
  const installFailure = await installIntoHome(target, pinsFor(plan.planned, shipped), shipped, deps)
  if (installFailure !== undefined) return installFailure

  const kernelShipped = shipped.find((one) => one.pkg === KERNEL_PACKAGE)
  let kernel: KernelRestart | undefined
  let reload: unknown
  if (kernelShipped !== undefined) {
    const restarted = await restartForKernel(input.home, kernelShipped.version, shipped, deps)
    if ('ok' in restarted) return restarted
    kernel = restarted
  } else {
    const remountFailure = await remountShippedEntries(input.home, target.name, shipped, deps)
    if (remountFailure !== undefined) return remountFailure
    // 页面代码要整页重新加载才会按 file:// 重新取；给了选择器就等它出现，不然量到的是刷新途中或上一版的画面
    reload = (await deps.cdp(input.home, ['reload', ...(input.waitFor === undefined ? [] : [input.waitFor])], CDP_TIMEOUT_MS)).data
  }

  const evidence = await collect(input.home, target.home, shipped, logFile, baseline, deps)
  const report: DevReport = {
    home: target.home,
    homeName: target.name,
    shipped,
    ...(kernel === undefined ? { reload } : { kernel }),
    evidence,
  }
  if (!evidence.ok) return { ok: false, error: evidence.note, data: report }
  return { ok: true, data: report }
}

/** 重新加载一条条目的那条命令。停用、等卸载完、启用、等加载完，在目标进程里一次做完 */
export const REMOUNT_COMMAND = 'plugin-manager.remount'

/** 重新加载之后只有这个状态算加载成功 */
const ACTIVE = 'ACTIVE'

/** 回执之后才重新加载的那一条（插件管理自己）：轮询 `plugin-manager.list` 的间隔与总上限 */
export const DEFERRED_POLL_MS = 500
export const DEFERRED_TIMEOUT_MS = 60_000

/** 一条命令，不是停用加启用两条。回执是 `deferred`（插件管理重新加载自己）就轮询 list 等它回来 */
export async function remount(home: string, pkg: string, entryId: string, deps: DevDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const reply = receiptOf((await deps.cdp(home, ['cmd', REMOUNT_COMMAND, JSON.stringify({ entryId })], CDP_TIMEOUT_MS)).data)
  if (!reply.ok) {
    return { ok: false, error: `重新加载 ${entryId} 没成(${REMOUNT_COMMAND}):${reply.error ?? '没说原因'}——目标 home 的 plugin-manager 要 0.4.0 起才有这条命令` }
  }
  const action = isRecord(reply.data) ? reply.data.action : undefined
  const state = isRecord(reply.data) && typeof reply.data.state === 'string' ? reply.data.state : '没报状态'
  if (action === 'remounted') {
    return state === ACTIVE ? { ok: true } : { ok: false, error: `重新加载了 ${entryId},但它停在 ${state},没到 ${ACTIVE}——日志里有原因` }
  }
  if (action !== 'deferred') {
    return { ok: false, error: `重新加载 ${entryId} 的回执认不出(action=${String(action)}):${JSON.stringify(reply.data)}` }
  }
  const maxPolls = Math.ceil(DEFERRED_TIMEOUT_MS / DEFERRED_POLL_MS)
  let lastObservation = '一次都没问到'
  for (let i = 0; i < maxPolls; i += 1) {
    await deps.sleep(DEFERRED_POLL_MS)
    const listed = receiptOf((await deps.cdp(home, ['cmd', 'plugin-manager.list'], CDP_TIMEOUT_MS)).data)
    if (!listed.ok) {
      lastObservation = `plugin-manager.list 没答话(${listed.error ?? '没说原因'})`
      continue
    }
    const found = entriesOf(listed.data, pkg).find((one) => one.entryId === entryId)
    if (found?.active === true) return { ok: true }
    lastObservation = found === undefined ? `plugin-manager.list 答话了,表里没有 ${entryId}` : `plugin-manager.list 答话了,${entryId} 还没 active`
  }
  return {
    ok: false,
    error: `${entryId} 在回执之后才重新加载,等了 ${String(DEFERRED_TIMEOUT_MS / 1000)} 秒没等到它回来。卡在:${lastObservation}`,
  }
}

function evidenceNote(
  homeDir: string,
  landed: { rows: InstalledRow[]; wrong: InstalledRow[] },
  listed: { ok: boolean; error?: string },
  entryCount: number,
  dead: string[],
  errors: string[],
  warns: string[],
): string {
  if (landed.wrong.length > 0) return installedNote(path.basename(homeDir), landed.wrong)
  if (!listed.ok) return `取不到证:plugin-manager.list 没回(${listed.error ?? '没说原因'})`
  if (dead.length > 0) return `这几条没挂上(fiber 没到 ACTIVE):${dead.join('、')}——日志里有原因`
  if (errors.length > 0) return `重新加载之后日志里新增 ${String(errors.length)} 条 error,别当它验过了:\n${errors.join('\n')}`
  return `装上的是这次的版本号(${landed.rows.map((row) => `${row.pkg}@${row.expected}`).join('、')}),${String(entryCount)} 条条目都在运行,日志新增部分里没有 error${warns.length > 0 ? `(有 ${String(warns.length)} 条 warn,另看)` : ''}`
}

/** 三样：装上的就是这次发的版本号；条目的 fiber 真的是 ACTIVE；日志从基线往后没有 error。只在 runDev 里调用：判断要基线 */
export async function collect(
  home: string,
  homeDir: string,
  shipped: ShippedPackage[],
  logFile: string,
  baseline: number,
  deps: DevDeps,
): Promise<Evidence> {
  const landed = checkInstalled(homeDir, shipped, deps.readText)
  const listed = receiptOf((await deps.cdp(home, ['cmd', 'plugin-manager.list'], CDP_TIMEOUT_MS)).data)
  const entries: Evidence['entries'] = []
  const dead: string[] = []
  for (const one of shipped) {
    for (const entry of entriesOf(listed.data, one.pkg)) {
      entries.push({ pkg: one.pkg, entryId: entry.entryId, active: entry.active })
      if (!entry.active) dead.push(`${entry.entryId}(${one.pkg})`)
    }
  }
  const { errors, warns } = errorLines(deps.slice(logFile, baseline))
  const ok = landed.wrong.length === 0 && listed.ok && dead.length === 0 && errors.length === 0
  const note = evidenceNote(homeDir, landed, listed, entries.length, dead, errors, warns)
  return { ok, installed: landed.rows, entries, dead, errors, warns, note }
}
