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
import { providesDeclarationProblems } from './provides-declaration.js'
import { KERNEL_PACKAGE, isCaretRange, kernelRangeCovers } from './kernel-compat.js'
import { isRecord, versionCore } from './vocab.js'

/** git 工作区的状态。`dirty` 里是 porcelain 条目原文（两列状态加路径） */
export type GitStatus = { ok: true; dirty: string[] } | { ok: false; error: string }

export interface ReleaseDeps {
  /** 前台运行一条命令到结束：成没成加输出的最后几行 */
  run(plan: RunPlan, timeoutMs: number): Promise<{ ok: boolean; tail: string }>
  /**
   * 发一个正式版：在临时目录组装发布内容再 publish，不改仓里的 package.json。
   * `ranges` 是依赖名 → 写进去的范围：同一次发的包给 `^新版本号`，其余 workspace 依赖由实现按工作区里的版本号补 `^`
   */
  publish(input: { pkgDir: string; version: string; registry: string; ranges: Record<string, string> }): Promise<{ ok: boolean; tail: string }>
  /** 这个版本号在源上有没有。问不出来当没有（发的时候源会再拒一次，那才是准的） */
  published(spec: string, registry: string): Promise<boolean>
  /** 源上这个包的 `dist-tags.latest`。问不出、没发过正式版都回 undefined */
  latest(pkg: string, registry: string): Promise<string | undefined>
  /** 仓根的 git 工作区干不干净。问不出（不是 git 仓、没装 git）也是一种答案：拒 */
  gitStatus(repoDir: string): Promise<GitStatus>
  readText(file: string): string | undefined
  exists(target: string): boolean
  /** 包目录 `src/` 下全部 `.ts` / `.tsx` 连成的一份文本，按它找源码提供的服务 */
  sourceTextOf(pkgDir: string): string
  /** pnpm 的可执行文件：命令开头 `locatePnpm` 找到并核对过版本的那个 */
  pnpm: string
}

export interface ReleaseInput {
  /** 仓根。构建与 git 检查都在这里运行 */
  repoDir: string
  /** 要发的包目录，相对仓根，按依赖顺序（被依赖的排前面）。空表＝仓根自己 */
  packages: string[]
  /** 运行中的内核版本号（devkit 自己的 `gwbKernel.version`）。插件包 peer 里内核包的范围必须包含它 */
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
  /** 发版前检查过了但值得说一声的（写了 peer `cordis` 而 node 侧产物没有 import 它）。没有就是空表 */
  reminders: string[]
  /** 发完之后的下一步。说清「升级 default」为什么不在这条命令里 */
  note: string
}

export type ReleaseOutcome =
  | { ok: true; data: ReleaseReport }
  | { ok: false; error: string; data?: { shipped: ReleasedPackage[] } }

/** git status 输出里算作改动的那些行 */
export function dirtyLines(tail: string): string[] {
  return tail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    // porcelain 条目是「两列状态加路径」（`?? out/`、` M src/x.ts`）；别的行多半是 stderr 里的噪音（safe.directory 警告之类）
    .filter((line) => /^[ MADRCU?!]{1,3}\s+\S/.test(line))
}

const SCOPE = '@godcreator/'
const EXACT = /^\d+\.\d+\.\d+$/

/** 发版前检查要看的那部分清单：包自己的版本号，全部 peer（含内核包），`@godcreator/*` 的 dev，是不是插件 */
export interface TicketManifest {
  name: string
  version: string
  /** peerDependencies 的全部条目，不只 `@godcreator` */
  peers: Record<string, string>
  /** devDependencies 里的 `@godcreator` 条目 */
  devs: Record<string, string>
  /** `keywords` 里有 `gwb-plugin` */
  plugin: boolean
  /** `gwb.requires` 的原值；没写时是 undefined */
  requires: unknown
  /** devDependencies 的全部条目，`gwb.requires` 的每个包都要在这里 */
  allDevs: Record<string, string>
}

/** 一个包的检查结论。`problems` 非空就拒；`reminders` 只提醒不拒 */
export interface Ticket {
  pkg: string
  problems: string[]
  reminders: string[]
}

function trimmedStringEntriesOf(table: unknown, keep: (key: string) => boolean): Record<string, string> {
  const entries: Record<string, string> = {}
  if (typeof table !== 'object' || table === null) return entries
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (keep(key) && typeof value === 'string') entries[key] = value.trim()
  }
  return entries
}

/** 读不懂回 undefined（那种包在前面的检查就拦下了） */
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
  return {
    name,
    version,
    peers: trimmedStringEntriesOf(peerDependencies, () => true),
    devs: trimmedStringEntriesOf(devDependencies, (key) => key.startsWith(SCOPE)),
    plugin: Array.isArray(keywords) && keywords.includes('gwb-plugin'),
    requires: isRecord(doc) && isRecord(doc['gwb']) ? doc['gwb']['requires'] : undefined,
    allDevs: trimmedStringEntriesOf(devDependencies, () => true),
  }
}

const MINIMUM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * 是不是合法的最低版本号：x.y.z，每段是不带前导零的数字，不带预发布段与构建段。
 * 与插件管理的 `src/requires.ts` 各存一份、不跨包 import；`tests/requires-parity.test.ts` 对照两份
 */
export function isMinimumVersion(value: string): boolean {
  return MINIMUM_VERSION.test(value)
}

/**
 * 不是插件包的、没写 `gwb.requires` 的不查。拒四类：不是对象；某个值不是 x.y.z；某个包不在 devDependencies 里；
 * 要求的版本高于 dev 范围的下限。dev 写 `workspace:` 的不比下限：发出去写成 `^工作区里的版本号`
 */
export function requiresProblems(manifest: TicketManifest): string[] {
  if (!manifest.plugin || manifest.requires === undefined) return []
  const requires = manifest.requires
  if (!isRecord(requires)) {
    return [`gwb.requires 是 ${JSON.stringify(requires)}:要写成对象 { "<包名>": "<最低版本号 x.y.z>" }`]
  }
  return Object.entries(requires).flatMap(([pkg, minimum]) => requireProblem(pkg, minimum, manifest.allDevs[pkg]))
}

/** `gwb.requires` 里一条要求的问题；没问题时是空表 */
function requireProblem(pkg: string, minimum: unknown, devRange: string | undefined): string[] {
  if (typeof minimum !== 'string' || !isMinimumVersion(minimum)) {
    return [`gwb.requires 里 ${pkg} 是 ${JSON.stringify(minimum)}:最低版本号要写成 x.y.z(不带 ^、不带预发布段),如 "0.5.0"`]
  }
  if (devRange === undefined) {
    return [`gwb.requires 写了 ${pkg},devDependencies 里却没有:dev 里写上 "^${minimum}",对着它开发和验证`]
  }
  if (devRange.startsWith('workspace:')) return []
  const floor = EXACT.test(devRange) ? devRange : caretFloor(devRange)
  if (floor === undefined) {
    return [`gwb.requires 写了 ${pkg},devDependencies 里它是 "${devRange}",认不出下限:dev 要写 ^x.y.z 或精确号`]
  }
  if (compareVersions(minimum, floor) > 0) {
    return [
      `gwb.requires 要求 ${pkg} ≥ ${minimum},高于 devDependencies "${devRange}" 的下限 ${floor}:本地没对着 ${minimum} 验过。把 dev 升到 "^${minimum}"、跑 check、在隔离 home 验过再发`,
    ]
  }
  return []
}

/**
 * 不是插件包的不查。拒三类：peer 里没写内核包；写法不是 `^x.y.z`；范围不包含运行中的内核。
 * 建议写的范围是 `^<运行中的内核的 x.y.z>`。运行中的内核版本号不合法直接抛错（它来自内核自己的包清单）
 */
export function kernelPeerProblems(manifest: TicketManifest, runningKernel: string): string[] {
  if (!manifest.plugin) return []
  const declared = manifest.peers[KERNEL_PACKAGE]
  if (kernelRangeCovers(declared, runningKernel)) return []
  const suggested = `^${versionCore(runningKernel)}`
  if (declared === undefined) {
    return [
      `peer 里没写内核包 ${KERNEL_PACKAGE}:在运行中的内核 ${runningKernel} 上验过之后,在 package.json 的 peerDependencies 里写 "${KERNEL_PACKAGE}": "${suggested}"`,
    ]
  }
  if (!isCaretRange(declared)) {
    return [`peer 里内核包 ${KERNEL_PACKAGE} 写的是 "${declared}",不是 ^x.y.z:peer 只许这一种写法,改成 "${suggested}"`]
  }
  return [
    `peer 里内核包 ${KERNEL_PACKAGE} 写的是 "${declared}",不包含运行中的内核 ${runningKernel}(主版本号为 0 时次版本号相同,≥1 时主版本号相同,并且不低于范围的下限):在 ${runningKernel} 上验过之后,改成 "${suggested}"`,
  ]
}

/**
 * `latest` 是各 `@godcreator` 包在源上的 `dist-tags.latest`（问不出的缺席）。拒两类：自己在 0.0.x；
 * dev 写法认不出下限、下限比源上 latest 还新、或 latest 已出 dev 范围。范围内落后（含相等）放行；`workspace:` 的不查
 */
export function checkTicket(manifest: TicketManifest, latest: Record<string, string | undefined>): Ticket {
  const problems: string[] = []

  if (/^0\.0\.\d+/.test(manifest.version)) {
    problems.push(`自己的号是 ${manifest.version}:0.0.x 上 ^ 锁死补丁号,先把 version 抬到 0.1.0`)
  }

  for (const [pkg, range] of Object.entries(manifest.devs)) {
    if (range.startsWith('workspace:')) continue
    const latestOnRegistry = latest[pkg]
    const testedFloor = EXACT.test(range) ? range : caretFloor(range)
    if (testedFloor === undefined) {
      problems.push(`dev ${pkg} 写的是 "${range}":dev 要写 ^<验过的号>(或精确号)`)
      continue
    }
    if (latestOnRegistry === undefined) {
      problems.push(`dev ${pkg} 是 "${range}":问不出源上的 dist-tags.latest(源不通,或它还没发过正式版),查不了`)
      continue
    }
    if (compareVersions(testedFloor, latestOnRegistry) > 0) {
      problems.push(`dev ${pkg} 是 "${range}",比源上 latest ${latestOnRegistry} 还新——写了一个没发的号,改回 "^${latestOnRegistry}"`)
    } else if (!inCaret(testedFloor, latestOnRegistry)) {
      problems.push(`dev ${pkg} 是 "${range}",源上 latest ${latestOnRegistry}(出范围:上游出了破坏版):先适配代码,再把 dev 抬到 "^${latestOnRegistry}",跑 check`)
    }
  }

  return { pkg: `${manifest.name}@${manifest.version}`, problems, reminders: [] }
}

/**
 * 不是插件包的不查：库由用它的插件打包进产物，它的 peer 不进 home。`cordis` 与内核包以外的 peer 一律拒（内核包写没写对由
 * `kernelPeerProblems` 查）；产物 import 了 `cordis` 而 peer 里没有，拒；写了 peer `cordis` 而产物没有 import 它，只提醒
 * （多一条 peer 不会让插件装不上）
 */
export function peerProblems(manifest: TicketManifest, nodeImportsCordis: boolean): Pick<Ticket, 'problems' | 'reminders'> {
  if (!manifest.plugin) return { problems: [], reminders: [] }
  const problems = Object.keys(manifest.peers)
    .filter((pkg) => pkg !== 'cordis' && pkg !== KERNEL_PACKAGE)
    .map(
      (pkg) =>
        `peer 写了 ${pkg}:peer 只写 home 根上的两个包——node 侧产物里按值 import 的 cordis,与声明兼容哪些内核的内核包 ${KERNEL_PACKAGE}。按「运行时谁提供」改写——` +
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

/** 发版前检查没过时那句回执：按包分组，一次列全 */
export function ticketRefusal(tickets: Ticket[]): string {
  const failedTickets = tickets.filter((ticket) => ticket.problems.length > 0)
  const problemCount = failedTickets.reduce((sum, ticket) => sum + ticket.problems.length, 0)
  const blocks = failedTickets.map((ticket) => `${ticket.pkg}:\n${ticket.problems.map((line) => `  - ${line}`).join('\n')}`)
  return (
    `发版前检查没过(${String(failedTickets.length)} 个包 ${String(problemCount)} 条),一个都没发。规矩见说明书 gwb-release 与 devkit 文档站「写插件的规矩」;逐条改完、跑 check、提交,再来:\n` +
    blocks.join('\n')
  )
}

/** node 侧构建产物用的 tsconfig，相对包目录 */
export const NODE_BUILD_TSCONFIG = 'tsconfig.build.json'
/** 包目录的通用 tsconfig，没有 `tsconfig.build.json` 时 node 侧查它 */
export const NODE_TSCONFIG = 'tsconfig.json'
/** 浏览器侧的 tsconfig，相对包目录 */
export const CLIENT_TSCONFIG = 'src/client/tsconfig.json'

/**
 * 只查构建产物的类型链，测试与构建脚本不查：node 侧有 `tsconfig.build.json` 就查它，没有才查 `tsconfig.json`；
 * 浏览器侧有 `src/client/tsconfig.json` 就再查一次。node 侧两份都没有回 undefined，调用方拒
 */
export function typecheckTsconfigs(pkgDir: string, exists: (target: string) => boolean): string[] | undefined {
  const nodeSide = [NODE_BUILD_TSCONFIG, NODE_TSCONFIG].find((one) => exists(path.join(pkgDir, one)))
  if (nodeSide === undefined) return undefined
  return exists(path.join(pkgDir, CLIENT_TSCONFIG)) ? [nodeSide, CLIENT_TSCONFIG] : [nodeSide]
}

/**
 * 在包目录里经 pnpm exec 运行被发仓自己装的 tsc。命令行的 `--noEmit` 盖过 `tsconfig.build.json` 里的
 * `noEmit: false`，与 `declaration`、`outDir` 同在也不报错、不写 dist（typescript 7.0.2 实测）
 */
export function typecheckArgs(tsconfig: string): string[] {
  return ['exec', 'tsc', '--noEmit', '-p', tsconfig, '--skipLibCheck', 'false']
}

/** 类型检查的输出只留最后这么多行：报错在最后 */
const TYPECHECK_TAIL_LINES = 20

function typecheckProblem(tsconfig: string, tail: string): string {
  const lines = tail.split(/\r?\n/).filter((line) => line.trim() !== '')
  const shownLines = lines.slice(-TYPECHECK_TAIL_LINES).map((line) => `      ${line}`)
  return (
    `按 ${tsconfig} 做的类型检查没过(tsc --noEmit -p ${tsconfig} --skipLibCheck false):` +
    `类型引用到的包(含上游 d.ts 引用到的)要在 dev 里列全,只引类型写 import type。输出的最后几行:\n${shownLines.join('\n')}`
  )
}

const NO_TSCONFIG_PROBLEM =
  `包目录下 ${NODE_BUILD_TSCONFIG} 与 ${NODE_TSCONFIG} 都没有:发版前检查要按其中一份` +
  `(有 ${NODE_BUILD_TSCONFIG} 就用它)在 skipLibCheck: false 下跑一次类型检查`

type Refusal = { ok: false; error: string }

async function refusalIfTreeDirty(repoDir: string, deps: ReleaseDeps): Promise<Refusal | undefined> {
  const status = await deps.gitStatus(repoDir)
  if (!status.ok) {
    return { ok: false, error: `问不出 ${repoDir} 的 git 状态:${status.error}——正式版只从 git 仓里发。还没 init 的话,先 init 并提交` }
  }
  if (status.dirty.length === 0) return undefined
  const shown = status.dirty.slice(0, 8)
  const rest = status.dirty.length > shown.length ? `\n…共 ${String(status.dirty.length)} 条` : ''
  return { ok: false, error: `仓根的 git 树不干净,一个都没发。正式版只从提交过的状态发——先提交或收掉这些:\n${shown.join('\n')}${rest}` }
}

interface PlannedPackage {
  pkgDir: string
  manifest: Manifest
}

/** 每个包：清单读得出、`files` 白名单里的产物都在、这个版本号源上还没有；`ranges` 是同一次发的包 → `^新版本号` */
async function planPackages(input: ReleaseInput, deps: ReleaseDeps): Promise<Refusal | { planned: PlannedPackage[]; ranges: Record<string, string> }> {
  const dirs = input.packages.length > 0 ? input.packages : ['.']
  const planned: PlannedPackage[] = []
  const ranges: Record<string, string> = {}
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
    if (await deps.published(`${manifest.name}@${manifest.version}`, DEFAULT_REGISTRY)) {
      return { ok: false, error: `${manifest.name}@${manifest.version} 已经在源上了——同一个号永不重发,先抬 package.json 里的号再发` }
    }
    planned.push({ pkgDir, manifest })
    ranges[manifest.name] = `^${manifest.version}`
  }
  return { planned, ranges }
}

interface CheckedPackage {
  pkgDir: string
  text: string
  ticket: TicketManifest
}

function readTicketManifests(planned: PlannedPackage[], deps: ReleaseDeps): Refusal | CheckedPackage[] {
  const checked: CheckedPackage[] = []
  for (const plannedPackage of planned) {
    const text = deps.readText(path.join(plannedPackage.pkgDir, 'package.json'))
    const ticket = ticketManifestOf(text)
    if (text === undefined || ticket === undefined) {
      return { ok: false, error: `${plannedPackage.manifest.name} 的 package.json 在构建之后读不出来了,一个都没发` }
    }
    checked.push({ pkgDir: plannedPackage.pkgDir, text, ticket })
  }
  return checked
}

/** 各包 `@godcreator` dev 依赖（`workspace:` 的除外）在源上的 latest */
async function latestOfUpstreams(checked: CheckedPackage[], deps: ReleaseDeps): Promise<Record<string, string | undefined>> {
  const upstreams = new Set<string>()
  for (const { ticket } of checked) {
    for (const [pkg, range] of Object.entries(ticket.devs)) if (!range.startsWith('workspace:')) upstreams.add(pkg)
  }
  const latest: Record<string, string | undefined> = {}
  for (const pkg of upstreams) latest[pkg] = await deps.latest(pkg, DEFAULT_REGISTRY)
  return latest
}

async function typecheckProblems(pkgDir: string, deps: ReleaseDeps): Promise<string[]> {
  const tsconfigs = typecheckTsconfigs(pkgDir, deps.exists)
  if (tsconfigs === undefined) return [NO_TSCONFIG_PROBLEM]
  const problems: string[] = []
  for (const tsconfig of tsconfigs) {
    const typecheck = await deps.run(pnpmPlan(typecheckArgs(tsconfig), pkgDir, deps.pnpm), BUILD_TIMEOUT_MS)
    if (!typecheck.ok) problems.push(typecheckProblem(tsconfig, typecheck.tail))
  }
  return problems
}

async function ticketFor(checkedPackage: CheckedPackage, latest: Record<string, string | undefined>, runningKernel: string, deps: ReleaseDeps): Promise<Ticket> {
  const { pkgDir, text, ticket } = checkedPackage
  const parsed: unknown = JSON.parse(text)
  const doc = isRecord(parsed) ? parsed : {}
  const artifacts = artifactFindings(pkgDir, doc, ticket.plugin, deps)
  const peers = peerProblems(ticket, artifacts.nodeImportsCordis)
  const problems = [
    ...checkTicket(ticket, latest).problems,
    ...peers.problems,
    ...kernelPeerProblems(ticket, runningKernel),
    ...requiresProblems(ticket),
    ...providesDeclarationProblems(doc, deps.sourceTextOf(pkgDir)),
    ...artifacts.problems,
    ...(await typecheckProblems(pkgDir, deps)),
  ]
  return { pkg: `${ticket.name}@${ticket.version}`, problems, reminders: peers.reminders }
}

/** 按给的顺序发：被依赖的先发，不然装的时候源上还没有它 */
async function publishInOrder(planned: PlannedPackage[], ranges: Record<string, string>, deps: ReleaseDeps): Promise<Refusal & { data: { shipped: ReleasedPackage[] } } | ReleasedPackage[]> {
  const shipped: ReleasedPackage[] = []
  for (const plannedPackage of planned) {
    const sent = await deps.publish({ pkgDir: plannedPackage.pkgDir, version: plannedPackage.manifest.version, registry: DEFAULT_REGISTRY, ranges })
    if (!sent.ok) {
      return { ok: false, error: `${plannedPackage.manifest.name}@${plannedPackage.manifest.version} 发版没成:\n${sent.tail}`, data: { shipped } }
    }
    shipped.push({ pkg: plannedPackage.manifest.name, version: plannedPackage.manifest.version, dir: plannedPackage.pkgDir })
  }
  return shipped
}

/** git 工作区干净 → 仓根构建 → 查产物与版本号 → 发版前检查 → 按顺序发。检查全部在发第一个包之前做完 */
export async function runRelease(input: ReleaseInput, deps: ReleaseDeps): Promise<ReleaseOutcome> {
  const dirtyTree = await refusalIfTreeDirty(input.repoDir, deps)
  if (dirtyTree !== undefined) return dirtyTree

  // 在仓根构建，不在包目录：工作区里的插件常常用着同仓另一个包的产物
  const built = await deps.run(pnpmPlan(['build'], input.repoDir, deps.pnpm), BUILD_TIMEOUT_MS)
  if (!built.ok) return { ok: false, error: `仓根 pnpm build 没成,一个都没发。输出的最后几行:\n${built.tail}` }

  const plan = await planPackages(input, deps)
  if ('ok' in plan) return plan

  const checked = readTicketManifests(plan.planned, deps)
  if ('ok' in checked) return checked
  const latest = await latestOfUpstreams(checked, deps)
  const tickets: Ticket[] = []
  for (const checkedPackage of checked) tickets.push(await ticketFor(checkedPackage, latest, input.runningKernel, deps))
  const reminders = tickets.flatMap((ticket) => ticket.reminders.map((line) => `${ticket.pkg}:${line}`))
  if (tickets.some((ticket) => ticket.problems.length > 0)) {
    const remindersNote = reminders.length > 0 ? `\n另有提醒(不拒):\n${reminders.map((line) => `  - ${line}`).join('\n')}` : ''
    return { ok: false, error: ticketRefusal(tickets) + remindersNote }
  }

  const shipped = await publishInOrder(plan.planned, plan.ranges, deps)
  if (!Array.isArray(shipped)) return shipped

  const shippedList = shipped.map((one) => `${one.pkg}@${one.version}`).join('、')
  return {
    ok: true,
    data: {
      repoDir: input.repoDir,
      shipped,
      reminders,
      note:`发好了 ${shippedList}(tag latest)。这条命令只发到源、没碰任何 home:升级 default 用 plugin-manager.update-all(由插件管理自己做,热重新加载时它不会被停掉)。发版前该在隔离 home 里验过的,验完再升级`,
    },
  }
}
