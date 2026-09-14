import path from 'node:path'
import { isRecord } from '@team/gwb-plugin-api'
import { bareImage, type ProcessProbe } from './probes.js'

/**
 * 测试 home 的纯机:命名、启动计划、起/停/删的时序与守卫。
 *
 * 开测试 home 的纪律(一次验开一个新 home、清理放在开新那一刻)是 devkit 手册与内核
 * 仓 gwb-test skill 的正典,这儿只管把那几步做成命令:名字怎么起、electron 怎么拉、
 * 记录怎么读、停与删之前核对什么。
 *
 * **碰盘与开进程的能力全走注入**(`HomeDeps`),整条时序在测试里用假件跑得完——
 * 「查不出 pid 就不敢杀」「default 不许删」这类守卫,恰恰是只在边角上才现形的判断。
 */

/** home 名的形状。这就是内核 `GWB_HOME` 的验收正则——比它严没有意义,名字到头来是它说了算 */
export const HOME_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 每个 home 里那份运行时记录。一个 home 一份,home 删了它自然也没了。
 *
 * **写它的不是 devkit,是内核与门插件**(2026-09-11 起):内核开机整份重写 pid / startedAt /
 * appDir / cdp,gwb-mcp 绑上口之后读改写补 `mcp` 那格（2026-09-14 复位起唯一的门；前一门
 * command-http 补的 `command-http` 格在老 home 的记录里还在,读的人当线索看）。判据是「谁知道那个数」——CDP 口是 Chromium
 * 的命令行开关,只有起进程的那只手知道,而**内核是唯一必然在场的那个进程**;门的口绑成功
 * 之后才定下来,只有那个件手里有。devkit 从前自己写一份 `devkit.json`,那份只覆盖得了它自己
 * 起的 home,容器里十八个 home 只有一个有记录,所以退役。
 *
 * **进程退了不删**:崩溃与被 kill 是常态,「退出时删」在那两种情况下本来就不会跑。读的人
 * 负责验活(pid 还在,且那个 pid 真的持着记录里那个端口)。
 */
export const RECORD_FILE = 'runtime.json'

/** 日常那份 home 的名字。删它要 `force`——那是人每天住的地方,不是验完就删的 */
export const DAILY_HOME = 'default'

/** `home.new` 里那条 build 的上限。内核那条 build 是 tsc 直出,平时几秒,三分钟还完不成就是卡了 */
export const BUILD_TIMEOUT_MS = 180_000

/** 起了之后确认「不是秒退」的观察窗与轮询间隔 */
export const ALIVE_TIMEOUT_MS = 5_000
export const ALIVE_POLL_MS = 500

/** build 失败回给人的输出尾巴行数。全量输出没人读,要的是最后那段报错 */
export const BUILD_TAIL_LINES = 40

/**
 * 自动挑调试口时从这儿起找。**避开 9222 与 93xx 那一段**:那几个是人手工起 home 时常敲的数,
 * 撞上就是自动挑的口把人手工那扇窗顶掉。
 */
export const CDP_PORT_BASE = 9400

/** 往上找多少个。找不到就是这台机器上出了别的事,照实报,不静默放弃调试口 */
export const CDP_PORT_TRIES = 50

// ── 启动记录 ──────────────────────────────────────────────────────────────────

/** 一道门绑在哪。绑成功之后由门插件补进记录,没开那道门就没有这一格 */
export interface DoorEndpoint {
  port: number
  url: string
}

/** 一个 home 此刻的运行时身份。**本包只读不写** */
export interface HomeRecord {
  pid: number
  startedAt: number
  /** electron 起的那个应用目录——给人看的出处 */
  appDir?: string
  /** Chromium 调试口;没开这道口就没有这一格。它是「够得着这个 home」的唯一入口 */
  cdp?: number
  /** MCP 门（gwb-mcp 补的 `mcp` 格）——2026-09-14 复位起是唯一的门 */
  mcp?: DoorEndpoint
  /** 前一门 command-http 补的 `command-http` 格——门已搁置,老 home 的记录里还有,照读给人看线索 */
  commandHttp?: DoorEndpoint
}

export function recordFile(homeDir: string): string {
  return path.join(homeDir, RECORD_FILE)
}

/** 端口值收窄:1–65535 的整数才算,别的一律当没给 */
function asPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536 ? value : undefined
}

/**
 * 记录文件的内容 → 一份像样的记录。半截 JSON、形状不对、pid 不是正整数,一律当没有
 ——与 registry 的 `parsePid` 同一个道理:残缺的记录不该导出任何一个动作。
 *
 * **少一格不算坏**:`cdp` 只有起的时候带了那个开关才有,`mcp` 只有装了门且绑成了才有,
 * `appDir` 是旧版内核可能没写的。缺哪格就是那件事没发生,不是这份记录不能用。
 */
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
  const door = (value: unknown): DoorEndpoint | undefined => {
    if (!isRecord(value)) return undefined
    const port = asPort(value.port)
    return port !== undefined && typeof value.url === 'string' && value.url !== ''
      ? { port, url: value.url }
      : undefined
  }
  const mcpDoor = door(mcp)
  const httpDoor = door(commandHttp)
  const port = asPort(cdp)
  return {
    pid,
    startedAt,
    ...(typeof appDir === 'string' && appDir !== '' ? { appDir } : {}),
    ...(port === undefined ? {} : { cdp: port }),
    ...(mcpDoor === undefined ? {} : { mcp: mcpDoor }),
    ...(httpDoor === undefined ? {} : { commandHttp: httpDoor }),
  }
}

// ── 命名 ──────────────────────────────────────────────────────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间的 `yyMMddHHmm`——gwb-test skill 定的命名法的时间半段 */
export function minuteStamp(now: number): string {
  const at = new Date(now)
  const yy = pad(at.getFullYear() % 100)
  return `${yy}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`
}

/** 秒级的退让格式:分钟粒度撞了(同一分钟开过)才用它 */
export function secondStamp(now: number): string {
  return `${minuteStamp(now)}${pad(new Date(now).getSeconds())}`
}

export function composeName(short: string, now: number): string {
  return `${short}-${minuteStamp(now)}`
}

/**
 * 这个时刻该开的 home 名。分钟粒度先试;那个名字已被占用就退到秒;再占就是同一分钟里
 开过两个同前缀的 home——照实拒,不静默加序号(名号里每一段都得能读出时间)。
 */
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

/** 内核 GUI 所在的目录:build 在这儿跑,electron 也在这儿 */
export function appDirOf(kernelDir: string): string {
  return path.join(kernelDir, 'apps', 'desktop')
}

/** electron 本体。包名固定、发布形状固定,只有可执行文件名随平台 */
export function electronBinOf(appDir: string, platform: NodeJS.Platform): string {
  return path.join(appDir, 'node_modules', 'electron', 'dist', platform === 'win32' ? 'electron.exe' : 'electron')
}

/**
 * 起 electron 的命令行:cwd 给 apps/desktop,应用路径就是 `.`——手工那几步的原样。
 *
 * **CDP 调试口走命令行,不走环境变量**:内核不认识任何调试相关的环境变量,
 * `--remote-debugging-port` 是 Chromium 自己的开关,命令行上就生效。
 */
export function guiSpawnPlan(appDir: string, platform: NodeJS.Platform, cdp?: number): {
  command: string
  args: string[]
  cwd: string
} {
  return {
    command: electronBinOf(appDir, platform),
    args: cdp === undefined ? ['.'] : ['.', `--remote-debugging-port=${String(cdp)}`],
    cwd: appDir,
  }
}

/**
 * build 那条命令。内核的 `pnpm build` 是 tsc 直出到 `dist/`,没有打包器。
 * Windows 上 pnpm 是 `.cmd`,不借 `cmd /c` 一层就 ENOENT。
 */
export function buildPlan(appDir: string, platform: NodeJS.Platform): {
  command: string
  args: string[]
  cwd: string
} {
  const args = ['build']
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'pnpm', ...args], cwd: appDir }
    : { command: 'pnpm', args, cwd: appDir }
}

/**
 * 给测试 home 的环境。**剥掉 `ELECTRON_RUN_AS_NODE`**:件跑在 Electron 主进程里,
 起 node 子进程的件(gwb-node-cli 那种)会带上它;漏进这儿,起的就不是一扇窗而是一个
 看不见的 node。`npm_config_*` 同 registry 的道理一并剥——这个 GUI 不该被「它是从
 哪个环境里点起来的」影响。
 */
export function guiChildEnv(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) continue
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    out[key] = env[key]
  }
  out.GWB_HOME = name
  return out
}

// ── 参数收窄 ──────────────────────────────────────────────────────────────────

/** 参数里的名字 → 合格的名字;不合格回 undefined,调用方连 USAGE 一起回(错误即文档) */
export function asHomeName(value: unknown): string | undefined {
  return typeof value === 'string' && HOME_NAME_RE.test(value) ? value : undefined
}

// ── 注入面 ────────────────────────────────────────────────────────────────────

/**
 * 碰盘那一半。读不动一律回「没有」。`removeDir` 与 registry 的 `remove` 不同:**错误
 必须上抛给人**——EBUSY/EPERM 是「目录还被进程占着」的唯一线索,吞掉它,人看到的就是
 「删掉了」,而那个 home 还在盘上。
 */
export interface HomeFs {
  exists(target: string): boolean
  readText(file: string): string | undefined
  writeText(file: string, text: string): void
  remove(file: string): void
  /** 建出 target 的父目录(递归)。落启动记录前用:目录此刻多半还不存在 */
  ensureDir(dir: string): void
  /** 目录下的子目录名(不含文件);读不动回空表 */
  dirs(target: string): string[]
  removeDir(dir: string): { ok: true } | { ok: false; error: string }
}

export interface HomeDeps {
  fs: HomeFs
  /** 起一个 detached、**窗口可见**的子进程,回它的 pid;起不来回 undefined */
  spawn(plan: { command: string; args: string[]; cwd: string }, env: NodeJS.ProcessEnv): number | undefined
  /** 前台跑一条命令到结束:成没成,加输出尾巴(build 失败时人要看的就是它) */
  run(
    plan: { command: string; args: string[]; cwd: string },
    timeoutMs: number,
  ): Promise<{ ok: boolean; tail: string }>
  /** 查 pid 对应的进程:running / gone / unknown 三态(见 probes 的 ProcessProbe) */
  processName(pid: number): Promise<ProcessProbe>
  portOwner(port: number): Promise<number | undefined>
  /** 停一个进程:'killed' / 'gone',别的失败一律抛 */
  kill(pid: number): 'killed' | 'gone'
  sleep(ms: number): Promise<void>
  now(): number
  /** 起子进程用的可执行文件(宿主进程自己那个) */
  execPath: string
  /** 起子进程的环境底稿,进 guiChildEnv 过一遍 */
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

// ── pid 判活 ──────────────────────────────────────────────────────────────────

/**
 * 这个映像名算不算「那个测试 home」。**认 `electron`,外加宿主自己**:测试 home 的
 本体永远是仓里那份 electron,而宿主在开发态恰好也是同一个 exe,打包后名字对不上——
 所以两头都认。**node 不认**:registry 那半的子进程是纯 node,这半不是;把 node 也认
 进来只会放宽 pid 复用时的误判面。
 */
export function isHomeProcess(name: string | undefined, execPath: string): boolean {
  if (name === undefined || name.trim() === '') return false
  const image = bareImage(name.trim())
  return image === 'electron' || image === bareImage(execPath)
}

/** 探测结果 → 还在不在我们手写记录所指的那个进程。「查不出」回 undefined,不导出动作 */
function ownedProbe(probe: ProcessProbe, execPath: string): boolean | undefined {
  if (probe.state === 'unknown') return undefined
  if (probe.state === 'gone') return false
  return isHomeProcess(probe.name, execPath)
}

// ── 起 ────────────────────────────────────────────────────────────────────────

export type LaunchOutcome =
  | { ok: true; name: string; home: string; pid: number; record?: HomeRecord; note: string }
  | { ok: false; error: string }

export interface LaunchInput {
  name: string
  homesRoot: string
  kernelDir: string
  /** 带了就在命令行上加 `--remote-debugging-port`——CDP 取证那条路子的入口 */
  cdp?: number
  /** 给了就先跑,失败即失败;不给(open 的路)就不 build */
  build?: { command: string; args: string[]; cwd: string }
  /** 给了就在起内核前铺底座：写 cordis.yml 条目 + pnpm add 基础件（只有 home.new 用） */
  base?: boolean
}

// ── 底座 ──────────────────────────────────────────────────────────────────────

/**
 * 底座件集——一个「开箱能用」的测试 home 最少要装的。**写死、不做参数**：
 * 底座是个概念（命令总线、外壳、数据、设置、说明书、插件管理、基础窗格皮），不是一张可定制的购物清单。
 * 要加东西，装完再 `plugin-manager.install`。
 */
export const BASE_PLUGINS: ReadonlyArray<{ id: string; pkg: string }> = [
  { id: 'commands', pkg: '@team/gwb-commands' },
  { id: 'shell', pkg: '@team/gwb-shell' },
  { id: 'data', pkg: '@team/gwb-data' },
  { id: 'settings', pkg: '@team/gwb-settings' },
  { id: 'skills', pkg: '@team/gwb-skills' },
  { id: 'plugin-manager', pkg: '@team/gwb-plugin-manager' },
  { id: 'baseui', pkg: '@team/gwb-baseui' },
] as const

/** 共享包——不是插件（不进 cordis.yml），但必须是 home 的直接依赖，否则外壳起不来 */
export const BASE_SHARED: readonly string[] = [
  '@team/gwb-shared-react',
  '@team/gwb-tokens',
  '@team/gwb-plugin-api',
] as const

/** 底座的 cordis.yml 内容 */
export function baseYaml(): string {
  return BASE_PLUGINS.map((p) => `- id: ${p.id}\n  name: '${p.pkg}'`).join('\n') + '\n'
}

/** 底座的 pnpm add 命令行（Windows 上 pnpm 是 .cmd，要过 cmd /c） */
export function baseInstallPlan(home: string, platform: NodeJS.Platform): {
  command: string
  args: string[]
  cwd: string
} {
  const all = [...BASE_PLUGINS.map((p) => p.pkg), ...BASE_SHARED]
  const args = ['add', ...all]
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'pnpm', ...args], cwd: home }
    : { command: 'pnpm', args, cwd: home }
}

/** 底座安装的超时——pnpm add 一批包，给足 5 分钟 */
export const BASE_INSTALL_TIMEOUT_MS = 300_000

/**
 * 把一个测试 home 拉起来:先 build(要的话)、起 electron、观察五秒确认不是秒退,最后读一眼
 内核落下的那份记录。
 *
 * **build 放在最前面且失败即失败**:「改了内核没 build,起的是上一次的 out/」是实机
 验证最隐蔽的一种空验——界面看着一切正常,验的是旧代码。所以默认 build 是这条命令的
 正身,不是可省的 optimization。
 *
 * **detached 但不 `windowsHide`**:测试 home 要活过宿主退出,可它也得让人看得见——
 registry 那半 hide 是给后台守护的,这半恰恰相反。子进程 stdio ignore:起得来之后的
 日志全在 `homes/<名>/gwb.log`,那儿才是它的嘴。
 *
 * 「起没起来」没有 ping 可打——**「进程还活着」是此刻唯一拿得到的信号**,五秒观察窗
 只为抓住「秒退」(产物不在、端口被占)这一种最常见的死法;真正成没成,窗与人说了算。
 */
export async function launchHome(input: LaunchInput, deps: HomeDeps): Promise<LaunchOutcome> {
  const appDir = appDirOf(input.kernelDir)
  const electronBin = electronBinOf(appDir, deps.platform)
  if (!deps.fs.exists(electronBin)) {
    return {
      ok: false,
      error: `${electronBin} 不在——electron 的二进制没装?进 ${appDir} 跑 pnpm install(electron 的二进制靠包里那条显式 postinstall 装)`,
    }
  }
  if (input.build !== undefined) {
    const done = await deps.run(input.build, BUILD_TIMEOUT_MS)
    if (!done.ok) {
      return {
        ok: false,
        error: `build 没成,electron 没起——产物不新就起,验的是旧代码,这一下不能省。输出尾巴:\n${done.tail}`,
      }
    }
  }
  const home = path.join(input.homesRoot, input.name)
  // 同一个 home 不许开两个实例:记录里的 pid 还活着就拒——两扇窗写同一份日志、同一个
  // home,而 stop 只认得住记录里那一个
  const existing = parseRecord(deps.fs.readText(recordFile(home)))
  if (existing !== undefined && ownedProbe(await deps.processName(existing.pid), deps.execPath) === true) {
    return { ok: false, error: `${input.name} 已经有一个实例在跑(pid ${existing.pid})——先 stop,或直接用那扇窗` }
  }
  // 目录先虚位以待,再拉进程:**所有还会摔的步骤都排在 spawn 前面**——spawn 之后的
  // 失败留下一扇没记录的窗,谁也管不着它。home 的最小形态(package.json 与空 cordis.yml)
  // 与那份 runtime.json 都归内核自己铺,而那要等它起来;devkit 只建目录
  deps.fs.ensureDir(home)
  // 铺底座：在起内核之前把 cordis.yml 写好、包装好——内核一睁眼就是一个能用的家。
  // **只在文件还不存在时写**（内核的规矩也是不覆盖）：open 已有 home 不会走到这儿（不带 base）
  if (input.base === true) {
    if (!deps.fs.exists(path.join(home, 'cordis.yml'))) {
      deps.fs.writeText(path.join(home, 'cordis.yml'), baseYaml())
    }
    const install = baseInstallPlan(home, deps.platform)
    const installed = await deps.run(install, BASE_INSTALL_TIMEOUT_MS)
    if (!installed.ok) {
      return {
        ok: false,
        error: `底座装不上(pnpm add 失败;查 scope 路由与源的连通性)。输出尾巴:\n${installed.tail}`,
      }
    }
  }
  const pid = deps.spawn(guiSpawnPlan(appDir, deps.platform, input.cdp), guiChildEnv(deps.env, input.name))
  if (pid === undefined) return { ok: false, error: '起不来:子进程没拿到 pid,看宿主日志' }

  const deadline = deps.now() + ALIVE_TIMEOUT_MS
  while (deps.now() < deadline) {
    // 查不出时接着等:只有确凿的「它不在了」才值得中断——与 bringUp 的轮询同一个道理
    if ((await deps.processName(pid)).state === 'gone') {
      return {
        ok: false,
        error: `起的进程(pid ${pid})秒退了——多半是产物不在(没 build?)或起的时候就错。看 ${path.join(home, 'gwb.log')}`,
      }
    }
    await deps.sleep(ALIVE_POLL_MS)
  }
  // 观察窗过完再读记录:内核开机时才写它,而这一格是下游「按 home 名找得着它」的全部凭据。
  // **读不到不算起失败**——窗已经在那儿了,只是这个内核版本还不写,或者写晚了
  const record = parseRecord(deps.fs.readText(recordFile(home)))
  const seen =
    record === undefined
      ? `,但 ${RECORD_FILE} 还没出现——这个内核版本可能还不写它,那么 stop 与「按 home 名定位」都用不了`
      : record.cdp === undefined
        ? `,${RECORD_FILE} 里没有 cdp 那格(起的时候没带 --remote-debugging-port?)`
        : `,${RECORD_FILE} 记下了 CDP ${String(record.cdp)}`
  return {
    ok: true,
    name: input.name,
    home,
    pid,
    ...(record === undefined ? {} : { record }),
    note: `起来了(pid ${pid}${input.cdp === undefined ? '' : `,CDP ${input.cdp}`})${seen}——日志在 ${path.join(home, 'gwb.log')}`,
  }
}

// ── 列 ────────────────────────────────────────────────────────────────────────

export interface HomeEntry {
  name: string
  home: string
  /** 记录里那个 pid,且此刻还活着认得出;否则 null */
  pid: number | null
  running: boolean
  /** 够得着它的口。没记录、或那一格没写,就是 null */
  cdp: number | null
  mcp: DoorEndpoint | null
  /** 前一门（已搁置）的口——老 home 的记录里有,照报当线索 */
  commandHttp: DoorEndpoint | null
}

/** home 根下全部 home。名字带着时间戳后缀,字典序就是时间序——排序不必另做 */
export async function listHomes(homesRoot: string, deps: HomeDeps): Promise<HomeEntry[]> {
  const out: HomeEntry[] = []
  for (const name of deps.fs.dirs(homesRoot)) {
    const home = path.join(homesRoot, name)
    const record = parseRecord(deps.fs.readText(recordFile(home)))
    let running = false
    if (record !== undefined) {
      running = ownedProbe(await deps.processName(record.pid), deps.execPath) === true
    }
    out.push({
      name,
      home,
      pid: running && record !== undefined ? record.pid : null,
      running,
      // 口按记录如实报,不因为「进程看着不在」就抹掉:陈旧的口正是人要看见的那条线索
      cdp: record?.cdp ?? null,
      mcp: record?.mcp ?? null,
      commandHttp: record?.commandHttp ?? null,
    })
  }
  return out
}

// ── 挑一个调试口 ──────────────────────────────────────────────────────────────

/**
 * **别的** home 记录里占着的调试口。**陈旧的也算占着**:那份记录还指着这个数,再分给第二个
 * home 的话,两份记录会同时声称自己是这个口,而「按名字定位」全靠这个数唯一。
 *
 * `except` 是正要起的那个 home 自己:它自己那份记录不算占着,否则重开一次就换一个口,
 * 而那个口每次都是被自己上一次的记录挤走的。
 */
export function portsInRecords(homesRoot: string, deps: HomeDeps, except?: string): Set<number> {
  const taken = new Set<number>()
  for (const name of deps.fs.dirs(homesRoot)) {
    if (name === except) continue
    const record = parseRecord(deps.fs.readText(recordFile(path.join(homesRoot, name))))
    if (record?.cdp !== undefined) taken.add(record.cdp)
  }
  return taken
}

/**
 * 给一个要起的 home 定调试口。**名字是唯一的地址之后,没有口的 home 等于够不着**,所以
 * 不给就自动定,而不是让它默默地开不了调试口。
 *
 * **先沿用它自己上次那个口**(记录里的 `cdp`),被别人占了才另挑。口稳定下来是有价值的:
 * 人记得住、日志里对得上、开着的检查器不用换地址;而漂来漂去除了「每次都得重新问一遍」之外
 * 什么都换不来。
 *
 * 另挑时两道筛:别的 home 记录里占着的跳过(见 `portsInRecords`),此刻真有人 listen 的跳过。
 * **挑完到 electron 真绑上之间有个缝**——那一瞬别人抢走了这个口,记录里会写着一个不属于它的
 * 数;那种情况由「端口持有者要等于 pid」那道守卫抓,不在这儿赌。
 */
export async function pickCdpPort(
  homesRoot: string,
  deps: HomeDeps,
  name?: string,
): Promise<{ port: number; reused: boolean } | undefined> {
  const mine = name === undefined ? undefined : parseRecord(deps.fs.readText(recordFile(path.join(homesRoot, name))))?.cdp
  if (mine !== undefined && (await deps.portOwner(mine)) === undefined) return { port: mine, reused: true }
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

/**
 * 「我要操作 <home 名>」→ 够得着它的那个调试口。
 *
 * **记录只回答「你要的是哪个」,不回答「它此刻还在不在」**,所以三道都要验:记录读得出、
 * pid 还活着且认得出是个 home 进程、那个 pid 真的持着记录里那个口。端口会被复用、pid 会被
 * 复用,少一道就可能把一趟改动推给另一个进程——而那正是这条路要消灭的那种错。
 *
 * 「查不出」与「确凿地不在」分开报:前者不导出任何动作(别的什么东西挡着看不见),后者是
 * 明确的「它没在跑」。这跟 stop 那半同一个道理。
 */
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
  const owned = ownedProbe(await deps.processName(record.pid), deps.execPath)
  if (owned === undefined) return { ok: false, error: `查不出记录里的 pid ${record.pid} 还在不在——没敢认` }
  if (!owned) return { ok: false, error: `${name} 没在跑(记录里的 pid ${record.pid} 已经不是它了)——先 devkit.home.open` }
  if (record.cdp === undefined) {
    return {
      ok: false,
      error: `${name} 在跑,但记录里没有 cdp 那格——起它的时候没带 --remote-debugging-port,够不着。停掉重开时给 cdp 参数`,
    }
  }
  const owner = await deps.portOwner(record.cdp)
  if (owner !== undefined && owner !== record.pid) {
    return {
      ok: false,
      error: `记录说 ${name} 的调试口是 ${record.cdp},可那个口上 listen 的是 pid ${owner},不是 ${record.pid}——记录陈旧了,没敢用`,
    }
  }
  return { ok: true, name, home, record, cdp: record.cdp }
}

// ── 停 ────────────────────────────────────────────────────────────────────────

export interface StopOutcome {
  ok: boolean
  killed: number | null
  note: string
}

/**
 * 按 home 里的启动记录停。**两道核对再杀**,与 registry 的 bringDown 同一个道理:
 * pid 会被复用,光「有这个进程」不作数;映像名认过之后,记录里带 CDP 口的再对一次
 端口持有者——对不上就不杀。
 *
 * **手工起的 home 现在也停得了**:记录归内核写(2026-09-11 起),所以「它是谁」的凭据不再
 只有 devkit 起的那几个有。没有记录仍然如实说没有可停的——不猜、不按名字扫进程。
 *
 * **kill 失败时记录留着**:进程还在跑,记录是唯一一份「它是谁」的线索。
 */
export async function bringDownHome(homeDir: string, deps: HomeDeps): Promise<StopOutcome> {
  const file = recordFile(homeDir)
  const record = parseRecord(deps.fs.readText(file))
  if (record === undefined) {
    return { ok: true, killed: null, note: `没有运行时记录(${RECORD_FILE} 不在或读不出)——它没起过,或者起它的内核版本还不写这份记录` }
  }
  const owned = ownedProbe(await deps.processName(record.pid), deps.execPath)
  if (owned === undefined) {
    return { ok: false, killed: null, note: `查不出 pid ${record.pid} 是什么——没敢杀` }
  }
  if (!owned) {
    // **记录不删**:它是「上一次它在哪个口上」的唯一线索,而下一次开机内核会整份重写。
    // 删了只换来一次「看着干净」,代价是 home 停掉之后连查都查不了
    return { ok: true, killed: null, note: `pid ${record.pid} 已陈旧(进程不在,或不是它)——没什么可停的` }
  }
  if (record.cdp !== undefined) {
    const owner = await deps.portOwner(record.cdp)
    if (owner !== undefined && owner !== record.pid) {
      return {
        ok: false,
        killed: null,
        note: `CDP ${record.cdp} 端口上 listen 的是 pid ${owner},记录里写的是 ${record.pid}——对不上,没敢杀(记录留着)`,
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
    return { ok: true, killed: null, note: `pid ${record.pid} 已陈旧(下手时进程已经不在了)` }
  }
  return { ok: true, killed: record.pid, note: `已停 pid ${record.pid}` }
}

// ── 删 ────────────────────────────────────────────────────────────────────────

export interface RemoveOutcome {
  ok: boolean
  note: string
}

/**
 * 删一个测试 home。**还在跑的先停再删**:单独停一个 home 唯一的用处就是接着删它。
 *
 * `force` 是同一个意思的两面:**越过守卫**。一面是「它还在跑,连停带删」,另一面是
 * 「`default` 是日常那份,真要删」。
 *
 * **但这两面不叠加**:`default` 正跑着的时候 `force` 也不停它。一条开发工具不该去关
 * 人正在用的那扇窗——那不是删一个测试现场,那是把人的桌子掀了。如实说,让人自己关。
 *
 * 记录「查不出还在不在」时不删:不知道占没占着目录,下手就是在赌。
 */
export async function removeHome(homeDir: string, name: string, force: boolean, deps: HomeDeps): Promise<RemoveOutcome> {
  const daily = name === DAILY_HOME
  /** 删之前真停过的话,那句话要跟着回执走:人得知道自己刚才顺手杀了一个进程 */
  let stoppedNote: string | undefined
  if (daily && !force) {
    return { ok: false, note: `${DAILY_HOME} 是日常那份 home,不删。真要删,带 force: true` }
  }
  if (!deps.fs.exists(homeDir)) {
    return { ok: false, note: `${homeDir} 不在——没有这个 home(看 devkit.home.list)` }
  }
  const record = parseRecord(deps.fs.readText(recordFile(homeDir)))
  if (record !== undefined) {
    const owned = ownedProbe(await deps.processName(record.pid), deps.execPath)
    if (owned === undefined) {
      return { ok: false, note: `查不出记录里的 pid ${record.pid} 还在不在——没敢删,先看一眼` }
    }
    if (owned && !force) {
      return { ok: false, note: `还在跑(pid ${record.pid})——带 force: true 连停带删` }
    }
    if (owned && daily) {
      return { ok: false, note: `${DAILY_HOME} 正跑着(pid ${record.pid})——这是日常那份,我不替你关它。自己关掉那扇窗再来删` }
    }
    if (owned) {
      const stopped = await bringDownHome(homeDir, deps)
      if (!stopped.ok) return { ok: false, note: `没删:停它没成——${stopped.note}` }
      stoppedNote = stopped.note
    }
  }
  const done = deps.fs.removeDir(homeDir)
  if (!done.ok) {
    return {
      ok: false,
      note: `删没成:${done.error}——多半还有进程占着目录(electron 的子进程偶尔晚退几秒),稍等再试`,
    }
  }
  return { ok: true, note: `已删 ${name}(${homeDir})${stoppedNote === undefined ? '' : `——删之前先停了它:${stoppedNote}`}` }
}
