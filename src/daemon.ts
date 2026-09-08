import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isRecord } from '@godcreator02/gwb-plugin-api'

/**
 * 维持一个 Verdaccio 目录的纯机：地址与存储位从它自己的 `config.yaml` 推、pid 判活、
 * 起停时序、日志尾巴。
 *
 * **一个 registry 目录就是全部真相**：地址、存储位、日志位都写在那份 `config.yaml`
 * 里，所以这一层认目录、不认配置项。据别处一份配置去 ping 另一个地址，会得出「你要
 * 维持的那个没起来，但状态显示在跑」——那是这台机器上另一个 registry 的回音。
 *
 * **碰盘与开进程的能力全走注入**（`RegistryDeps`），整条起停时序在测试里用假件跑得完
 * ——起停恰恰是最不该靠手工点几遍来确认的东西：轮询几秒、pid 文件写没写、陈旧 pid
 * 认不认，全是只在边角上才现形的判断。
 */

/** registry 目录里的几个固定名字（Verdaccio 自己的约定 + 起停落 pid 的位置） */
export const CONFIG_FILE = 'config.yaml'
export const PID_FILE = 'verdaccio.pid'
/** `config.yaml` 里没写 `storage` 时的默认值（Verdaccio 的默认相对位） */
export const DEFAULT_STORAGE = './storage'
/** `config.yaml` 里没写 `listen` 时的地址——跟 Verdaccio 自己的默认一致 */
export const DEFAULT_LISTEN = 'http://localhost:4873/'
/** `config.yaml` 里没写 `log.path` 时用的日志名 */
export const DEFAULT_LOG = './verdaccio.log'

/** 起来之后等 `/-/ping` 通的上限 */
export const UP_TIMEOUT_MS = 30_000
/** 轮询间隔 */
export const POLL_MS = 500
/** `registry.log` 默认回多少行 */
export const DEFAULT_LOG_LINES = 200

export function configFile(dir: string): string {
  return path.join(dir, CONFIG_FILE)
}

export function pidFile(dir: string): string {
  return path.join(dir, PID_FILE)
}

/**
 * Verdaccio 的入口文件。**只跑目录里现成的那一份**，不去装、也不去 PATH 上碰运气：
 * 装 verdaccio 本身要先有一个 registry——把它声明成依赖就成了鸡生蛋。不在就实话说
 * 「进这个目录跑 pnpm install」。
 */
export function verdaccioBin(dir: string): string {
  return path.join(dir, 'node_modules', 'verdaccio', 'bin', 'verdaccio')
}

// ── config.yaml ───────────────────────────────────────────────────────────────

/**
 * `config.yaml` 的文本 → 顶层映射。**读不出映射一律回 undefined**：写坏了、顶层是数组
 * 或标量，对这一层是同一件事——这份配置里没有可认的键。空白与只有注释的不算坏
 * （yaml 对它们回 null），当成一张空表：它跟「键一个没写」是同一个局面，不是等人来修的文件。
 */
function readConfig(text: string): Record<string, unknown> | undefined {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return undefined
  }
  if (doc === null || doc === undefined) return {}
  return isRecord(doc) ? doc : undefined
}

/**
 * 一个配置值 → 能用的串。`listen` 那几种写法里有两种不是串：光端口（`listen: 4873`
 * 解析出来是 number）与列表形态（第一项是主监听口）。别的形状一律当没写，由调用方回落。
 */
function asScalar(value: unknown): string | undefined {
  if (Array.isArray(value)) return asScalar(value[0])
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * `listen` 那一行 → 一个能打的基址。Verdaccio 收四种写法：光端口、`host:port`、
 * 带协议的完整地址、以及列表形态。
 *
 * **`0.0.0.0` 与 `[::]` 换成回环**：那两个是「听哪些网卡」的写法，不是可以连的地址。
 * 拿它去 ping，Windows 上得到的是一个看不懂的 ECONNREFUSED，而 registry 好好地跑着。
 */
export function listenToUrl(listen: string | undefined): string | undefined {
  const raw = listen?.trim() ?? ''
  if (raw === '') return undefined
  const withScheme = raw.includes('://') ? raw : /^\d+$/.test(raw) ? `http://127.0.0.1:${raw}` : `http://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1'
  return url.origin + '/'
}

/**
 * 这个目录自己的地址。**没写 `listen` 就回落默认**：不写这行的 `config.yaml` 是完全
 * 正常的配置，Verdaccio 那时听的就是 `localhost:4873`。写了但读不成地址是另一回事
 * ——那是一份有毛病的配置，猜一个默认只会把毛病藏起来，如实回没有；整份配置读不出
 * 映射时同理。
 */
export function urlOf(configText: string | undefined): string | undefined {
  if (configText === undefined) return undefined
  const doc = readConfig(configText)
  if (doc === undefined) return undefined
  const listen = asScalar(doc.listen)
  return listen === undefined ? DEFAULT_LISTEN : listenToUrl(listen)
}

/** 活口探针的地址 */
export function pingUrl(base: string): string {
  return new URL('/-/ping', base).toString()
}

/** 这个该听的那个端口（从地址上取，没写端口就按协议的默认口） */
export function portOf(url: string | null | undefined): number | undefined {
  if (url === null || url === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

/**
 * 日志文件位。`log` 是个块（`log:` 下面挂 `type` / `path`），Verdaccio 也收「几路日志」
 * 的列表，那时第一路是主日志。指不出来就用默认名——日志只是给人看的尾巴，指错了顶多
 * 是「读不到日志」，不值得为它多一道拒绝。
 */
export function logFileOf(dir: string, configText: string | undefined): string {
  const log = configText === undefined ? undefined : readConfig(configText)?.log
  const entry = Array.isArray(log) ? log[0] : log
  const raw = isRecord(entry) ? asScalar(entry.path) : undefined
  return path.resolve(dir, raw ?? DEFAULT_LOG)
}

// ── pid 判活 ──────────────────────────────────────────────────────────────────

/** pid 文件的内容 → 一个像样的 pid。空文件、半截数字、负数一律当没有 */
export function parsePid(text: string | undefined): number | undefined {
  const raw = text?.trim() ?? ''
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return value > 0 ? value : undefined
}

/**
 * 这个映像名算不算「我们起的那个 registry」。
 *
 * pid 会被系统复用，光「有这个进程」不作数，还得看它是什么。而**判据不能只写 `node`**：
 * 起子进程用的是本进程自己的可执行文件（靠 `ELECTRON_RUN_AS_NODE` 让它以纯 node 身份
 * 跑），开发态那是 `electron.exe`——只认 node 会把自己刚起的进程判成「不是它」。所以
 * 两头都认：node 与当前可执行文件。
 */
export function isOwnedProcess(name: string | undefined, execPath: string): boolean {
  const shed = (value: string): string => path.basename(value).toLowerCase().replace(/\.exe$/, '')
  if (name === undefined || name.trim() === '') return false
  const image = shed(name.trim())
  return image === 'node' || image === shed(execPath)
}

/**
 * 查一个 pid 的三种答案。**「查不出」不能跟「不在」混成一个**：查映像名那条命令会
 * 超时、会不在、会自己出错，把这些当成「进程不在」的话，停就退化成「只清一份 pid
 * 文件」——那个 registry 还在跑，线索却被删了，此后再也停不了它。
 */
export type ProcessProbe = { state: 'running'; name: string } | { state: 'gone' } | { state: 'unknown' }

/**
 * 探测结果 → 「这个 pid 是不是我们那个 registry」。查不出时回 `undefined`：「不知道」
 * 跟「不是」得分开，前者不该导出任何一个动作。
 */
export function ownsProcess(probe: ProcessProbe, execPath: string): boolean | undefined {
  if (probe.state === 'unknown') return undefined
  if (probe.state === 'gone') return false
  return isOwnedProcess(probe.name, execPath)
}

/**
 * `tasklist /NH /FO CSV` 的一行 → 映像名。进程不在时它打的是一句
 * `INFO: No tasks are running...`，那一行没有引号，正好被下面这条判掉。
 */
export function parseTasklist(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = /^"([^"]+)"/.exec(line.trim())
    if (m?.[1] !== undefined) return m[1]
  }
  return undefined
}

/** 一行里的那个地址是不是听在这个端口上（`127.0.0.1:4873`、`[::]:4873` 都算） */
function endsWithPort(address: string | undefined, port: number): boolean {
  if (address === undefined) return false
  const at = address.lastIndexOf(':')
  return at >= 0 && address.slice(at + 1) === String(port)
}

/**
 * `netstat -ano -p tcp` 的输出 → 这个端口上 LISTENING 的那个 pid。列是
 * `协议 本地地址 外部地址 状态 pid`，状态那一栏在中文 Windows 上也是英文。
 */
export function parseNetstat(text: string, port: number): number | undefined {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    if (!/^tcp/i.test(parts[0] ?? '') || parts[3] !== 'LISTENING') continue
    if (!endsWithPort(parts[1], port)) continue
    const owner = Number(parts[4])
    if (Number.isInteger(owner) && owner > 0) return owner
  }
  return undefined
}

/**
 * `ss -ltnp` 的输出 → 这个端口上 listen 的那个 pid。pid 在最后那栏的 `pid=<号>` 里。
 */
export function parseSs(text: string, port: number): number | undefined {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] !== 'LISTEN' || !endsWithPort(parts[3], port)) continue
    const m = /pid=(\d+)/.exec(line)
    const owner = m?.[1] === undefined ? Number.NaN : Number(m[1])
    if (Number.isInteger(owner) && owner > 0) return owner
  }
  return undefined
}

// ── 子进程 ────────────────────────────────────────────────────────────────────

/**
 * 起 Verdaccio 的那条命令行。**`--config` 给相对名、cwd 给目录**：`config.yaml` 里
 * `storage` 与 `log.path` 都是相对路径，Verdaccio 按 cwd 解析它们——换成绝对路径起，
 * 存储会落到别处去。
 */
export function spawnPlan(dir: string, execPath: string): { command: string; args: string[]; cwd: string } {
  return { command: execPath, args: [verdaccioBin(dir), '--config', CONFIG_FILE], cwd: dir }
}

/**
 * 给子进程的环境：摘 `npm_config_*`（这个长命进程不该被「它是从哪个仓里点起来的」
 * 影响），补 `ELECTRON_RUN_AS_NODE=1`（宿主是 electron，这样它才以纯 node 身份跑）。
 */
export function nodeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) continue
    out[key] = env[key]
  }
  out.ELECTRON_RUN_AS_NODE = '1'
  return out
}

// ── 注入面 ────────────────────────────────────────────────────────────────────

/** 碰盘那一半。读不动一律回「没有」——这一层要的是「盘上现在是什么样」，不是异常 */
export interface RegistryFs {
  exists(target: string): boolean
  readText(file: string): string | undefined
  writeText(file: string, text: string): void
  remove(file: string): void
  /** 目录下的子目录名（不含文件）；读不动回空表 */
  dirs(target: string): string[]
}

export interface RegistryDeps {
  fs: RegistryFs
  /** 起一个 detached 子进程，回它的 pid；起不来回 undefined */
  spawn(plan: { command: string; args: string[]; cwd: string }, env: NodeJS.ProcessEnv): number | undefined
  /** 打一次 `/-/ping`，通了回 true（超时、连不上都回 false） */
  ping(url: string): Promise<boolean>
  /** 查 pid 对应的进程：查到了带映像名，进程不在，或者压根查不出（见 ProcessProbe） */
  processName(pid: number): Promise<ProcessProbe>
  /**
   * 某个 tcp 端口上 listen 的那个 pid。**取不出来一律回 undefined**——没人听、命令
   * 不在、这个平台上查不了都算，那时按映像名那道判据走：查不出不该变成「拒绝停」，
   * 否则一个卡住的 registry（进程在、端口还没听上）就永远收不掉了。
   */
  portOwner(port: number): Promise<number | undefined>
  /**
   * 停一个进程。停成了回 `'killed'`，进程本来就不在回 `'gone'`，**别的失败一律抛**。
   * 提权 shell 起的 registry 上这一下会被拒（EPERM）——吞掉它界面就会说「已停」，
   * 而那个 registry 还在服务，pid 文件却被清了，人再也找不到它是谁。
   */
  kill(pid: number): 'killed' | 'gone'
  sleep(ms: number): Promise<void>
  now(): number
  /** 起子进程用的可执行文件（宿主进程自己那个） */
  execPath: string
  /** 起子进程的环境底稿，进 nodeChildEnv 过一遍 */
  env: NodeJS.ProcessEnv
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

export interface RegistryStatus {
  dir: string
  /** 这个目录自己的地址（`config.yaml` 的 `listen` 推出来）；推不出为 null */
  url: string | null
  /** `/-/ping` 通不通——**这是「在不在跑」的唯一判据**，pid 只是用来停它 */
  running: boolean
  /** pid 文件里那个活着且认得出的 pid；陈旧或对不上回 null */
  pid: number | null
  /** 在跑，但不是本次会话起的（脚本起的、上一次起的、活过了宿主重启） */
  adopted: boolean
  /** 目录里有没有 config.yaml——没有就不是一个 registry 目录 */
  hasConfig: boolean
  /** 目录里有没有 verdaccio 本体 */
  hasBin: boolean
}

/**
 * 现查一次状态。`ownPid` 是**本次会话起的那个 pid**（没起过就不给）；`adopted` 据它算。
 * 这个判据故意是会话级的——宿主重启之后同一个 registry 还在跑（它就该活过宿主），那时
 * 它对新会话确实是「接管来的」，照实说比假装是自己起的更有用。
 */
export async function readStatus(dir: string, deps: RegistryDeps, ownPid?: number): Promise<RegistryStatus> {
  const configText = deps.fs.readText(configFile(dir))
  const url = urlOf(configText) ?? null
  const filePid = parsePid(deps.fs.readText(pidFile(dir)))
  // 查不出的时候跟「不是它」一样报 null——状态上少一个 pid 是可以忍的。**但一个字都
  // 不动盘**：清 pid 文件是停那条路上的事，现查一次状态不该有副作用
  const live =
    filePid !== undefined && ownsProcess(await deps.processName(filePid), deps.execPath) === true
      ? filePid
      : null
  const running = url === null ? false : await deps.ping(pingUrl(url))
  return {
    dir,
    url,
    running,
    pid: live,
    adopted: running && !(ownPid !== undefined && ownPid === live),
    hasConfig: configText !== undefined,
    hasBin: deps.fs.exists(verdaccioBin(dir)),
  }
}

// ── 起 ────────────────────────────────────────────────────────────────────────

export type UpOutcome =
  | { ok: true; status: RegistryStatus; started: boolean; note: string }
  | { ok: false; error: string }

/**
 * 把这个目录的 registry 拉起来。
 *
 * **ping 通就直接认**，不去比对 pid：这个地址上已经有一个 registry 在服务了，再起
 * 一个只会得到一个抢不到端口、几秒后死掉的进程，还顺手把 pid 文件写成那个死掉的号。
 *
 * 子进程是 **detached** 的：registry 得活过宿主重启与工作台退出——这台机器上别的仓
 * 也从它装包，工作台一关就断源是不能接受的。**边界要认**：detached 挡得住父进程自己
 * 退出，挡不住整个应用被连树杀（Windows 的 Job/树杀连 detached 后代一起收）——那种
 * 局面源会跟着没了，`registry.up` 再起就是。
 */
export async function bringUp(dir: string, deps: RegistryDeps, ownPid?: number): Promise<UpOutcome> {
  const before = await readStatus(dir, deps, ownPid)
  if (!before.hasConfig) {
    return { ok: false, error: `${dir} 里没有 ${CONFIG_FILE}——这不是一个 registry 目录` }
  }
  if (before.url === null) {
    return { ok: false, error: `${configFile(dir)} 里的 listen 读不成一个地址，不知道该往哪儿打 /-/ping` }
  }
  if (before.running) {
    return { ok: true, status: before, started: false, note: '已经在跑（接管，不重起）' }
  }
  // pid 文件里那个进程活着、地址却不应答：多半是它正在起（Verdaccio 头几秒不听端口）
  // 或者卡住了。这时再起一个只会得到一个抢不到端口的死进程，还把 pid 文件覆盖成死号
  if (before.pid !== null) {
    return {
      ok: false,
      error: `pid ${before.pid} 活着但 ${pingUrl(before.url)} 不通——等它、看日志，或先停它`,
    }
  }
  if (!before.hasBin) {
    return {
      ok: false,
      error: `目录里没有 verdaccio（${verdaccioBin(dir)} 不在）——进 ${dir} 跑 pnpm install。这个件不替你装它：装它本身就得先有一个 registry`,
    }
  }

  const pid = deps.spawn(spawnPlan(dir, deps.execPath), nodeChildEnv(deps.env))
  if (pid === undefined) return { ok: false, error: '起不来：子进程没拿到 pid，看宿主日志' }
  deps.fs.writeText(pidFile(dir), `${pid}\n`)

  const deadline = deps.now() + UP_TIMEOUT_MS
  const ping = pingUrl(before.url)
  while (deps.now() < deadline) {
    if (await deps.ping(ping)) {
      return {
        ok: true,
        status: await readStatus(dir, deps, pid),
        started: true,
        note: `起来了（pid ${pid}，${before.url}）`,
      }
    }
    // 进程当场死掉是这条路上最常见的失败（端口被占、配置写错），光 ping 的话得空等满
    // 三十秒才报出来——每轮顺手查一眼它还在不在。查不出时接着等：只有确凿的「它不在了」
    // 才值得中断
    if (ownsProcess(await deps.processName(pid), deps.execPath) === false) {
      return {
        ok: false,
        error: `起的进程 pid ${pid} 已退出，多半是端口被占或配置有错——看 ${logFileOf(dir, deps.fs.readText(configFile(dir)))}`,
      }
    }
    await deps.sleep(POLL_MS)
  }
  return {
    ok: false,
    error: `起了进程 pid ${pid}，${UP_TIMEOUT_MS / 1000} 秒内 ${ping} 没通——看 ${logFileOf(dir, deps.fs.readText(configFile(dir)))}`,
  }
}

// ── 停 ────────────────────────────────────────────────────────────────────────

export interface DownOutcome {
  ok: boolean
  /** 真杀掉的那个 pid；没有可杀的为 null */
  killed: number | null
  note: string
}

/**
 * 按 pid 文件停。**两道核对再杀**：
 *
 * 一是映像名——pid 会被系统复用，一份陈旧的 pid 文件加上一次不核对的 kill，杀的就是
 * 这台机器上碰巧拿到这个号的另一个进程。二是端口的持有者：映像名那道只能证明「这是个
 * node 或者跟宿主同一个 exe」，撞上别人的 node 照样杀错。听着这个 registry 端口的才是
 * 它本人，两道都过了才下手。
 *
 * 停不了「不是经 pid 文件管起来的那个」——那种局面如实说没有可停的，别去按地址猜一个
 * 进程杀。
 *
 * **kill 失败时 pid 文件留着**：那个进程还在跑，而 pid 文件是唯一一份「它是谁」的记录。
 * 删文件只发生在两种局面——真杀掉了，或者那个号确实已经陈旧。
 */
export async function bringDown(dir: string, deps: RegistryDeps): Promise<DownOutcome> {
  const file = pidFile(dir)
  const filePid = parsePid(deps.fs.readText(file))
  if (filePid === undefined) {
    deps.fs.remove(file)
    return { ok: true, killed: null, note: '没在跑（pid 文件不在或读不出 pid）' }
  }
  const owned = ownsProcess(await deps.processName(filePid), deps.execPath)
  if (owned === undefined) {
    return {
      ok: false,
      killed: null,
      note: `查不出 pid ${filePid} 是什么（查映像名那条命令超时或出错）——没敢杀，pid 文件留着`,
    }
  }
  if (!owned) {
    deps.fs.remove(file)
    return { ok: true, killed: null, note: `pid ${filePid} 已陈旧（进程不在，或不是它）——只清了 pid 文件` }
  }
  const port = portOf(urlOf(deps.fs.readText(configFile(dir))))
  const owner = port === undefined ? undefined : await deps.portOwner(port)
  if (owner !== undefined && owner !== filePid) {
    return {
      ok: false,
      killed: null,
      note: `${port} 端口上 listen 的是 pid ${owner}，pid 文件里写的是 ${filePid}——两个对不上，没敢杀（pid 文件留着）`,
    }
  }
  let killed: 'killed' | 'gone'
  try {
    killed = deps.kill(filePid)
  } catch (err) {
    return { ok: false, killed: null, note: `停 pid ${filePid} 没成：${String(err)}——进程还在，pid 文件留着` }
  }
  deps.fs.remove(file)
  if (killed === 'gone') {
    return { ok: true, killed: null, note: `pid ${filePid} 已陈旧（下手时进程已经不在了）——只清了 pid 文件` }
  }
  return { ok: true, killed: filePid, note: `已停 pid ${filePid}` }
}

// ── 日志 ──────────────────────────────────────────────────────────────────────

/** 最后 n 行。空行也算行——日志里那些空行是分隔，抹掉反而看不出段落 */
export function tailLines(text: string, max: number): string {
  const lines = text.replace(/\n$/, '').split('\n')
  return lines.slice(Math.max(0, lines.length - max)).join('\n')
}

export interface LogRead {
  file: string
  /** 读不到文件时为 null（registry 从没起过就是这样，不是错） */
  text: string | null
  lines: number
}

export function readLog(dir: string, deps: RegistryDeps, max = DEFAULT_LOG_LINES): LogRead {
  const file = logFileOf(dir, deps.fs.readText(configFile(dir)))
  const raw = deps.fs.readText(file)
  if (raw === undefined) return { file, text: null, lines: 0 }
  const text = tailLines(raw, max)
  return { file, text, lines: text === '' ? 0 : text.split('\n').length }
}
