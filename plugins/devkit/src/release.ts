import path from 'node:path'
import {
  BUILD_TIMEOUT_MS,
  DEFAULT_REGISTRY,
  type Manifest,
  literalArtifacts,
  parseManifest,
  pnpmPlan,
  type RunPlan,
} from './dev.js'
import { caretFloor, compareVersions, inCaret } from './audit.js'
import { artifactFindings } from './artifact-check.js'
import { declaredTestedKernel, kernelVersionLine, testedOnSameKernelLine } from './tested-kernel.js'
import { isRecord } from './vocab.js'

/**
 * 发正式版那条链的纯机:守卫、号从哪来、依赖写成什么、按什么顺序发。
 *
 * **与「改一版看一版」是两种安全模型。** devkit.dev 要站在被换的那个进程外面(重挂那一下
 * 会把跑在目标里的调用方停掉),所以它住控制台、操作另一个 home;而这一条只碰 registry、
 * 一个 home 都不碰——从哪个 home 调都行,没有自停问题。
 *
 * **号在仓里抬,不在这一趟里抬。** 抬号是语义行为(这一版变了什么),该跟着版本提交一起走
 * git 纪律;这条链只发 package.json 里声明的那个号,同号在源上就拒。于是「仓根 git 树干净」
 * 成了第一道守卫:正式版把未提交的改动发成 latest,是最贵的那种事故——别的仓悄悄换代码,
 * 一点异常都看不出来。
 *
 * **依赖写 `^` 范围,不钉准确号。** 开发版必须钉(semver 不拿预发布版满足范围,不钉就是
 * 新件配旧库);正式版正相反——它就是要被 `^` 认到,消费方跟着拿破坏边界以内的后续版本。
 * 这一趟同发的兄弟写成 `^新号`,没跟着发的 workspace 依赖写成 `^工作区里那个号`。
 *
 * **发版前检查在构建之后、发第一个包之前**,所有包的问题一次列全,有一条就一个都不发:
 *
 * - 每个包:自己不在 0.0.x;`@godcreator` 的 dev 范围包含源上 `dist-tags.latest`(范围内落后
 *   不追,出范围必追)(`checkTicket`);产物里没有空 import、相对 import 指向的文件都在
 *   (`artifact-check.ts`);按构建产物的 tsconfig 跑 `tsc --noEmit --skipLibCheck false` 通过(`typecheckTsconfigs`,用被发仓自己的 tsc)
 * - 插件包(`keywords` 含 `gwb-plugin`)另加:peer 里只有 `cordis`,node 侧产物按值 import 了
 *   `cordis` 就必须写 peer `cordis`(`peerProblems`);node 侧产物的包名 import 只有 node 内置模块、
 *   `electron`、`cordis`,浏览器侧只有 importmap 里的名字(`artifact-check.ts`);`gwb.testedKernel`
 *   写了、是合法版本号、和运行中的内核在同一条版本线上(`testedKernelProblems`)
 */

/** git 树的状态。`dirty` 里是 porcelain 条目原文(两列状态加路径) */
export type GitStatus = { ok: true; dirty: string[] } | { ok: false; error: string }

export interface ReleaseDeps {
  /** 前台跑一条命令到结束:成没成加输出尾巴 */
  run(plan: RunPlan, timeoutMs: number): Promise<{ ok: boolean; tail: string }>
  /**
   * 发一个正式版:在临时目录摆一份分发形态再 publish(**不改仓里的 package.json**)。
   * `ranges` 是依赖名 → 该写进去的范围:这一趟同发的包给 `^新号`,其余 workspace 依赖
   * 由真身那层照工作区现号补 `^`。
   */
  publish(input: { pkgDir: string; version: string; registry: string; ranges: Record<string, string> }): Promise<{ ok: boolean; tail: string }>
  /** 这个号在源上有没有。问不出来当没有(发的时候源会再拒一次,那才是权威) */
  published(spec: string, registry: string): Promise<boolean>
  /** 源上这个包的 `dist-tags.latest`。问不出、没发过正式版都回 undefined */
  latest(pkg: string, registry: string): Promise<string | undefined>
  /** 仓根的 git 树干不干净。问不出(不是 git 仓 / git 不在)也是一种答案:拒 */
  gitStatus(repoDir: string): Promise<GitStatus>
  readText(file: string): string | undefined
  exists(target: string): boolean
  platform: NodeJS.Platform
}

export interface ReleaseInput {
  /** 仓根。构建与 git 守卫都在这儿跑 */
  repoDir: string
  /** 要发的包目录,相对仓根,按依赖顺序(被依赖的排前面)。空表＝仓根自己(一仓一包一插件的常态) */
  packages: string[]
  /** 运行中的内核版本号(devkit 自己的 `gwbKernel.version`),插件包的 `gwb.testedKernel` 和它比对 */
  runningKernel: string
}

export interface ReleasedPackage {
  pkg: string
  version: string
  dir: string
}

export interface ReleaseReport {
  repoDir: string
  shipped: ReleasedPackage[]
  /** 发版前检查过了但值得说一声的(写了 peer `cordis` 而 node 侧产物没有 import 它)。没有就是空表 */
  reminders: string[]
  /** 发完之后的下一步。说清「升 default」为什么不在这条链里,免得人以为少了半截 */
  note: string
}

export type ReleaseOutcome =
  | { ok: true; data: ReleaseReport }
  | { ok: false; error: string; data?: { shipped: ReleasedPackage[] } }

/** 干净树守卫拒不拒的口径单独成一条,测试里两种平台都跑得到 */
export function dirtyLines(tail: string): string[] {
  return tail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    // porcelain 条目长成「两列状态加路径」(`?? out/`、` M src/x.ts`);别的行多半是 stderr
    // 里的噪音(git 的 safe.directory 警告之类),不拿来当脏
    .filter((line) => /^[ MADRCU?!]{1,3}\s+\S/.test(line))
}

const SCOPE = '@godcreator/'
const EXACT = /^\d+\.\d+\.\d+$/

/** 发版前检查要看的那部分清单:包自己的号,全部 peer,`@godcreator/*` 的 dev,是不是插件,测过的内核版本 */
export interface TicketManifest {
  name: string
  version: string
  /** peerDependencies 的全部条目,不只 `@godcreator` */
  peers: Record<string, string>
  /** devDependencies 里的 `@godcreator` 条目 */
  devs: Record<string, string>
  /** `keywords` 里有 `gwb-plugin` */
  plugin: boolean
  /** `gwb.testedKernel` 的值;没写或不是字符串时是 undefined */
  testedKernel: string | undefined
}

/** 一个包的检票结论。`problems` 非空就拒;`reminders` 只提醒不拒 */
export interface Ticket {
  pkg: string
  problems: string[]
  reminders: string[]
}

/** 从 package.json 原文里摘出检票要的那部分。读不懂回 undefined(那种包在前面的守卫就拦下了) */
export function ticketManifestOf(text: string | undefined): TicketManifest | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof doc !== 'object' || doc === null) return undefined
  const { name, version, peerDependencies, devDependencies, keywords } = doc as Record<string, unknown>
  if (typeof name !== 'string' || typeof version !== 'string') return undefined
  const entries = (table: unknown, keep: (key: string) => boolean): Record<string, string> => {
    const out: Record<string, string> = {}
    if (typeof table !== 'object' || table === null) return out
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (keep(key) && typeof value === 'string') out[key] = value.trim()
    }
    return out
  }
  return {
    name,
    version,
    peers: entries(peerDependencies, () => true),
    devs: entries(devDependencies, (key) => key.startsWith(SCOPE)),
    plugin: Array.isArray(keywords) && keywords.includes('gwb-plugin'),
    testedKernel: declaredTestedKernel(doc),
  }
}

/**
 * 插件包的 `gwb.testedKernel` 检查,纯函数。不是插件包的(库、工具包)不查。
 * 拒的三类:没写;不是合法版本号;和运行中的内核不在同一条版本线上(主版本号为 0 比前两位,≥1 只比主版本号)。
 */
export function testedKernelProblems(manifest: TicketManifest, runningKernel: string): string[] {
  if (!manifest.plugin) return []
  const tested = manifest.testedKernel
  if (testedOnSameKernelLine(tested, runningKernel)) return []
  if (tested === undefined) {
    return [`没写 gwb.testedKernel:在运行中的内核 ${runningKernel} 上验过之后,在 package.json 的 gwb 字段里写 "testedKernel": "${runningKernel}"`]
  }
  if (kernelVersionLine(tested) === undefined) {
    return [`gwb.testedKernel 是 "${tested}",不是合法的版本号:要写成 x.y.z,如 "${runningKernel}"`]
  }
  return [
    `gwb.testedKernel 是 ${tested},和运行中的内核 ${runningKernel} 不在同一条版本线上(主版本号为 0 比前两位,≥1 只比主版本号):在 ${runningKernel} 上验过之后,改成 "${runningKernel}"`,
  ]
}

/**
 * 版本号与 dev 范围的检查,纯函数。`latest` 是各 `@godcreator` 包在源上的 `dist-tags.latest`(问不出的缺席)。
 *
 * 拒的两类:自己在 0.0.x;dev 写法认不出下限、或下限比源上 latest 还新、或 latest 已出 dev 范围
 * (出范围必追)。范围内落后(含相等)一律放行。`workspace:` 的 dev 不查:同仓的包不经源解析。
 */
export function checkTicket(manifest: TicketManifest, latest: Record<string, string | undefined>): Ticket {
  const problems: string[] = []

  if (/^0\.0\.\d+/.test(manifest.version)) {
    problems.push(`自己的号是 ${manifest.version}:0.0.x 上 ^ 锁死补丁号,先把 version 抬到 0.1.0`)
  }

  for (const [pkg, raw] of Object.entries(manifest.devs)) {
    if (raw.startsWith('workspace:')) continue
    const now = latest[pkg]
    const pin = EXACT.test(raw) ? raw : caretFloor(raw)
    if (pin === undefined) {
      problems.push(`dev ${pkg} 写的是 "${raw}":dev 要写 ^<验过的号>(或精确号)`)
      continue
    }
    if (now === undefined) {
      problems.push(`dev ${pkg} 是 "${raw}":问不出源上的 dist-tags.latest(源不通,或它还没发过正式版),检不了票`)
      continue
    }
    if (compareVersions(pin, now) > 0) {
      problems.push(`dev ${pkg} 是 "${raw}",比源上 latest ${now} 还新——写了一个没发的号,改回 "^${now}"`)
    } else if (inCaret(pin, now)) {
      // 范围内落后(含相等)放行:对上游 semver 的信任就是范围声明的含义,不设强制刷新
    } else {
      problems.push(`dev ${pkg} 是 "${raw}",源上 latest ${now}(出范围:上游出了破坏版):先适配代码,再把 dev 抬到 "^${now}",跑 check`)
    }
  }

  return { pkg: `${manifest.name}@${manifest.version}`, problems, reminders: [] }
}

/**
 * 插件包的 peer 检查,纯函数。不是插件包的不查:库由用它的插件打包进产物,它的 peer 不进 home。
 *
 * peer 只写宿主提供、node 侧产物里按值 import 的 `cordis`:别的 peer 一律拒;产物 import 了
 * `cordis` 而 peer 里没有,拒;写了 peer `cordis` 而产物没有 import 它,只提醒(多一条 peer 不会
 * 让插件装不上)。
 */
export function peerProblems(manifest: TicketManifest, nodeImportsCordis: boolean): Pick<Ticket, 'problems' | 'reminders'> {
  if (!manifest.plugin) return { problems: [], reminders: [] }
  const problems = Object.keys(manifest.peers)
    .filter((pkg) => pkg !== 'cordis')
    .map(
      (pkg) =>
        `peer 写了 ${pkg}:peer 只写宿主提供、node 侧产物里按值 import 的 cordis。按「运行时谁提供」改写——` +
        `另一个插件、接口定义包、importmap 里的包、运行时自己用的库(打包进产物)、构建时才用的包都写 devDependencies;` +
        `打包不进产物的自用库(原生可执行文件、运行时按路径读自己文件的包)写 dependencies,并在清单里写明原因`,
    )
  const peersCordis = 'cordis' in manifest.peers
  if (nodeImportsCordis && !peersCordis) {
    problems.push('node 侧产物按值 import 了 cordis,peer 里却没有:写 peer cordis(dev 里也留一份给本地构建和类型检查)')
  }
  const reminders =
    peersCordis && !nodeImportsCordis ? ['写了 peer cordis,但 node 侧产物里没有 import cordis:只 import 类型时不写 peer,这条可以删'] : []
  return { problems, reminders }
}

/** 发版前检查没过时那句回执:按包分组,一次列全 */
export function ticketRefusal(tickets: Ticket[]): string {
  const failed = tickets.filter((one) => one.problems.length > 0)
  const total = failed.reduce((sum, one) => sum + one.problems.length, 0)
  const blocks = failed.map((one) => `${one.pkg}:\n${one.problems.map((line) => `  - ${line}`).join('\n')}`)
  return (
    `发版前检查没过(${String(failed.length)} 个包 ${String(total)} 条),一个都没发。规矩见说明书 gwb-release 与 devkit 文档站「写插件的规矩」;逐条改完、跑 check、提交,再来:\n` +
    blocks.join('\n')
  )
}

/** node 侧构建产物用的 tsconfig,相对包目录 */
export const NODE_BUILD_TSCONFIG = 'tsconfig.build.json'
/** 包目录的通用 tsconfig,没有 `tsconfig.build.json` 时 node 侧查它 */
export const NODE_TSCONFIG = 'tsconfig.json'
/** 浏览器侧的 tsconfig,相对包目录 */
export const CLIENT_TSCONFIG = 'src/client/tsconfig.json'

/**
 * 发版前类型检查查哪几份 tsconfig。判据:这项检查守的是构建产物的类型链,测试与构建脚本不在其中——
 * node 侧有 `tsconfig.build.json`(构建产物用的那份)就查它,没有才查 `tsconfig.json`;
 * 浏览器侧有 `src/client/tsconfig.json` 就再查一次。node 侧两份都没有回 undefined,调用方拒。
 */
export function typecheckTsconfigs(pkgDir: string, exists: (target: string) => boolean): string[] | undefined {
  const nodeSide = [NODE_BUILD_TSCONFIG, NODE_TSCONFIG].find((one) => exists(path.join(pkgDir, one)))
  if (nodeSide === undefined) return undefined
  return exists(path.join(pkgDir, CLIENT_TSCONFIG)) ? [nodeSide, CLIENT_TSCONFIG] : [nodeSide]
}

/**
 * 在包目录里用 pnpm exec 跑,用的是被发仓自己装的 tsc。命令行的 `--noEmit` 盖过
 * `tsconfig.build.json` 里的 `noEmit: false`,与 `declaration`、`outDir` 同在也不报错、不写 dist
 * (typescript 7.0.2 实测)
 */
export function typecheckArgs(tsconfig: string): string[] {
  return ['exec', 'tsc', '--noEmit', '-p', tsconfig, '--skipLibCheck', 'false']
}

/** 类型检查的输出只留最后这么多行:报错在尾巴上,整份没人读 */
const TYPECHECK_TAIL_LINES = 20

/** 类型检查没过时那条问题:缺哪个包,tsc 会报「找不到模块」并写出包名 */
function typecheckProblem(tsconfig: string, tail: string): string {
  const lines = tail.split(/\r?\n/).filter((line) => line.trim() !== '')
  const shownLines = lines.slice(-TYPECHECK_TAIL_LINES).map((line) => `      ${line}`)
  return (
    `按 ${tsconfig} 做的类型检查没过(tsc --noEmit -p ${tsconfig} --skipLibCheck false):` +
    `类型引用到的包(含上游 d.ts 引用到的)要在 dev 里列全,只引类型写 import type。输出尾巴:\n${shownLines.join('\n')}`
  )
}

/** node 侧两份 tsconfig 都没有时那条问题 */
const NO_TSCONFIG_PROBLEM =
  `包目录下 ${NODE_BUILD_TSCONFIG} 与 ${NODE_TSCONFIG} 都没有:发版前检查要按其中一份` +
  `(有 ${NODE_BUILD_TSCONFIG} 就用它)在 skipLibCheck: false 下跑一次类型检查`

/**
 * 走完一趟:干净树守卫 → 仓根构建 → 算号与验产物 → 上车检票 → 按序发。
 *
 * **守卫全部在发第一个包之前跑完**:正式版发一半停下比开发版发一半糟得多(latest 上出现
 * 新旧混搭的兄弟号),所以清单读不出、产物不全、同号已发,一个都在动手之前拦下。
 */
export async function runRelease(input: ReleaseInput, deps: ReleaseDeps): Promise<ReleaseOutcome> {
  // ── 一、干净树 ──────────────────────────────────────────────────────────────
  // 发出去的必须是你提交过的状态。构建排它后面:构建产物按 files 白名单现生成,而源有没有
  // 改过,git 说了算
  const status = await deps.gitStatus(input.repoDir)
  if (!status.ok) {
    return { ok: false, error: `问不出 ${input.repoDir} 的 git 状态:${status.error}——正式版只从 git 仓里发。还没 init 的话,先 init 并提交` }
  }
  if (status.dirty.length > 0) {
    const shown = status.dirty.slice(0, 8)
    const rest = status.dirty.length > shown.length ? `\n…共 ${String(status.dirty.length)} 条` : ''
    return { ok: false, error: `仓根的 git 树不干净,一个都没发。正式版只从提交过的状态发——先提交或收掉这些:\n${shown.join('\n')}${rest}` }
  }

  // ── 二、构建 ────────────────────────────────────────────────────────────────
  // **仓根构建,不是包目录**:工作区里的件常常吃着同仓另一个包的产物,只构建被发的那一个,
  // 发出去的就是「新件配旧库」
  const built = await deps.run(pnpmPlan(['build'], input.repoDir, deps.platform), BUILD_TIMEOUT_MS)
  if (!built.ok) return { ok: false, error: `仓根 pnpm build 没成,一个都没发。输出尾巴:\n${built.tail}` }

  // ── 三、算号与守卫 ──────────────────────────────────────────────────────────
  const dirs = input.packages.length > 0 ? input.packages : ['.']
  const planned: { pkgDir: string; manifest: Manifest }[] = []
  const ranges: Record<string, string> = {}
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
    // **发的是声明的那个号**:要发新的一版,先在仓里抬号、提交,再回来
    if (await deps.published(`${manifest.name}@${manifest.version}`, DEFAULT_REGISTRY)) {
      return { ok: false, error: `${manifest.name}@${manifest.version} 已经在源上了——同一个号永不重发,先抬 package.json 里的号再发` }
    }
    planned.push({ pkgDir, manifest })
    ranges[manifest.name] = `^${manifest.version}`
  }

  // ── 四、发版前检查 ──────────────────────────────────────────────────────────
  // 全部包一起检、一次列全:一条一条挤的话,改一条来一趟、每趟都白跑一次构建
  const checked: { pkgDir: string; text: string; ticket: TicketManifest }[] = []
  for (const one of planned) {
    const text = deps.readText(path.join(one.pkgDir, 'package.json'))
    const ticket = ticketManifestOf(text)
    if (text === undefined || ticket === undefined) {
      return { ok: false, error: `${one.manifest.name} 的 package.json 在构建之后读不出来了,一个都没发` }
    }
    checked.push({ pkgDir: one.pkgDir, text, ticket })
  }
  const upstreams = new Set<string>()
  for (const { ticket } of checked) {
    for (const [pkg, raw] of Object.entries(ticket.devs)) if (!raw.startsWith('workspace:')) upstreams.add(pkg)
  }
  const latest: Record<string, string | undefined> = {}
  for (const pkg of upstreams) latest[pkg] = await deps.latest(pkg, DEFAULT_REGISTRY)
  const tickets: Ticket[] = []
  for (const { pkgDir, text, ticket } of checked) {
    const doc: unknown = JSON.parse(text)
    const artifacts = artifactFindings(pkgDir, isRecord(doc) ? doc : {}, ticket.plugin, deps)
    const peers = peerProblems(ticket, artifacts.nodeImportsCordis)
    const problems = [
      ...checkTicket(ticket, latest).problems,
      ...peers.problems,
      ...testedKernelProblems(ticket, input.runningKernel),
      ...artifacts.problems,
    ]
    const tsconfigs = typecheckTsconfigs(pkgDir, deps.exists)
    if (tsconfigs === undefined) {
      problems.push(NO_TSCONFIG_PROBLEM)
    } else {
      for (const tsconfig of tsconfigs) {
        const typecheck = await deps.run(pnpmPlan(typecheckArgs(tsconfig), pkgDir, deps.platform), BUILD_TIMEOUT_MS)
        if (!typecheck.ok) problems.push(typecheckProblem(tsconfig, typecheck.tail))
      }
    }
    tickets.push({ pkg: `${ticket.name}@${ticket.version}`, problems, reminders: peers.reminders })
  }
  const reminders = tickets.flatMap((one) => one.reminders.map((line) => `${one.pkg}:${line}`))
  if (tickets.some((one) => one.problems.length > 0)) {
    const tail = reminders.length > 0 ? `\n另有提醒(不拒):\n${reminders.map((line) => `  - ${line}`).join('\n')}` : ''
    return { ok: false, error: ticketRefusal(tickets) + tail }
  }

  // ── 五、按序发 ──────────────────────────────────────────────────────────────
  // **按给的顺序发**:被依赖的先发,不然装的时候源上还没有它。顺序是调用方的事,这儿不猜
  const shipped: ReleasedPackage[] = []
  for (const one of planned) {
    const sent = await deps.publish({ pkgDir: one.pkgDir, version: one.manifest.version, registry: DEFAULT_REGISTRY, ranges })
    if (!sent.ok) {
      return { ok: false, error: `${one.manifest.name}@${one.manifest.version} 发版没成:\n${sent.tail}`, data: { shipped } }
    }
    shipped.push({ pkg: one.manifest.name, version: one.manifest.version, dir: one.pkgDir })
  }

  const list = shipped.map((one) => `${one.pkg}@${one.version}`).join('、')
  return {
    ok: true,
    data: {
      repoDir: input.repoDir,
      shipped,
      reminders,
      note:`发好了 ${list}(tag latest)。这条链只碰源、没碰任何 home:升 default 走 plugin-manager.update-all(那是插件件在调,活得过热重挂)。发版前该在隔离 home 里验过的,验完再升`,
    },
  }
}
