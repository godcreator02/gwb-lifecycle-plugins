import path from 'node:path'
import { homePnpmPlan, type RunPlan } from './dev.js'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'
import { isRecord } from './vocab.js'
import { bareImage, type ProcessProbe } from './probes.js'

/** home 名的形状，就是内核 `GWB_HOME` 的校验正则：比它严没有意义，名字最终由内核决定收不收 */
export const HOME_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 每个 home 里的运行时记录。内核与 gwb-mcp 写，本包只读；进程退出了记录不删，读的人负责确认进程还在 */
export const RECORD_FILE = 'runtime.json'

/** 日常用的那个 home 的名字。删它要 `force` */
export const DAILY_HOME = 'default'

/** 启动之后确认不是刚启动就退出的观察时间与轮询间隔 */
export const ALIVE_TIMEOUT_MS = 5_000
export const ALIVE_POLL_MS = 500

/** 前台命令（安装基础插件）失败时回执带输出的最后几行 */
export const RUN_TAIL_LINES = 40

/** 自动选调试端口从这里起找。避开 9222 与 93xx：人手工启动 home 常用这几个，撞上会把人手工开的窗口挤掉 */
export const CDP_PORT_BASE = 9400

/** 往上找多少个。找不到说明这台机器上出了别的事，照实报 */
export const CDP_PORT_TRIES = 50

// ── 运行时记录 ────────────────────────────────────────────────────────────────

/** MCP 入口绑定的端口与地址。绑定成功之后由那个插件补进记录，没装或没绑定成功就没有这个字段 */
export interface DoorEndpoint {
  port: number
  url: string
}

/** 一个 home 此刻的运行时身份。**本包只读不写** */
export interface HomeRecord {
  pid: number
  startedAt: number
  /** electron 启动的那个应用目录，给人看的出处 */
  appDir?: string
  /** Chromium 调试端口；启动时没带那个开关就没有这个字段。它是连上这个 home 的唯一入口 */
  cdp?: number
  /** gwb-mcp 补的 `mcp` 字段 */
  mcp?: DoorEndpoint
  /** 更早的 command-http 插件补的 `command-http` 字段，旧 home 的记录里还有，照读、只作参考 */
  commandHttp?: DoorEndpoint
}

export function recordFile(homeDir: string): string {
  return path.join(homeDir, RECORD_FILE)
}

/** 1–65535 的整数才算端口，别的一律当没给 */
function asPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536 ? value : undefined
}

function endpointOf(value: unknown): DoorEndpoint | undefined {
  if (!isRecord(value)) return undefined
  const port = asPort(value.port)
  return port !== undefined && typeof value.url === 'string' && value.url !== ''
    ? { port, url: value.url }
    : undefined
}

/** 半截 JSON、形状不对、pid 不是正整数，一律当没有：残缺的记录不该导出任何动作。少一个可选字段不算坏记录 */
export function parseRecord(text: string | undefined): HomeRecord | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(doc)) return undefined
  const { pid, startedAt, appDir, cdp, mcp, 'command-http': commandHttp } = doc
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  const mcpEndpoint = endpointOf(mcp)
  const commandHttpEndpoint = endpointOf(commandHttp)
  const cdpPort = asPort(cdp)
  return {
    pid,
    startedAt,
    ...(typeof appDir === 'string' && appDir !== '' ? { appDir } : {}),
    ...(cdpPort === undefined ? {} : { cdp: cdpPort }),
    ...(mcpEndpoint === undefined ? {} : { mcp: mcpEndpoint }),
    ...(commandHttpEndpoint === undefined ? {} : { commandHttp: commandHttpEndpoint }),
  }
}

// ── 命名 ──────────────────────────────────────────────────────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间的 `yyMMddHHmm`，home 名里的时间部分 */
export function minuteStamp(now: number): string {
  const nowDate = new Date(now)
  const yy = pad(nowDate.getFullYear() % 100)
  return `${yy}${pad(nowDate.getMonth() + 1)}${pad(nowDate.getDate())}${pad(nowDate.getHours())}${pad(nowDate.getMinutes())}`
}

/** 分钟粒度重名了才用的秒级格式 */
export function secondStamp(now: number): string {
  return `${minuteStamp(now)}${pad(new Date(now).getSeconds())}`
}

export function composeName(short: string, now: number): string {
  return `${short}-${minuteStamp(now)}`
}

/** 先试分钟；重名了改用秒；再重名就拒，不悄悄加序号（名字里每一段都要能读出时间） */
export function nextName(short: string, now: number, exists: (name: string) => boolean): string {
  const minute = composeName(short, now)
  if (!exists(minute)) return minute
  const second = `${short}-${secondStamp(now)}`
  if (!exists(second)) return second
  throw new Error(
    `同一分钟里 ${short}- 开头的 home 已经有两个(${minute}、${second} 都在)——换个 short,或等下一分钟`,
  )
}

// ── 启动计划 ──────────────────────────────────────────────────────────────────

/**
 * 映像名不是 electron 就是安装版；开发态的应用目录取 `argv[1]`（`electron <路径>` 启动时命令行上就有）。
 * 不 import `electron` 模块：产物里不许有没列进依赖的包名 import
 */
export function hostAppFacts(execPath: string, argv: readonly string[]): { packaged: boolean; appPath?: string } {
  if (bareImage(path.basename(execPath)) !== 'electron') return { packaged: true }
  const appPath = argv[1]
  return appPath === undefined || appPath === '' ? { packaged: false } : { packaged: false, appPath }
}

/**
 * 启动宿主自己那个 exe（安装版同样认 `GWB_HOME`）。调试端口放在命令行上：内核不认调试相关的环境变量；
 * 同时带 `--disable-backgrounding-occluded-windows`，窗口被挡住时 Chromium 才不会停止出新帧
 */
export function hostAppSpawnPlan(
  facts: { execPath: string; packaged: boolean; appPath?: string },
  cdp?: number,
): { command: string; args: string[]; cwd: string } {
  const flags =
    cdp === undefined ? [] : [`--remote-debugging-port=${String(cdp)}`, '--disable-backgrounding-occluded-windows']
  if (facts.packaged) {
    return { command: facts.execPath, args: flags, cwd: path.dirname(facts.execPath) }
  }
  if (facts.appPath === undefined || facts.appPath === '') {
    throw new Error(
      '宿主是开发态 electron,而命令行上读不出应用目录——devkit 只从安装版起 home;内核源码的验机见内核仓 AGENTS「怎么跑」',
    )
  }
  return { command: facts.execPath, args: [facts.appPath, ...flags], cwd: facts.appPath }
}

/**
 * 去掉 `ELECTRON_RUN_AS_NODE`：会启动 node 子进程的插件带着它，漏进来启动的就不是窗口而是一个看不见的 node；
 * `npm_config_*` 一并去掉，这个窗口不该受它是从哪个环境里启动的影响
 */
export function guiChildEnv(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) continue
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    childEnv[key] = env[key]
  }
  childEnv.GWB_HOME = name
  return childEnv
}

// ── 参数 ──────────────────────────────────────────────────────────────────────

/** 不合格回 undefined，调用方连用法一起回 */
export function asHomeName(value: unknown): string | undefined {
  return typeof value === 'string' && HOME_NAME_RE.test(value) ? value : undefined
}

// ── 注入的依赖 ────────────────────────────────────────────────────────────────

/**
 * 读不了一律回「没有」。`removeDir` 的错误必须往上抛：EBUSY/EPERM 是「目录还被进程占着」的唯一线索，
 * 吞掉它人看到的就是「删掉了」
 */
export interface HomeFs {
  exists(target: string): boolean
  readText(file: string): string | undefined
  writeText(file: string, text: string): void
  remove(file: string): void
  /** 递归建出目录 */
  ensureDir(dir: string): void
  /** 目录下的子目录名（不含文件）；读不了回空表 */
  dirs(target: string): string[]
  removeDir(dir: string): { ok: true } | { ok: false; error: string }
}

export interface HomeDeps {
  fs: HomeFs
  /** 启动一个 detached、窗口可见的子进程，回它的 pid；启动不了回 undefined */
  spawn(plan: { command: string; args: string[]; cwd: string }, env: NodeJS.ProcessEnv): number | undefined
  /** 再启动一次宿主应用的命令行，由宿主进程自报的事实拼出来（见 hostAppSpawnPlan） */
  appSpawnPlan(cdp?: number): Promise<{ command: string; args: string[]; cwd: string }>
  /** 前台运行一条命令到结束：成没成，加输出的最后几行 */
  run(
    plan: RunPlan,
    timeoutMs: number,
  ): Promise<{ ok: boolean; tail: string }>
  /** 查 pid 对应的进程：running / gone / unknown 三种（见 probes 的 ProcessProbe） */
  processName(pid: number): Promise<ProcessProbe>
  portOwner(port: number): Promise<number | undefined>
  /** 结束一个进程：'killed' / 'gone'，别的失败一律抛 */
  kill(pid: number): 'killed' | 'gone'
  sleep(ms: number): Promise<void>
  now(): number
  /** 启动子进程用的可执行文件（宿主进程自己那个） */
  execPath: string
  /** 启动子进程的环境，经 guiChildEnv 处理 */
  env: NodeJS.ProcessEnv
}

// ── 确认进程还在 ──────────────────────────────────────────────────────────────

/** 认 electron 与宿主自己的映像名（安装版的 exe 名是产品名）；不认 node：认了只会在 pid 被复用时多误判 */
export function isHomeProcess(name: string | undefined, execPath: string): boolean {
  if (name === undefined || name.trim() === '') return false
  const image = bareImage(name.trim())
  return image === 'electron' || image === bareImage(execPath)
}

/** 记录里那个 pid 此刻是不是 home 进程。「查不出」回 undefined，不导出动作 */
function recordedPidIsHomeProcess(probe: ProcessProbe, execPath: string): boolean | undefined {
  if (probe.state === 'unknown') return undefined
  if (probe.state === 'gone') return false
  return isHomeProcess(probe.name, execPath)
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

export type LaunchOutcome =
  | { ok: true; name: string; home: string; pid: number; record?: HomeRecord; note: string }
  | { ok: false; error: string }

export interface LaunchInput {
  name: string
  homesRoot: string
  /** 给了就在命令行上加 `--remote-debugging-port` */
  cdp?: number
  /**
   * 给了就在启动之前把内核包（这个精确版本）、cordis 与基础插件装进 home、写 cordis.yml 条目（只有 home.new 用）。
   * 启动器只从 home 里加载内核，home 里没有内核包就启动不了。`pnpm` 是 `locatePnpm` 找到并核对过版本的可执行文件
   */
  install?: { kernelVersion: string; pnpm: string }
}

// ── 装进新 home 的包：内核包、cordis 与基础插件 ────────────────────────────────

/** 一个开箱能用的测试 home 最少要装的插件。写死、不做参数：要加别的，装完再 `plugin-manager.install` */
export const BASE_PLUGINS: ReadonlyArray<{ id: string; pkg: string }> = [
  { id: 'commands', pkg: '@godcreator/gwb-commands' },
  { id: 'shell', pkg: '@godcreator/gwb-shell' },
  { id: 'data', pkg: '@godcreator/gwb-data' },
  { id: 'settings', pkg: '@godcreator/gwb-settings' },
  { id: 'skills', pkg: '@godcreator/gwb-skills' },
  { id: 'plugin-manager', pkg: '@godcreator/gwb-plugin-manager' },
  { id: 'baseui', pkg: '@godcreator/gwb-baseui' },
] as const

/** 基础插件的 cordis.yml 内容 */
export function baseYaml(): string {
  return BASE_PLUGINS.map((p) => `- id: ${p.id}\n  name: '${p.pkg}'`).join('\n') + '\n'
}

/** 在 home 里运行 `pnpm add <args…>` 的命令行：直接启动 pnpm 的原生可执行文件，不自动补装缺的 peer */
function pnpmAddPlan(home: string, addArgs: string[], pnpm: string): RunPlan {
  return homePnpmPlan(['add', ...addArgs], home, pnpm)
}

/** 装内核包：精确版本带 `--save-exact`。清单里已有 `^` 声明时 pnpm 12 照样写回 `^`、退出码 0 却装上更新的版本（probes/2609241510_pnpm-add-exact-prefix），所以只用在清单里还没有这一项的新 home 上，装完核对版本 */
export function kernelInstallPlan(home: string, kernelVersion: string, pnpm: string): RunPlan {
  return pnpmAddPlan(home, ['--save-exact', `${KERNEL_PACKAGE}@${kernelVersion}`], pnpm)
}

/** 装 cordis：内核包 peer 里写的精确版本、带 `--save-exact`，限制同 `kernelInstallPlan` */
export function cordisInstallPlan(home: string, cordisVersion: string, pnpm: string): RunPlan {
  return pnpmAddPlan(home, ['--save-exact', `cordis@${cordisVersion}`], pnpm)
}

/** 装基础插件：不写版本，取源上的 latest，清单里写 `^` 范围。home 里除了内核包与 cordis 只装插件 */
export function baseInstallPlan(home: string, pnpm: string): RunPlan {
  return pnpmAddPlan(home, BASE_PLUGINS.map((p) => p.pkg), pnpm)
}

/** 装包（内核包、cordis、基础插件各一次）的超时 */
export const BASE_INSTALL_TIMEOUT_MS = 300_000

/** 装进 home 的某个包的清单 */
export function installedManifestFile(home: string, pkg: string): string {
  return path.join(home, 'node_modules', ...pkg.split('/'), 'package.json')
}

/** 装进 home 的内核包清单 */
export function kernelManifestFile(home: string): string {
  return installedManifestFile(home, KERNEL_PACKAGE)
}

/** 装进 home 的包清单：读得出、版本是要装的那个才回清单，否则回拒绝理由 */
export function installedManifestAtVersion(
  manifestText: string | undefined,
  pkg: string,
  expectedVersion: string,
  home: string,
): { ok: true; manifest: Record<string, unknown> } | { ok: false; error: string } {
  const file = installedManifestFile(home, pkg)
  if (manifestText === undefined) return { ok: false, error: `${pkg} 装完了,可它的清单读不到:${file}` }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch (err) {
    return { ok: false, error: `${pkg} 的清单不是合法 JSON(${file}):${String(err)}` }
  }
  if (!isRecord(manifest)) return { ok: false, error: `${pkg} 的清单不是 JSON 对象:${file}` }
  if (manifest.version !== expectedVersion) {
    return { ok: false, error: `要装的 ${pkg} 是 ${expectedVersion},home 里装上的却是 ${String(manifest.version)}(${file})` }
  }
  return { ok: true, manifest }
}

const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

/**
 * 从装上的内核包清单里取它 peer 里的 cordis 版本：home 根上的 cordis 必须是这个精确版本，内核与插件才解析到同一份。
 * 清单读不到、装上的版本不是要装的那个、peer 里的 cordis 不是精确版本号，都拒
 */
export function cordisVersionForKernel(
  manifestText: string | undefined,
  kernelVersion: string,
  home: string,
): { ok: true; cordis: string } | { ok: false; error: string } {
  const installed = installedManifestAtVersion(manifestText, KERNEL_PACKAGE, kernelVersion, home)
  if (!installed.ok) return installed
  const peers = installed.manifest.peerDependencies
  const cordis = isRecord(peers) ? peers.cordis : undefined
  if (typeof cordis !== 'string' || !EXACT_VERSION.test(cordis)) {
    return {
      ok: false,
      error: `内核包 ${KERNEL_PACKAGE}@${kernelVersion} 的 peerDependencies.cordis 是 ${JSON.stringify(cordis)},不是精确版本号:home 根上的 cordis 只能照精确版本装(${kernelManifestFile(home)})`,
    }
  }
  return { ok: true, cordis }
}

/** 运行一条装包命令；失败时回带 pnpm 输出最后几行的拒绝理由 */
async function refusalIfInstallFailed(
  plan: RunPlan,
  what: string,
  whereToLook: string,
  deps: HomeDeps,
): Promise<{ ok: false; error: string } | undefined> {
  const installed = await deps.run(plan, BASE_INSTALL_TIMEOUT_MS)
  if (installed.ok) return undefined
  return { ok: false, error: `${what} 装不上(pnpm add 失败;${whereToLook})。输出的最后几行:\n${installed.tail}` }
}

/**
 * cordis.yml 已存在就不写（内核的规矩也是不覆盖）。依次装内核包、cordis、基础插件：cordis 的精确版本从装上的内核包清单里读；
 * 基础插件装的时候 home 根上已经有 cordis，它们的 peer cordis 解析到同一份。内核包与 cordis 装完都核对版本，哪一步不成都不启动
 */
async function installKernelCordisAndBasePlugins(
  home: string,
  install: { kernelVersion: string; pnpm: string },
  deps: HomeDeps,
): Promise<{ ok: false; error: string } | undefined> {
  const { kernelVersion, pnpm } = install
  if (!deps.fs.exists(path.join(home, 'cordis.yml'))) {
    deps.fs.writeText(path.join(home, 'cordis.yml'), baseYaml())
  }
  const kernelFailure = await refusalIfInstallFailed(
    kernelInstallPlan(home, kernelVersion, pnpm),
    `内核包 ${KERNEL_PACKAGE}@${kernelVersion}`,
    '查源上有没有这个版本、scope 路由、源连不连得上',
    deps,
  )
  if (kernelFailure !== undefined) return kernelFailure
  const cordis = cordisVersionForKernel(deps.fs.readText(kernelManifestFile(home)), kernelVersion, home)
  if (!cordis.ok) return cordis
  const cordisFailure = await refusalIfInstallFailed(cordisInstallPlan(home, cordis.cordis, pnpm), `cordis@${cordis.cordis}`, '查源连不连得上', deps)
  if (cordisFailure !== undefined) return cordisFailure
  const cordisInstalled = installedManifestAtVersion(deps.fs.readText(installedManifestFile(home, 'cordis')), 'cordis', cordis.cordis, home)
  if (!cordisInstalled.ok) return cordisInstalled
  return refusalIfInstallFailed(baseInstallPlan(home, pnpm), '基础插件', '查 scope 路由与源连不连得上', deps)
}

/** 观察一会儿，只抓刚启动就退出：查不出时接着等，只有确定不在了才中断 */
async function refusalIfExitedEarly(pid: number, home: string, deps: HomeDeps): Promise<{ ok: false; error: string } | undefined> {
  const deadline = deps.now() + ALIVE_TIMEOUT_MS
  while (deps.now() < deadline) {
    if ((await deps.processName(pid)).state === 'gone') {
      return {
        ok: false,
        error: `起的进程(pid ${pid})秒退了——多半是装的东西缺了或起的时候就错。看 ${path.join(home, 'gwb.log')}`,
      }
    }
    await deps.sleep(ALIVE_POLL_MS)
  }
  return undefined
}

function recordSeenNote(record: HomeRecord | undefined): string {
  if (record === undefined) return `,但 ${RECORD_FILE} 还没出现——这个内核版本可能还不写它,那么 stop 与「按 home 名定位」都用不了`
  if (record.cdp === undefined) return `,${RECORD_FILE} 里没有 cdp 那格(起的时候没带 --remote-debugging-port?)`
  return `,${RECORD_FILE} 记下了 CDP ${String(record.cdp)}`
}

/** 可能失败的步骤都排在启动进程之前：启动之后再失败，会留下一个没有记录、谁也管不了的窗口 */
export async function launchHome(input: LaunchInput, deps: HomeDeps): Promise<LaunchOutcome> {
  let plan: { command: string; args: string[]; cwd: string }
  try {
    plan = await deps.appSpawnPlan(input.cdp)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const home = path.join(input.homesRoot, input.name)
  // 同一个 home 不许开两个实例：两个窗口写同一份日志，按记录停止只认得记录里那一个
  const existing = parseRecord(deps.fs.readText(recordFile(home)))
  if (existing !== undefined && recordedPidIsHomeProcess(await deps.processName(existing.pid), deps.execPath) === true) {
    return { ok: false, error: `${input.name} 已经有一个实例在运行(pid ${existing.pid})——先停掉它,或直接用那个窗口` }
  }
  // package.json 由装包时的 pnpm add 生成，runtime.json 由内核启动后写，这里只建目录
  deps.fs.ensureDir(home)
  if (input.install !== undefined) {
    const installFailure = await installKernelCordisAndBasePlugins(home, input.install, deps)
    if (installFailure !== undefined) return installFailure
  }
  const pid = deps.spawn(plan, guiChildEnv(deps.env, input.name))
  if (pid === undefined) return { ok: false, error: '起不来:子进程没拿到 pid,看宿主日志' }

  const exitedEarly = await refusalIfExitedEarly(pid, home, deps)
  if (exitedEarly !== undefined) return exitedEarly
  // 观察完再读记录：内核启动时才写它；读不到不算启动失败，回执里说明
  const record = parseRecord(deps.fs.readText(recordFile(home)))
  return {
    ok: true,
    name: input.name,
    home,
    pid,
    ...(record === undefined ? {} : { record }),
    note: `起来了(pid ${pid}${input.cdp === undefined ? '' : `,CDP ${input.cdp}`})${recordSeenNote(record)}——日志在 ${path.join(home, 'gwb.log')}`,
  }
}

// ── 列出 ──────────────────────────────────────────────────────────────────────

export interface HomeEntry {
  name: string
  home: string
  /** 记录里那个 pid，且此刻还活着、认得出；否则 null */
  pid: number | null
  running: boolean
  /** 调试端口。没记录、或那个字段没写，就是 null */
  cdp: number | null
  mcp: DoorEndpoint | null
  /** 更早的 command-http 插件的端口，旧 home 的记录里有，照报只作参考 */
  commandHttp: DoorEndpoint | null
}

/** 名字带着时间戳后缀，字典序就是时间序 */
export async function listHomes(homesRoot: string, deps: HomeDeps): Promise<HomeEntry[]> {
  const entries: HomeEntry[] = []
  for (const name of deps.fs.dirs(homesRoot)) {
    const home = path.join(homesRoot, name)
    const record = parseRecord(deps.fs.readText(recordFile(home)))
    let running = false
    if (record !== undefined) {
      running = recordedPidIsHomeProcess(await deps.processName(record.pid), deps.execPath) === true
    }
    entries.push({
      name,
      home,
      pid: running && record !== undefined ? record.pid : null,
      running,
      // 端口按记录如实报，不因为进程看起来不在就去掉：过时的端口正是人要看到的线索
      cdp: record?.cdp ?? null,
      mcp: record?.mcp ?? null,
      commandHttp: record?.commandHttp ?? null,
    })
  }
  return entries
}

// ── 选调试端口 ────────────────────────────────────────────────────────────────

/** 别的 home 记录里的调试端口，过时的也算占着；`except` 是正要启动的那个 home 自己，它的记录不算 */
export function portsInRecords(homesRoot: string, deps: HomeDeps, except?: string): Set<number> {
  const taken = new Set<number>()
  for (const name of deps.fs.dirs(homesRoot)) {
    if (name === except) continue
    const record = parseRecord(deps.fs.readText(recordFile(path.join(homesRoot, name))))
    if (record?.cdp !== undefined) taken.add(record.cdp)
  }
  return taken
}

/** 先沿用这个 home 上次的端口；被占了才另选：跳过别的 home 记录里的，再从 CDP_PORT_BASE 起找没人监听的 */
export async function pickCdpPort(
  homesRoot: string,
  deps: HomeDeps,
  name?: string,
): Promise<{ port: number; reused: boolean } | undefined> {
  const previousPort = name === undefined ? undefined : parseRecord(deps.fs.readText(recordFile(path.join(homesRoot, name))))?.cdp
  if (previousPort !== undefined && (await deps.portOwner(previousPort)) === undefined) return { port: previousPort, reused: true }
  const taken = portsInRecords(homesRoot, deps, name)
  for (let port = CDP_PORT_BASE; port < CDP_PORT_BASE + CDP_PORT_TRIES; port += 1) {
    if (taken.has(port)) continue
    if ((await deps.portOwner(port)) === undefined) return { port, reused: false }
  }
  return undefined
}

// ── 按名字定位 ────────────────────────────────────────────────────────────────

export type TargetOutcome =
  | { ok: true; name: string; home: string; record: HomeRecord; cdp: number }
  | { ok: false; error: string }

/** 三道都要过：记录读得出；pid 还活着且是 home 进程；那个 pid 真的在监听记录里的端口。「查不出」与「确定不在」分开报 */
export async function resolveTarget(homesRoot: string, name: string, deps: HomeDeps): Promise<TargetOutcome> {
  const home = path.join(homesRoot, name)
  if (!deps.fs.exists(home)) return { ok: false, error: `${home} 不在——没有这个 home(看 devkit.home.list)` }
  const record = parseRecord(deps.fs.readText(recordFile(home)))
  if (record === undefined) {
    return {
      ok: false,
      error: `${name} 里没有能读的 ${RECORD_FILE}——它没起过,或者起它的内核版本还不写这份记录。停掉重开一次就有了`,
    }
  }
  const isHome = recordedPidIsHomeProcess(await deps.processName(record.pid), deps.execPath)
  if (isHome === undefined) return { ok: false, error: `查不出记录里的 pid ${record.pid} 还在不在——没敢认` }
  if (!isHome) return { ok: false, error: `${name} 没在跑(记录里的 pid ${record.pid} 已经不是它了)——先 devkit.home.open` }
  if (record.cdp === undefined) {
    return {
      ok: false,
      error: `${name} 在跑,但记录里没有 cdp 那格——启动它的时候没带 --remote-debugging-port,连不上。停掉它,再用 devkit.home.open 重开一次(调试端口自动选)`,
    }
  }
  const owner = await deps.portOwner(record.cdp)
  if (owner !== undefined && owner !== record.pid) {
    return {
      ok: false,
      error: `记录说 ${name} 的调试端口是 ${record.cdp},可那个端口上监听的是 pid ${owner},不是 ${record.pid}——记录过时了,没敢用`,
    }
  }
  return { ok: true, name, home, record, cdp: record.cdp }
}

// ── 停止 ──────────────────────────────────────────────────────────────────────

export interface StopOutcome {
  ok: boolean
  killed: number | null
  note: string
}

/** 发了停止信号之后等进程真退：轮询间隔与总上限 */
export const EXIT_POLL_MS = 250
export const EXIT_TIMEOUT_MS = 15_000

/** 信号发出去不等于进程没了：electron 放开 home 里的文件要一会儿。查到 gone 才算退了，到点回最后看到的状态 */
export async function waitExited(pid: number, deps: HomeDeps): Promise<{ ok: true } | { ok: false; last: 'running' | 'unknown' }> {
  const maxPolls = Math.ceil(EXIT_TIMEOUT_MS / EXIT_POLL_MS)
  let lastState: 'running' | 'unknown' = 'running'
  for (let i = 0; i <= maxPolls; i += 1) {
    const probe = await deps.processName(pid)
    if (probe.state === 'gone') return { ok: true }
    lastState = probe.state
    if (i < maxPolls) await deps.sleep(EXIT_POLL_MS)
  }
  return { ok: false, last: lastState }
}

/** 核对两次再结束进程：映像名是 home 进程；记录里有调试端口的，监听那个端口的必须是记录里的 pid。结束失败时记录留着 */
export async function bringDownHome(homeDir: string, deps: HomeDeps): Promise<StopOutcome> {
  const record = parseRecord(deps.fs.readText(recordFile(homeDir)))
  if (record === undefined) {
    return { ok: true, killed: null, note: `没有运行时记录(${RECORD_FILE} 不在或读不出)——它没起过,或者起它的内核版本还不写这份记录` }
  }
  const isHome = recordedPidIsHomeProcess(await deps.processName(record.pid), deps.execPath)
  if (isHome === undefined) {
    return { ok: false, killed: null, note: `查不出 pid ${record.pid} 是什么——没敢杀` }
  }
  if (!isHome) {
    // 记录不删：它是「上一次用的哪个端口」的唯一线索，下一次启动内核会整份重写
    return { ok: true, killed: null, note: `pid ${record.pid} 已陈旧(进程不在,或不是它)——没什么可停的` }
  }
  if (record.cdp !== undefined) {
    const owner = await deps.portOwner(record.cdp)
    if (owner !== undefined && owner !== record.pid) {
      return {
        ok: false,
        killed: null,
        note: `CDP ${record.cdp} 端口上监听的是 pid ${owner},记录里写的是 ${record.pid}——对不上,没敢杀(记录留着)`,
      }
    }
  }
  let killed: 'killed' | 'gone'
  try {
    killed = deps.kill(record.pid)
  } catch (err) {
    return { ok: false, killed: null, note: `停 pid ${record.pid} 没成:${String(err)}——进程还在` }
  }
  if (killed === 'gone') {
    return { ok: true, killed: null, note: `pid ${record.pid} 已过时(结束时进程已经不在了)` }
  }
  const exited = await waitExited(record.pid, deps)
  if (!exited.ok) {
    return {
      ok: false,
      killed: null,
      note:
        exited.last === 'running'
          ? `给 pid ${record.pid} 发了停止信号,等了 ${String(EXIT_TIMEOUT_MS / 1000)} 秒它还在——进程没退(记录留着)`
          : `给 pid ${record.pid} 发了停止信号,之后 ${String(EXIT_TIMEOUT_MS / 1000)} 秒一直查不出它还在不在——不当它退了(记录留着)`,
    }
  }
  return { ok: true, killed: record.pid, note: `已停 pid ${record.pid}(进程已退)` }
}

// ── 删除 ──────────────────────────────────────────────────────────────────────

export interface RemoveOutcome {
  ok: boolean
  note: string
}

/** 删目录最多试几次、两次之间等多久。刚停的 home 的子进程几秒内就放开句柄 */
export const REMOVE_TRIES = 5
export const REMOVE_RETRY_MS = 1_000

/**
 * 还在运行的先停再删；停了的话回停止说明（人得知道自己顺带结束了一个进程）。
 * `default` 正在运行时带 `force` 也不停它；「查不出还在不在」时不删
 */
async function stopBeforeRemoving(homeDir: string, daily: boolean, force: boolean, deps: HomeDeps): Promise<{ ok: false; note: string } | { ok: true; stoppedNote?: string }> {
  const record = parseRecord(deps.fs.readText(recordFile(homeDir)))
  if (record === undefined) return { ok: true }
  const isHome = recordedPidIsHomeProcess(await deps.processName(record.pid), deps.execPath)
  if (isHome === undefined) {
    return { ok: false, note: `查不出记录里的 pid ${record.pid} 还在不在——没敢删,先看一眼` }
  }
  if (isHome && !force) {
    return { ok: false, note: `还在跑(pid ${record.pid})——带 force: true 连停带删` }
  }
  if (isHome && daily) {
    return { ok: false, note: `${DAILY_HOME} 正跑着(pid ${record.pid})——这是日常用的 home,不替你关它。自己关掉那个窗口再来删` }
  }
  if (!isHome) return { ok: true }
  const stopped = await bringDownHome(homeDir, deps)
  if (!stopped.ok) return { ok: false, note: `没删:停它没成——${stopped.note}` }
  return { ok: true, stoppedNote: stopped.note }
}

/** 删的调用不报错不等于目录没了：每删一次核对一次，还在就隔一会儿再删 */
async function removeDirWithRetries(homeDir: string, deps: HomeDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  let lastAttempt = deps.fs.removeDir(homeDir)
  for (let attempt = 1; attempt < REMOVE_TRIES && deps.fs.exists(homeDir); attempt += 1) {
    await deps.sleep(REMOVE_RETRY_MS)
    lastAttempt = deps.fs.removeDir(homeDir)
  }
  return lastAttempt
}

/** `force` 越过两处检查：还在运行时停了再删；`default` 确实要删。两处不叠加 */
export async function removeHome(homeDir: string, name: string, force: boolean, deps: HomeDeps): Promise<RemoveOutcome> {
  const daily = name === DAILY_HOME
  if (daily && !force) {
    return { ok: false, note: `${DAILY_HOME} 是日常那份 home,不删。真要删,带 force: true` }
  }
  if (!deps.fs.exists(homeDir)) {
    return { ok: false, note: `${homeDir} 不在——没有这个 home(看 devkit.home.list)` }
  }
  const stopping = await stopBeforeRemoving(homeDir, daily, force, deps)
  if (!stopping.ok) return stopping
  const stoppedNote = stopping.stoppedNote
  const lastAttempt = await removeDirWithRetries(homeDir, deps)
  if (deps.fs.exists(homeDir)) {
    const left = deps.fs.dirs(homeDir)
    const rest = left.length === 0 ? '' : `(还剩 ${left.slice(0, 5).join('、')}${left.length > 5 ? ' 等' : ''})`
    const stopped = stoppedNote === undefined ? '' : `删之前停了它:${stoppedNote}。`
    return {
      ok: false,
      note: `没删掉:删了 ${String(REMOVE_TRIES)} 次(每次间隔 ${String(REMOVE_RETRY_MS / 1000)} 秒),${homeDir} 还在${rest}。${stopped}${lastAttempt.ok ? '最后一次删的调用没报错,可目录没走' : `最后一次删的调用报:${lastAttempt.error}`}——还有进程握着里面的文件(终端、编辑器开在里面,或者这个 home 的 electron 子进程没退),关掉再删`,
    }
  }
  return { ok: true, note: `已删 ${name}(${homeDir})${stoppedNote === undefined ? '' : `——删之前先停了它:${stoppedNote}`}` }
}
