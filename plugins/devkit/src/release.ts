import path from 'node:path'
import { BUILD_TIMEOUT_MS, DEFAULT_REGISTRY, literalArtifacts, pnpmPlan, type RunPlan, type RunResult } from './dev.js'
import { KERNEL_PACKAGE, isCaretRange, kernelRangeCovers } from '@godcreator/gwb-plugin-manager'
import { artifactProblems } from './artifact-check.js'
import { isRecord, versionCore } from './vocab.js'

/** git 工作区的状态。`dirty` 里是 porcelain 条目原文（两列状态加路径） */
export type GitStatus = { ok: true; dirty: string[] } | { ok: false; error: string }

export interface ReleaseDeps {
  /** 前台运行一条命令到结束：成没成加输出的最后几行；超时终止整棵进程树 */
  run(plan: RunPlan, timeoutMs: number): Promise<RunResult>
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
const CARET = /^\^(\d+\.\d+\.\d+)$/
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** `x.y.z`，可带预发布段与构建段 */
function isVersion(version: string): boolean {
  return SEMVER.test(version)
}

interface ParsedVersion {
  core: number[]
  prerelease: string[]
}

/** 认不出直接抛错：比较的两边都该是查过的版本号，源上问来的号在 `checkTicket` 里先查 */
function parseVersion(version: string): ParsedVersion {
  const match = SEMVER.exec(version)
  if (match === null) throw new Error(`"${version}" 不是版本号(要 x.y.z,可带 -预发布段),没法比大小`)
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

/** 两个都带预发布段时按点分段比，数字段按数字比、数字段小于非数字段 */
function comparePrereleaseSegments(left: readonly string[], right: readonly string[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number(x) : undefined
    const ny = /^\d+$/.test(y) ? Number(y) : undefined
    if (nx !== undefined && ny !== undefined) return nx < ny ? -1 : 1
    if (nx !== undefined) return -1
    if (ny !== undefined) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 三段逐段按数字比（0.10.0 大于 0.9.9，按字符串比会错）；三段相同时带预发布段的小于不带的 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const x = left.core[i] ?? 0
    const y = right.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }
  return comparePrereleaseSegments(left.prerelease, right.prerelease)
}

/** `^x.y.z` 的下限；别的写法回 undefined */
export function caretFloor(range: string): string | undefined {
  return CARET.exec(range.trim())?.[1]
}

/** `^<floor>` 的上限（不含）：第一个非零段进一，其后归零。0.0.z 锁补丁号、0.y.z 锁次版本号 */
export function caretCeiling(floor: string): string {
  const [major = 0, minor = 0, patch = 0] = floor.split('.').map((one) => Number.parseInt(one, 10) || 0)
  if (major > 0) return `${String(major + 1)}.0.0`
  if (minor > 0) return `0.${String(minor + 1)}.0`
  return `0.0.${String(patch + 1)}`
}

/** 正式号 `version` 在不在 `^<floor>` 范围里。带预发布段的号一概不算（semver 不拿预发布号满足不带预发布的范围） */
export function inCaret(floor: string, version: string): boolean {
  if (version.includes('-')) return false
  return compareVersions(version, floor) >= 0 && compareVersions(version, caretCeiling(floor)) < 0
}

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
}

/** 一个包的检查结论。`problems` 非空就拒 */
export interface Ticket {
  pkg: string
  problems: string[]
}

function trimmedStringEntriesOf(table: unknown, keep: (key: string) => boolean): Record<string, string> {
  const entries: Record<string, string> = {}
  if (typeof table !== 'object' || table === null) return entries
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (keep(key) && typeof value === 'string') entries[key] = value.trim()
  }
  return entries
}

/** 一次发版里一个包的清单只解析这一次：发版前检查、产物检查、发布顺序都用它 */
export interface ReleaseManifest extends TicketManifest {
  /** `files` 白名单里的字符串条目；没写 `files` 是空表 */
  files: string[]
  /** 解析出的整份清单，产物检查从里面读 `exports` */
  doc: Record<string, unknown>
}

/** 不是 JSON 对象、缺 name 或 version（空串也算缺）回 undefined：那不是一个能发的包 */
export function ticketManifestOf(text: string | undefined): ReleaseManifest | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(doc)) return undefined
  const { name, version, files, peerDependencies, devDependencies, keywords } = doc
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') return undefined
  return {
    name,
    version,
    peers: trimmedStringEntriesOf(peerDependencies, () => true),
    devs: trimmedStringEntriesOf(devDependencies, (key) => key.startsWith(SCOPE)),
    plugin: Array.isArray(keywords) && keywords.includes('gwb-plugin'),
    files: Array.isArray(files) ? files.filter((one): one is string => typeof one === 'string') : [],
    doc,
  }
}

/** 包清单是不是一个插件：keywords 含 `gwb-plugin`，或者是 cordis 官方插件（keywords 同时含 `cordis` 与 `plugin`，如 `@cordisjs/plugin-timer`） */
export function isPluginManifest(manifest: unknown): boolean {
  if (!isRecord(manifest) || !Array.isArray(manifest['keywords'])) return false
  const keywords = manifest['keywords']
  return keywords.includes('gwb-plugin') || (keywords.includes('cordis') && keywords.includes('plugin'))
}

const VERSION_CORE = /^(\d+)\.(\d+)\.(\d+)/

/** 两个版本号在不在同一条线上：主版本号为 0 时只看次版本号（0.x），≥1 时只看主版本号；认不出的算不在 */
export function sameReleaseLine(a: string, b: string): boolean {
  const first = VERSION_CORE.exec(a)
  const second = VERSION_CORE.exec(b)
  if (first === null || second === null) return false
  if (first[1] !== second[1]) return false
  return first[1] !== '0' || first[2] === second[2]
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
 * peer 里 `@godcreator` 插件（内核包除外，它比运行中的内核）的范围要和源上 latest 在同一条线上：0.x 只看 x，≥1 只看主版本号。
 * 不在同一条线就是上游出了破坏版，先适配再升范围；`workspace:` 的不查。不是插件包的不查：库的 peer 不进 home
 */
function peerLineProblems(manifest: TicketManifest, latest: Record<string, string | undefined>): string[] {
  if (!manifest.plugin) return []
  const problems: string[] = []
  for (const [pkg, range] of Object.entries(manifest.peers)) {
    if (!pkg.startsWith(SCOPE) || pkg === KERNEL_PACKAGE || range.startsWith('workspace:')) continue
    if (!isCaretRange(range)) {
      problems.push(`peer ${pkg} 写的是 "${range}":peer 只许写 ^x.y.z`)
      continue
    }
    const latestOnRegistry = latest[pkg]
    if (latestOnRegistry === undefined) {
      problems.push(`peer ${pkg} 是 "${range}":问不出源上的 dist-tags.latest(源不通,或它还没发过正式版),查不了`)
    } else if (!sameReleaseLine(range.slice(1), latestOnRegistry)) {
      problems.push(`peer ${pkg} 是 "${range}",源上 latest ${latestOnRegistry}(不在同一条线:上游出了破坏版):先适配代码、在隔离 home 验过,再把 peer 抬到 "^${latestOnRegistry}"`)
    }
  }
  return problems
}

/**
 * `latest` 是各 `@godcreator` 包在源上的 `dist-tags.latest`（问不出的缺席）。拒两类：
 * dev 写法认不出下限、源上 latest 问不出或不是版本号、下限比源上 latest 还新、或 latest 已出 dev 范围（范围内落后、含相等放行）；
 * peer 里的 `@godcreator` 插件和源上 latest 不在同一条线。`workspace:` 的不查
 */
export function checkTicket(manifest: TicketManifest, latest: Record<string, string | undefined>): Ticket {
  const problems: string[] = []

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
    if (!isVersion(latestOnRegistry)) {
      problems.push(`dev ${pkg} 是 "${range}":源上的 dist-tags.latest 是 "${latestOnRegistry}",不是版本号,查不了`)
      continue
    }
    if (compareVersions(testedFloor, latestOnRegistry) > 0) {
      problems.push(`dev ${pkg} 是 "${range}",比源上 latest ${latestOnRegistry} 还新——写了一个没发的号,改回 "^${latestOnRegistry}"`)
    } else if (!inCaret(testedFloor, latestOnRegistry)) {
      problems.push(`dev ${pkg} 是 "${range}",源上 latest ${latestOnRegistry}(出范围:上游出了破坏版):先适配代码,再把 dev 抬到 "^${latestOnRegistry}",跑 check`)
    }
  }
  problems.push(...peerLineProblems(manifest, latest))

  return { pkg: `${manifest.name}@${manifest.version}`, problems }
}

/**
 * 不是插件包的不查：库由用它的插件打包进产物，它的 peer 不进 home。peer 只许三类：`cordis`、内核包（写没写对由
 * `kernelPeerProblems` 查）、别的插件（`peerManifestOf` 读包目录 node_modules 里它的清单，`isPluginManifest` 判）；
 * 别的一律拒。node 侧产物只能 import peer 里的包，由产物检查查
 */
export function peerProblems(manifest: TicketManifest, peerManifestOf: (pkg: string) => unknown): string[] {
  if (!manifest.plugin) return []
  const problems: string[] = []
  for (const pkg of Object.keys(manifest.peers).filter((one) => one !== 'cordis' && one !== KERNEL_PACKAGE)) {
    const peerManifest = peerManifestOf(pkg)
    if (peerManifest === undefined) {
      problems.push(`peer 写了 ${pkg},包目录的 node_modules 里读不到它的清单:先在仓根 pnpm install,不猜它是不是插件`)
    } else if (!isPluginManifest(peerManifest)) {
      problems.push(
        `peer 写了 ${pkg},它不是插件(keywords 里没有 gwb-plugin,也不是 cordis 官方插件):peer 只写运行时从 home 里得到的东西——cordis、内核包 ${KERNEL_PACKAGE}、用到的别的插件。` +
          `库、接口定义包、importmap 里的包、构建时才用的包写 devDependencies、打包进产物;` +
          `打包不进产物的自用库(原生可执行文件、运行时按路径读自己文件的包)写 dependencies,并在清单里写明原因`,
      )
    }
  }
  return problems
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
  manifest: ReleaseManifest
}

/** 每个包：清单读得出、`files` 白名单里的产物都在、这个版本号源上还没有；`ranges` 是同一次发的包 → `^新版本号` */
async function planPackages(input: ReleaseInput, deps: ReleaseDeps): Promise<Refusal | { planned: PlannedPackage[]; ranges: Record<string, string> }> {
  const dirs = input.packages.length > 0 ? input.packages : ['.']
  const planned: PlannedPackage[] = []
  const ranges: Record<string, string> = {}
  for (const rel of dirs) {
    const pkgDir = path.resolve(input.repoDir, rel)
    const manifest = ticketManifestOf(deps.readText(path.join(pkgDir, 'package.json')))
    if (manifest === undefined) {
      return { ok: false, error: `${pkgDir} 下没有能读的 package.json(或缺 name/version)——包目录给的是相对仓根的路径` }
    }
    // 产物在不在照 files 白名单问，不另列一份名单
    const missing = literalArtifacts(manifest.files).filter((one) => !deps.exists(path.join(pkgDir, one)))
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

/** 各包 `@godcreator` dev 依赖与 peer 里 `@godcreator` 插件（内核包、`workspace:` 的除外）在源上的 latest */
async function latestOfUpstreams(planned: PlannedPackage[], deps: ReleaseDeps): Promise<Record<string, string | undefined>> {
  const upstreams = new Set<string>()
  for (const { manifest } of planned) {
    for (const [pkg, range] of Object.entries(manifest.devs)) if (!range.startsWith('workspace:')) upstreams.add(pkg)
    for (const [pkg, range] of Object.entries(manifest.peers)) {
      if (pkg.startsWith(SCOPE) && pkg !== KERNEL_PACKAGE && !range.startsWith('workspace:')) upstreams.add(pkg)
    }
  }
  const latest: Record<string, string | undefined> = {}
  for (const pkg of upstreams) latest[pkg] = await deps.latest(pkg, DEFAULT_REGISTRY)
  return latest
}

function ticketFor(plannedPackage: PlannedPackage, latest: Record<string, string | undefined>, runningKernel: string, deps: ReleaseDeps): Ticket {
  const { pkgDir, manifest } = plannedPackage
  const peerManifestOf = (pkg: string): unknown => {
    const text = deps.readText(path.join(pkgDir, 'node_modules', ...pkg.split('/'), 'package.json'))
    if (text === undefined) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }
  const problems = [
    ...checkTicket(manifest, latest).problems,
    ...peerProblems(manifest, peerManifestOf),
    ...kernelPeerProblems(manifest, runningKernel),
    ...artifactProblems(pkgDir, manifest.doc, manifest.plugin, deps),
  ]
  return { pkg: `${manifest.name}@${manifest.version}`, problems }
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

  const latest = await latestOfUpstreams(plan.planned, deps)
  const tickets = plan.planned.map((plannedPackage) => ticketFor(plannedPackage, latest, input.runningKernel, deps))
  if (tickets.some((ticket) => ticket.problems.length > 0)) return { ok: false, error: ticketRefusal(tickets) }

  const shipped = await publishInOrder(plan.planned, plan.ranges, deps)
  if (!Array.isArray(shipped)) return shipped

  const shippedList = shipped.map((one) => `${one.pkg}@${one.version}`).join('、')
  return {
    ok: true,
    data: {
      repoDir: input.repoDir,
      shipped,
      note: `发好了 ${shippedList}(tag latest)。这条命令只发到源、没碰任何 home:升级 default 用 plugin-manager.update {"all":true}(由插件管理自己做,热重新加载时它不会被停掉)。发版前该在隔离 home 里验过的,验完再升级`,
    },
  }
}
