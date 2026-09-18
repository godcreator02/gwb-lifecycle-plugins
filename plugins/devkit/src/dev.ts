import path from 'node:path'
import { isRecord } from '@godcreator/gwb-plugin-api'

/**
 * 「改一版看一版」那条链的纯机:守卫、版本号、发什么装什么、重挂哪几条、拿什么当证据。
 *
 * **这条链只能站在被换的那个进程外面。** 换件那一步是重挂条目(停用再启用),工具自己要是跑在
 * 目标那个 home 里,换到总线、外壳、mcp、devkit 自己头上时,调用方跟着下线(升到 gwb-mcp
 * 时回执会丢,是同一件事的一个实例)。所以这条命令住**控制台那个 home**,操作**另一个
 * home**:盘那半(构建、发版、pnpm add)在本进程里做,页那半(重挂、刷新、取证)经 CDP 送到
 * 目标页去。CDP 口是内核命令行上的开关,跟目标 home 装了哪些件无关——那正是它比 MCP 可靠
 * 的地方:被换的件正好是 mcp 时,这条路照样通。
 *
 * **为什么不覆盖 dist**(那条快 4 倍的近路,实跑撞出来的两条):
 *
 * - home 里 `node_modules` 下的文件是**硬链接到 pnpm 全局 store** 的,而覆盖写是就地截断
 *   重写,写的是共享那个 inode。于是 store 里按原始内容哈希命名的那份,内容变成了开发构建,
 *   此后这台机器上任何人装那个版本拿到的都是它,**而且不报错**
 * - **node 那半换不动**。Node 的 ESM 模块图按 URL 缓存,原地覆盖不改路径,cordis 把件停用
 *   再启用,`import()` 回来的还是缓存里那份旧的。发开发版把号打成 `<patch+1>-dev.<戳>`,
 *   **装上的版本变了就是路径变了**(pnpm 虚拟仓的目录名超长时截成前段加全名哈希,预发布段与
 *   peer 后缀都在哈希里,同 patch 的两个 dev 号目录也不同),重挂那一下才真的重新求值。前提是
 *   这一趟的号**真装上了**——所以装完读回 home 里那份 package.json 核对,见 `checkInstalled`
 *
 * 加戳 import 是第三条路,内核仓量过账(`probes/2609101436_esm-cachebust-reload-cost`):
 * 不可逆泄漏,量级约等于件 dist 体积的两倍,Node 24 上没有清模块图的口子。别走。
 *
 * **收尾是取证,不是 reload。** 少了取证这一步,人看到「重挂了、刷新了」就会说验过了——
 * 而件的 `apply` 里一条 async 静默 reject,现象正好是「挂上了但什么都没发生」。所以这条
 * 命令的最后一步是回头看 `plugin-manager.list` 的 `active` 与日志里的新错,取不到就退非零。
 *
 * 碰盘、开进程、连 CDP 全走注入(`DevDeps`),于是整条时序在测试里用假件跑得完。
 */

/** 团队源（gitea 的 team 组织 npm registry，经 Lucky 反代出域名——与 git remote 同判例）。跟用户级 `~/.npmrc` 里 `@godcreator` scope 那行同一个地址 */
export const DEFAULT_REGISTRY = 'https://git.tianshen02.online:28377/api/packages/godcreator/npm/'

/** 日常那份 home 的名字。开发版进它就是「悄悄换了日常代码」,所以当场拒 */
export const DAILY_HOME = 'default'

/** 目标 home 的日志。跟着 home 走,所以每个现场的日志天然是分开的 */
export const LOG_FILE = 'gwb.log'

export const BUILD_TIMEOUT_MS = 300_000
export const PUBLISH_TIMEOUT_MS = 180_000
export const ADD_TIMEOUT_MS = 300_000
/** 一次 CDP 动作的上限。`reload` 那条自己还要等页面回来,所以给得比别的宽 */
export const CDP_TIMEOUT_MS = 120_000

/** 取证时日志增量里最多回几行。全量没人读,要的是新冒出来的那几条 */
export const LOG_TAIL_LINES = 40

// ── 版本号 ────────────────────────────────────────────────────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * `<patch+1>-dev.<yyyyMMddHHmm>`。
 *
 * **patch 要加一**:开发版的号必须落在正式版**之后**,不然装的时候 `>=` 那类范围会把它
 * 当成旧版跳过。戳到分钟:同一分钟里发两趟会撞号,那时改一行再来(撞了会当场拒,见
 * `publishedAlready`),比静默覆盖一个已经装出去的号强。
 *
 * **标 dev 不动 latest**:团队源上这些包同时被别的仓消费,开发版顶掉 latest 会让它们
 * 莫名其妙换了代码。
 */
export function devVersion(version: string, now: number): string {
  const [major = '0', minor = '0', rest = '0'] = version.split('.')
  // `parseInt` 而不是 `Number`:底版本本身可能已经是个预发布号(`0.3.1-dev.x`),
  // 那时该发的是 0.3.2-dev.y,不是在它后面再接一段
  const patch = Number.parseInt(rest, 10)
  const at = new Date(now)
  const stamp = `${String(at.getFullYear())}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`
  return `${major}.${minor}.${String((Number.isNaN(patch) ? 0 : patch) + 1)}-dev.${stamp}`
}

// ── 守卫 ──────────────────────────────────────────────────────────────────────

/** `devkit.cdp <口> home` 打出来的那张表。页面上的 `file://` 地址里带着 home 的绝对路径 */
export interface HomeProbe {
  home: string | null
  why?: string
}

export type HomeGuard = { ok: true; home: string; name: string } | { ok: false; error: string }

/**
 * 路径比对。Windows 上路径不分大小写,别的平台分——**平台当参数传**,不在这儿现读
 * `process.platform`:这条判断决定「拒不拒」,它该在测试里两种平台都跑得到。
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, '')
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return norm(a) === norm(b)
}

/**
 * 这一趟推不推得动这个现场。三道:
 *
 * 1. **页面自报不出 home 就停**。问的是正在跑的那张页(它注的样式表与 importmap 都是带着
 *    home 路径的 `file://`),问不出来说明它根本不是工作台的外壳页,继续推就是推给别人
 * 2. **`default` 当场拒**。开发版进日常那份 home,号看着跟正式版没两样,而 `plugin-manager.list`
 *    上一点异常都看不出来
 * 3. **目标是自己所在那个 home 就拒**。停用条目那一下会把正在跑的这个 handler 自己停掉。
 *    换 devkit 自己走另一条路:发正式版 + `plugin-manager.update-all`(那是 plugins 件在调,不是
 *    devkit 自己,所以它活得过重挂)
 */
export function guardHome(probe: HomeProbe, ownHome: string, platform: NodeJS.Platform, expect?: string): HomeGuard {
  if (probe.home === null || probe.home === '') {
    return { ok: false, error: `问不出这张页是哪个 home:${probe.why ?? '没说原因'}——它可能不是工作台的外壳页,或者这个调试口连到了别的应用` }
  }
  const name = path.basename(probe.home.replace(/[\\/]+$/, ''))
  // 点了名就得对得上。**记录回答「你要的是哪个」,页面回答「你连上的实际是哪个」**——
  // 记录会陈旧、口会被复用,只信记录就会静默推给另一个进程
  if (expect !== undefined && expect !== name) {
    return { ok: false, error: `你点名要 ${expect},可这个调试口上的页面自报是 ${name}——记录陈旧了,或者口给错了。没动它` }
  }
  if (name === DAILY_HOME) {
    return { ok: false, error: `目标是 ${DAILY_HOME},这是日常那份 home,开发版不进它——换个隔离 home(devkit.home.new)再来` }
  }
  if (samePath(probe.home, ownHome, platform)) {
    return {
      ok: false,
      error: `目标就是本件自己住的这个 home(${probe.home})——停用条目那一下会把正在跑的这条命令自己停掉。换 devkit 自己走另一条:发正式版,再 plugin-manager.update-all`,
    }
  }
  return { ok: true, home: probe.home, name }
}

// ── 包清单 ────────────────────────────────────────────────────────────────────

export interface Manifest {
  name: string
  version: string
  files?: string[]
}

/**
 * `files` 里哪几条是「必须真在盘上的产物」。
 *
 * **否定式(`!py/**\/__pycache__`)与通配都不算**:前者说的是「别带这个」,后者可能一个都
 * 匹配不上也完全正常。拿它们去 `existsSync` 必然回「不在」,于是一个本来好好的包被判成
 * 产物不全——实跑第一趟就撞在 hello 那条否定式上。
 */
export function literalArtifacts(files: readonly string[]): string[] {
  return files.filter((one) => !one.startsWith('!') && !/[*?]/.test(one))
}

/** `package.json` 的文本 → 一份够用的清单。缺 name/version 就不是个能发的包 */
export function parseManifest(text: string | undefined): Manifest | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(doc)) return undefined
  const { name, version, files } = doc
  if (typeof name !== 'string' || name === '') return undefined
  if (typeof version !== 'string' || version === '') return undefined
  return {
    name,
    version,
    ...(Array.isArray(files) ? { files: files.filter((one): one is string => typeof one === 'string') } : {}),
  }
}

// ── 条目 ──────────────────────────────────────────────────────────────────────

export interface EntryView {
  entryId: string
  active: boolean
}

/**
 * `plugin-manager.list` 的回执里,挂着这个包的**全部**条目。
 *
 * **全部,不是第一条**:`plugin-manager.install` 对已经装过的包也照样新建一条条目,于是一个包挂
 * 两遍是真会发生的事(实跑撞过 `home:bn-comment` 与 `home:bn-comment-2`)。只重挂其中一条,
 * 另一条还攥着旧模块,表现是「改了一半」——比没换更难查。
 *
 * 回执形状两种都认(`{ packages: [...] }` 与裸数组):这条命令的回执壳子历史上变过,而这儿
 * 认错一种的代价是「装上了却说没有条目」,人会掉头去查 cordis.yml。
 */
export function entriesOf(data: unknown, pkg: string): EntryView[] {
  const packages = isRecord(data) && Array.isArray(data.packages) ? data.packages : Array.isArray(data) ? data : []
  for (const each of packages) {
    if (!isRecord(each) || each.pkg !== pkg) continue
    const entries = Array.isArray(each.entries) ? each.entries : []
    return entries
      .filter(isRecord)
      .filter((one): one is Record<string, unknown> & { entryId: string } => typeof one.entryId === 'string' && one.entryId !== '')
      .map((one) => ({ entryId: one.entryId, active: one.active === true }))
  }
  return []
}

// ── 装进目标 home ─────────────────────────────────────────────────────────────

/** 目标 home 自己的依赖清单(pnpm 的项目清单,home 根下) */
export const HOME_MANIFEST = 'package.json'

/** 清单里依赖可能住的几格。home 里的件都在 dependencies,别的格有这个包就改那一格 */
const DEP_GROUPS = ['dependencies', 'optionalDependencies', 'devDependencies'] as const

export type PinOutcome = { ok: true; text: string } | { ok: false; error: string }

/**
 * 把目标 home 清单里这个包的声明**写成准确号**(没有就加进 `dependencies`)。
 *
 * **不走 `pnpm add <包>@<号>`**:清单里已有 `^x` 声明时,pnpm 沿用那个前缀写成 `^<号>`
 * (`--save-exact` 也改不掉),而锁里已解析的同 patch 预发布号会被当成满足新范围、不重解析;
 * 源上有更新的同 patch 号(别的 dev 号、同号正式版)时,范围又会解析到它。三种情况装上的都
 * 不是这一趟发的号,退出码照样是 0。清单里写死准确号再 `pnpm install`,没有范围可解析。
 *
 * 缩进沿用原文件,末尾换行照原样;新加的包按名字排进那一格(pnpm 自己写清单也是排好序的)。
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
  const group = DEP_GROUPS.find((key) => tableOf(key)?.[pkg] !== undefined) ?? 'dependencies'
  const current = tableOf(group) ?? {}
  const next: Record<string, unknown> =
    current[pkg] !== undefined
      ? { ...current, [pkg]: version }
      : Object.fromEntries(Object.entries({ ...current, [pkg]: version }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  '
  const eol = text.endsWith('\n') ? '\n' : ''
  return { ok: true, text: JSON.stringify({ ...manifest, [group]: next }, null, indent) + eol }
}

/** home 里装上的那份包清单在哪。scope 包是两层目录 */
export function installedManifest(homeDir: string, pkg: string): string {
  return path.join(homeDir, 'node_modules', ...pkg.split('/'), 'package.json')
}

export interface InstalledRow {
  pkg: string
  /** 这一趟发的号 */
  expected: string
  /** home 里实际装上的号。读不到是 null */
  actual: string | null
}

/**
 * 目标 home 里实际装上的版本,逐包对这一趟发出的准确号。
 *
 * **读装好的那份 package.json**,不读 home 的清单也不读锁:清单写的是「要什么」、锁写的是
 * 「解析成什么」,只有 `node_modules` 下那份说的是「重挂时 import 的到底是谁」。
 */
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

/** 装上的号对不上时那句话 */
export function installedNote(homeName: string, wrong: readonly InstalledRow[]): string {
  const lines = wrong.map((row) =>
    row.actual === null
      ? `${row.pkg}:这一趟发的是 ${row.expected},${homeName} 的 node_modules 里读不到它的 package.json`
      : `${row.pkg}:这一趟发的是 ${row.expected},${homeName} 里实际装上的是 ${row.actual}`,
  )
  return `新代码没进 ${homeName}——${lines.join(';')}。重挂拿到的会是装上的那一版,别当它验过了`
}

// ── 日志 ──────────────────────────────────────────────────────────────────────

/**
 * 日志增量里的错。一行长成 `<ISO 时间> <级别> <件名> <正文>`,所以级别是第二段。
 *
 * **只认 error 当失败**,warn 另报不判死:件在启动时 warn 一句「某个可选服务不在」是常态,
 * 把它算成失败,这条命令就会天天红,人很快学会无视它,那时取证这一步就白做了。
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

// ── 注入面 ────────────────────────────────────────────────────────────────────

export interface RunPlan {
  command: string
  args: string[]
  cwd: string
}

/** pnpm 在 Windows 上是 `.cmd`,不借 `cmd /c` 一层就 ENOENT。跟 home.ts 的 buildPlan 同一个绕法 */
export function pnpmPlan(args: string[], cwd: string, platform: NodeJS.Platform): RunPlan {
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'pnpm', ...args], cwd }
    : { command: 'pnpm', args, cwd }
}

export interface DevDeps {
  /** 前台跑一条命令到结束:成没成加输出尾巴 */
  run(plan: RunPlan, timeoutMs: number): Promise<{ ok: boolean; tail: string }>
  /**
   * 对目标 home 那张页跑一个 `devkit.cdp` 动作,回它打出来的那张 JSON。
   *
   * **按 home 名调,不按端口**:那支驱动自己查记录、自己核对页面自报的名字,于是这条链里
   * 每一步都白得一次「我连的还是那个 home 吗」。传端口的话,这七步就成了七次没人看着的
   * 重新定位。
   *
   * **起子进程,不在本进程里连**:那支驱动必须能在工作台没起的时候独立跑(那是它的兜底
   * 身份),所以它是一个零依赖单文件,不是一个可 import 的模块。一趟循环多五六次进程启动,
   * 几百毫秒,对一趟一分钟的链可以忽略。
   */
  cdp(home: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; data: unknown; tail: string }>
  /**
   * 发一个开发版:在临时目录摆一份分发形态再 publish(**不改仓里的 package.json**——中途
   * 摔了会留下一个号被改过的仓,而那正是最难认出来的现场)。
   *
   * `siblings` 是**这一趟同时发的那几个包**的准确号:包里对它们的依赖要换成这几个号,
   * 否则装出来的是「新件配旧库」。`>=` 那类范围认不到 dev 号(semver 不拿预发布版去满足
   * 不带预发布的范围),所以非换不可。
   */
  publish(input: { pkgDir: string; version: string; registry: string; siblings: Record<string, string> }): Promise<{ ok: boolean; tail: string }>
  /** 这个号在源上有没有。问不出来当没有(发的时候源会再拒一次,那才是权威) */
  published(spec: string, registry: string): Promise<boolean>
  readText(file: string): string | undefined
  /** 整份写一个文本文件。只用来改目标 home 的清单 */
  writeText(file: string, text: string): { ok: true } | { ok: false; error: string }
  exists(target: string): boolean
  /** 文件现在多大。取日志基线用 */
  size(file: string): number
  /** 从某个字节读到末尾。取日志增量用 */
  slice(file: string, from: number): string
  now(): number
  /** 等一会儿。轮询回执之后才重挂的那一条时用 */
  sleep(ms: number): Promise<void>
  platform: NodeJS.Platform
}

// ── 一趟 ──────────────────────────────────────────────────────────────────────

export interface DevInput {
  /**
   * 目标 home 的名字。**这条链只认名字**:口是驱动那头按记录查的,而记录会陈旧,所以每一次
   * 连上都要拿页面自报的名字核对。端口是个没有语义的数,敲错一位就落在另一个现场。
   */
  home: string
  /** 仓根。构建在这儿跑 */
  repoDir: string
  /** 要发的包目录,相对仓根。空表＝仓根自己(一仓一包一插件的常态) */
  packages: string[]
  /** 刷新之后等页面上这个选择器出现才算刷回来了。不给就只等 readyState */
  waitFor?: string
  /** 本件自己住的那个 home 目录。目标是它就拒 */
  ownHome: string
}

export interface ShippedPackage {
  pkg: string
  version: string
  dir: string
  /** 重挂了哪几条条目。空表＝这个包在目标 home 里还没有条目 */
  remounted: string[]
  note?: string
}

export interface DevReport {
  home: string
  homeName: string
  shipped: ShippedPackage[]
  reload: unknown
  /** 取证:该活的条目活没活、日志增量里有没有新错 */
  evidence: Evidence
}

export interface Evidence {
  ok: boolean
  /** 逐包:这一趟发的号与 home 里实际装上的号 */
  installed: InstalledRow[]
  entries: { pkg: string; entryId: string; active: boolean }[]
  dead: string[]
  errors: string[]
  warns: string[]
  note: string
}

export type DevOutcome = { ok: true; data: DevReport } | { ok: false; error: string; data?: unknown }

/** 回执壳子:`devkit.cdp <口> cmd <名> <参数>` 把工作台那条命令的回执原样放在这一格里 */
const RECEIPT = '回执'

/** 从 cdp 那张 JSON 里取出工作台命令的回执 */
function receiptOf(data: unknown): { ok: boolean; data: unknown; error?: string } {
  const raw = isRecord(data) ? data[RECEIPT] : undefined
  if (!isRecord(raw)) return { ok: false, data: raw, error: '这张页没回一张认得出的回执——它可能不是工作台的外壳页' }
  return {
    ok: raw.ok === true,
    data: raw.data,
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  }
}

/**
 * 走完一趟:构建 → 发开发版 → 装进目标 home → 重挂 → 刷新 → 取证。
 *
 * **一条到底,不拆成三条**:少跑最后两步(重挂与取证)的人,会以为自己在看新代码。中途任何
 * 一步失败都当场停,回执里带着停在哪一步——装到一半停下,比装歪了强。
 */
export async function runDev(input: DevInput, deps: DevDeps): Promise<DevOutcome> {
  // ── 一、推去哪 ──────────────────────────────────────────────────────────────
  // 不配置、不猜:问一趟正在跑的那张页就知道了
  const probe = await deps.cdp(input.home, ['home'], CDP_TIMEOUT_MS)
  if (!probe.ok && !isRecord(probe.data)) {
    return { ok: false, error: `连不上 ${input.home}:${probe.tail}` }
  }
  const guard = guardHome(
    isRecord(probe.data) ? { home: typeof probe.data.home === 'string' ? probe.data.home : null, ...(typeof probe.data.why === 'string' ? { why: probe.data.why } : {}) } : { home: null },
    input.ownHome,
    deps.platform,
    input.home,
  )
  if (!guard.ok) return { ok: false, error: guard.error }

  // ── 二、构建 ────────────────────────────────────────────────────────────────
  // **仓根构建,不是包目录**:工作区里的件常常吃着同仓另一个包的产物,只构建被发的那一个,
  // 发出去的就是「新件配旧库」
  const built = await deps.run(pnpmPlan(['build'], input.repoDir, deps.platform), BUILD_TIMEOUT_MS)
  if (!built.ok) return { ok: false, error: `仓根 pnpm build 没成,一步都没往下走。输出尾巴:\n${built.tail}` }

  // ── 三、发开发版 ────────────────────────────────────────────────────────────
  // 两趟:**先把全部号算出来,再一个个发**。因为包之间会互相依赖,发第一个的时候就得知道
  // 第二个将来是什么号,不然它依赖的还是上一版(「新件配旧库」,而且不报错)
  const dirs = input.packages.length > 0 ? input.packages : ['.']
  const planned: { pkgDir: string; manifest: Manifest; version: string }[] = []
  const siblings: Record<string, string> = {}
  for (const rel of dirs) {
    const pkgDir = path.resolve(input.repoDir, rel)
    const manifest = parseManifest(deps.readText(path.join(pkgDir, 'package.json')))
    if (manifest === undefined) {
      return { ok: false, error: `${pkgDir} 下没有能读的 package.json(或缺 name/version)——包目录给的是相对仓根的路径` }
    }
    // 产物在不在照 `files` 白名单问。**不另列一份名单**:两份必然漂,而漂了的表现是
    // 「发出去了,装上了,新写的东西全没生效」
    const missing = literalArtifacts(manifest.files ?? []).filter((one) => !deps.exists(path.join(pkgDir, one)))
    if (missing.length > 0) {
      return { ok: false, error: `${manifest.name} 的产物不全,没发:${missing.join('、')} 不在。仓根 pnpm build 刚跑过还缺,多半是 files 白名单里那一项根本没人生成` }
    }
    const version = devVersion(manifest.version, deps.now())
    if (await deps.published(`${manifest.name}@${version}`, DEFAULT_REGISTRY)) {
      return { ok: false, error: `${manifest.name}@${version} 已经在源上了,同一个号永不重发——同一分钟里发了两趟的话,等一分钟再来` }
    }
    planned.push({ pkgDir, manifest, version })
    siblings[manifest.name] = version
  }
  const shipped: ShippedPackage[] = []
  // **按给的顺序发**:被依赖的先发,不然装的时候源上还没有它。顺序是调用方的事,这儿不猜
  for (const one of planned) {
    const sent = await deps.publish({ pkgDir: one.pkgDir, version: one.version, registry: DEFAULT_REGISTRY, siblings })
    if (!sent.ok) return { ok: false, error: `${one.manifest.name}@${one.version} 发版没成:\n${sent.tail}`, data: { shipped } }
    shipped.push({ pkg: one.manifest.name, version: one.version, dir: one.pkgDir, remounted: [] })
  }

  // ── 四、装进目标 home ───────────────────────────────────────────────────────
  // 日志基线取在装之前:从这一刻起冒出来的每一行,都是这一趟自己惹出来的
  const logFile = path.join(guard.home, LOG_FILE)
  const baseline = deps.size(logFile)
  // **清单写准确号再 pnpm install,不走 plugin-manager.install 也不走 pnpm add**:前者对已经装过的
  // 包还会再建一条条目(同一个件挂两遍);后者在已有 ^ 声明上写出来的是范围,见 `pinExact`。
  // 这一趟的包一次写齐、一次装,同趟兄弟之间的 peer 按新号一起解析
  const manifestFile = path.join(guard.home, HOME_MANIFEST)
  const original = deps.readText(manifestFile)
  if (original === undefined) return { ok: false, error: `读不到 ${guard.name} 的清单(${manifestFile})——这不像一个装过件的 home`, data: { shipped } }
  let pinnedText = original
  for (const one of shipped) {
    const pinned = pinExact(pinnedText, one.pkg, one.version)
    if (!pinned.ok) return { ok: false, error: `改不了 ${guard.name} 的清单(${manifestFile}):${pinned.error}`, data: { shipped } }
    pinnedText = pinned.text
  }
  if (pinnedText !== original) {
    const written = deps.writeText(manifestFile, pinnedText)
    if (!written.ok) return { ok: false, error: `写不进 ${manifestFile}:${written.error}`, data: { shipped } }
  }
  // 不带严格与否的参数,走目标 home 自己的配置:隔离 home 不放 pnpm-workspace.yaml,就是 pnpm 默认
  // 的不严格——开发版的号带预发布段,semver 不拿它满足别的件的 `^` peer,严格了这一趟必拒
  const installed = await deps.run(pnpmPlan(['install'], guard.home, deps.platform), ADD_TIMEOUT_MS)
  if (!installed.ok) {
    // 装没成就把清单放回原样:留着一份「声明了新号、盘上是旧号」的清单,下一个在这个 home 里跑
    // pnpm 的人会莫名其妙地装上它
    const restored = pinnedText === original ? { ok: true as const } : deps.writeText(manifestFile, original)
    const wanted = shipped.map((one) => `${one.pkg}@${one.version}`).join('、')
    return {
      ok: false,
      error: `在 ${guard.name} 里装 ${wanted} 没成${restored.ok ? '(清单已放回原样)' : `,清单也没放回去(${restored.error})——手工把 ${manifestFile} 改回来`}:\n${installed.tail}`,
      data: { shipped },
    }
  }
  // 退出码 0 不等于装上了这一趟的号。对不上就不往下走:重挂一个旧版本、再报「条目全活着」,
  // 正是这条链要防的那种「看着成了」
  const landed = checkInstalled(guard.home, shipped, deps.readText)
  if (landed.wrong.length > 0) {
    return { ok: false, error: installedNote(guard.name, landed.wrong), data: { shipped, installed: landed.rows } }
  }

  // ── 五、重挂 ────────────────────────────────────────────────────────────────
  // 盘上换了不等于跑着的换了。**装了不重挂比没装还糟**:盘上是新的,跑着的是旧的
  const listed = receiptOf((await deps.cdp(input.home, ['cmd', 'plugin-manager.list'], CDP_TIMEOUT_MS)).data)
  if (!listed.ok) return { ok: false, error: `问不出目标 home 的条目表(plugin-manager.list:${listed.error ?? '没说原因'})`, data: { shipped } }
  for (const one of shipped) {
    const entries = entriesOf(listed.data, one.pkg)
    if (entries.length === 0) {
      one.note = `装上了,但 ${guard.name} 里没有它的条目,没重挂——第一次建条目走 plugin-manager.install {"pkg":"${one.pkg}","spec":"${one.version}"}(钉这一趟的号,不给 spec 会装成 latest),之后每趟 devkit.dev`
      continue
    }
    for (const entry of entries) {
      const remounted = await remount(input.home, one.pkg, entry.entryId, deps)
      if (!remounted.ok) return { ok: false, error: remounted.error, data: { shipped } }
      one.remounted.push(entry.entryId)
    }
  }

  // ── 六、刷新 ────────────────────────────────────────────────────────────────
  // 浏览器那半要整页重载才会按 file:// 重新取 client 与样式表。给了选择器就等它出现:
  // 不等就接着量的话,量到的要么是刷新途中的异常,要么是上一版的画面
  const reloaded = await deps.cdp(input.home, ['reload', ...(input.waitFor === undefined ? [] : [input.waitFor])], CDP_TIMEOUT_MS)

  // ── 七、取证 ────────────────────────────────────────────────────────────────
  const evidence = await collect(input.home, guard.home, shipped, logFile, baseline, deps)
  const report: DevReport = { home: guard.home, homeName: guard.name, shipped, reload: reloaded.data, evidence }
  if (!evidence.ok) return { ok: false, error: evidence.note, data: report }
  return { ok: true, data: report }
}

/** 重挂一条条目的那条命令。停用、等拆完、启用、等挂上,在目标进程里一次做完 */
export const REMOUNT_COMMAND = 'plugin-manager.remount'

/** 重挂之后只有这个状态算挂上 */
const ACTIVE = 'ACTIVE'

/** 回执之后才重挂的那一条(plugin-manager 自己):轮询 `plugin-manager.list` 的间隔与总上限 */
export const DEFERRED_POLL_MS = 500
export const DEFERRED_TIMEOUT_MS = 60_000

/**
 * 重挂一条条目:**一条命令,不是停用加启用两条**。
 *
 * 拆成两条的话,被停用的正好是提供启用那条命令的件(plugin-manager 自己)或命令总线本身时,
 * 第二条已经没人接,条目留在停用。一条命令的处理器活得过它动的那条条目:普通条目与命令总线
 * 在回执之前就做完(`remounted`,带重挂后状态);plugin-manager 自己在回执发出之后才动手
 * (`deferred`),于是轮询 `plugin-manager.list`,等它重新答话、那条条目 active。
 */
export async function remount(home: string, pkg: string, entryId: string, deps: DevDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const reply = receiptOf((await deps.cdp(home, ['cmd', REMOUNT_COMMAND, JSON.stringify({ entryId })], CDP_TIMEOUT_MS)).data)
  if (!reply.ok) {
    return { ok: false, error: `重挂 ${entryId} 没成(${REMOUNT_COMMAND}):${reply.error ?? '没说原因'}——目标 home 的 plugin-manager 要 0.4.0 起才有这条命令` }
  }
  const action = isRecord(reply.data) ? reply.data.action : undefined
  const state = isRecord(reply.data) && typeof reply.data.state === 'string' ? reply.data.state : '没报状态'
  if (action === 'remounted') {
    return state === ACTIVE ? { ok: true } : { ok: false, error: `重挂了 ${entryId},但它停在 ${state},没到 ${ACTIVE}——日志里有原因` }
  }
  if (action !== 'deferred') {
    return { ok: false, error: `重挂 ${entryId} 的回执认不出(action=${String(action)}):${JSON.stringify(reply.data)}` }
  }
  const tries = Math.ceil(DEFERRED_TIMEOUT_MS / DEFERRED_POLL_MS)
  let last = '一次都没问到'
  for (let i = 0; i < tries; i += 1) {
    await deps.sleep(DEFERRED_POLL_MS)
    const listed = receiptOf((await deps.cdp(home, ['cmd', 'plugin-manager.list'], CDP_TIMEOUT_MS)).data)
    if (!listed.ok) {
      last = `plugin-manager.list 没答话(${listed.error ?? '没说原因'})`
      continue
    }
    const found = entriesOf(listed.data, pkg).find((one) => one.entryId === entryId)
    if (found?.active === true) return { ok: true }
    last = found === undefined ? `plugin-manager.list 答话了,表里没有 ${entryId}` : `plugin-manager.list 答话了,${entryId} 还没 active`
  }
  return {
    ok: false,
    error: `${entryId} 在回执之后才重挂,等了 ${String(DEFERRED_TIMEOUT_MS / 1000)} 秒没等到它回来。卡在:${last}`,
  }
}

/**
 * 取证。三样,合起来才盖得住「看着成了」的那几种:
 *
 * - **装上的就是这一趟发的号**。读 home 里 `node_modules` 下那份 package.json——pnpm 退出码 0、
 *   条目全活着、日志干净,跑着的也可能是上一趟的版本
 * - **条目真活着**。`plugin-manager.list` 的 `active` 判的是 fiber 真 ACTIVE,不是 fiber 建出来了
 *   ——inject 永远等不到的件也有 fiber,只是到不了 ACTIVE
 * - **日志增量里没有 error**。「挂上了」只说明模块 import 成功、`apply` 被调用了;`apply`
 *   里的 async 一旦静默 reject,现象就是「挂上了但什么都没发生」,那一条只在日志里
 */
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
  const note = landed.wrong.length > 0
    ? installedNote(path.basename(homeDir), landed.wrong)
    : !listed.ok
    ? `取不到证:plugin-manager.list 没回(${listed.error ?? '没说原因'})`
    : dead.length > 0
      ? `这几条没挂上(fiber 没到 ACTIVE):${dead.join('、')}——日志里有原因`
      : errors.length > 0
        ? `重挂之后日志里冒出 ${String(errors.length)} 条 error,别当它验过了:\n${errors.join('\n')}`
        : `装上的是这一趟的号(${landed.rows.map((row) => `${row.pkg}@${row.expected}`).join('、')}),${String(entries.length)} 条条目全活着,日志增量里没有 error${warns.length > 0 ? `(有 ${String(warns.length)} 条 warn,另看)` : ''}`
  return { ok, installed: landed.rows, entries, dead, errors, warns, note }
}

// 取证只有 `collect` 这一条路,而且只在 `runDev` 里头走——**判定要基线**:哪些 error 是
// 这一趟自己惹出来的,只有拿装包之前那个日志长度才分得出来。要现看一眼某个 home 的条目表,
// `devkit.cdp {"args":["<名>","cmd","plugin-manager.list"]}` 就是,那是看,不是验。
