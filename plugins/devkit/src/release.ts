import path from 'node:path'
import { BUILD_TIMEOUT_MS, PLUGIN_KEYWORD, literalArtifacts, pnpmPlan, type RunPlan, type RunResult } from './dev.js'
import { KERNEL_PACKAGE, isCaretRange } from '@godcreator/gwb-plugin-manager'
import { artifactProblems } from './artifact-check.js'
import type { BrowserProviders } from './browser-providers.js'
import { styleProblems, type StyleCheckIo } from './style-check.js'
import { wiringProblems, type WiringCheckIo } from './wiring-check.js'
import { isRecord, packageManifestOf, parseHttpUrl, TEAM_REGISTRY } from './vocab.js'

/** git 工作区的状态。`dirty` 里是 porcelain 条目原文（两列状态加路径） */
export type GitStatus = { ok: true; dirty: string[] } | { ok: false; error: string }

export interface ReleaseDeps {
  /** 前台运行一条命令到结束：成没成加输出的最后几行；超时终止整棵进程树 */
  run(plan: RunPlan, timeoutMs: number): Promise<RunResult>
  /**
   * 发一个正式版：在临时目录组装发布内容再 publish，不改仓里的 package.json。`registry` 是发布目标（`publishTargetOf`），
   * 写进发布内容清单的 `publishConfig.registry`，命令行不带 `--registry`——pnpm 12 里命令行的 `--registry` 盖不过 `.npmrc` 的范围行，
   * `publishConfig.registry` 两者都盖得过。
   * `ranges` 是依赖名 → 写进去的范围：同一次发的包给 `^新版本号`，其余 workspace 依赖由实现按工作区里的版本号补 `^`
   */
  publish(input: { pkgDir: string; version: string; registry: string; ranges: Record<string, string> }): Promise<{ ok: boolean; tail: string }>
  /** 这个版本号在 `registry` 这个源上有没有。问不出来（源连不上、超时）就抛 */
  published(spec: string, registry: string): Promise<boolean>
  /** 源上这个包的 `dist-tags.latest`，问哪个源由 `.npmrc` 按包名范围决定。问不出、没发过正式版都回 undefined */
  latest(pkg: string): Promise<string | undefined>
  /** 仓根的 git 工作区干不干净。问不出（不是 git 仓、没装 git）也是一种答案：拒 */
  gitStatus(repoDir: string): Promise<GitStatus>
  readText(file: string): string | undefined
  browserProviders?(pkgDir: string, manifest: Record<string, unknown>): Promise<BrowserProviders>
  exists(target: string): boolean
  filesUnder: StyleCheckIo['filesUnder']
  tailwindOf: StyleCheckIo['tailwindOf']
  workspacePackageDirs: WiringCheckIo['workspacePackageDirs']
  /** pnpm 的可执行文件：命令开头 `locatePnpm` 找到并核对过版本的那个 */
  pnpm: string
}

export interface ReleaseInput {
  /** 仓根。构建与 git 检查都在这里运行 */
  repoDir: string
  /** 要发的包目录，相对仓根，按依赖顺序（被依赖的排前面）。至少一个，命令入口 `packagesArgOf` 查过 */
  packages: string[]
}

export interface ReleasedPackage {
  pkg: string
  version: string
  dir: string
  /** 发到的源 */
  registry: string
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

/** git status 输出里算作改动的那些行。stdout 与 stderr 合在一起收时也认得出：按 porcelain 条目的样子认 */
export function dirtyLines(tail: string): string[] {
  return tail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    // porcelain 条目是「两列状态加路径」（`?? out/`、` M src/x.ts`）；别的行多半是 stderr 里的噪音（safe.directory 警告之类）
    .filter((line) => /^[ MADRCU?!]{1,3}\s+\S/.test(line))
}

/** 发版前检查要看的那部分清单：包自己的版本号，全部 peer（含内核包），是不是插件。dev 依赖不查 */
export interface TicketManifest {
  name: string
  version: string
  /** peerDependencies 的全部条目，不分范围 */
  peers: Record<string, string>
  /** `keywords` 里有 `gwb-plugin` */
  plugin: boolean
}

/** 一个包的检查结论。`problems` 非空就拒 */
export interface Ticket {
  pkg: string
  problems: string[]
}

function trimmedStringEntriesOf(table: unknown): Record<string, string> {
  const entries: Record<string, string> = {}
  if (typeof table !== 'object' || table === null) return entries
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (typeof value === 'string') entries[key] = value.trim()
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
  const doc = packageManifestOf(text)
  if (doc === undefined) return undefined
  const { name, version, files, peerDependencies, keywords } = doc
  return {
    name,
    version,
    peers: trimmedStringEntriesOf(peerDependencies),
    plugin: Array.isArray(keywords) && keywords.includes('gwb-plugin'),
    files: Array.isArray(files) ? files.filter((one): one is string => typeof one === 'string') : [],
    doc,
  }
}

const MISSING_PUBLISH_TARGET = `没写 publishConfig.registry:发到哪个源由包自己写明,在 package.json 里加上 "publishConfig": { "registry": "<源的地址>" }(团队源是 "publishConfig": { "registry": "${TEAM_REGISTRY}" })`

/** 包发到哪个源：清单里 `publishConfig.registry` 写的那个。没写、或写的不是 http(s) 地址都拒，不猜 */
export function publishTargetOf(doc: Record<string, unknown>): { ok: true; registry: string } | { ok: false; error: string } {
  const publishConfig = doc['publishConfig']
  if (publishConfig === undefined) return { ok: false, error: MISSING_PUBLISH_TARGET }
  if (!isRecord(publishConfig)) return { ok: false, error: `publishConfig 要是对象，实得 ${JSON.stringify(publishConfig)}` }
  const registry = publishConfig['registry']
  if (registry === undefined) return { ok: false, error: MISSING_PUBLISH_TARGET }
  if (typeof registry !== 'string' || parseHttpUrl(registry) === undefined) {
    return { ok: false, error: `publishConfig.registry 要是 http(s) 地址，实得 ${JSON.stringify(registry)}` }
  }
  return { ok: true, registry }
}

/** 包清单是不是一个插件：keywords 含 `gwb-plugin` */
export function isPluginManifest(manifest: unknown): boolean {
  return isRecord(manifest) && Array.isArray(manifest['keywords']) && manifest['keywords'].includes(PLUGIN_KEYWORD)
}

/** peer 里要和源上 latest 比同一条线的那些：cordis、内核包、`workspace:` 以外，包目录 node_modules 里的清单是插件的，不分范围 */
function gwbPluginPeersOf(manifest: TicketManifest, peerManifestOf: (pkg: string) => unknown): Set<string> {
  const peers = new Set<string>()
  for (const [pkg, range] of Object.entries(manifest.peers)) {
    if (pkg === 'cordis' || pkg === KERNEL_PACKAGE || range.startsWith('workspace:')) continue
    if (isPluginManifest(peerManifestOf(pkg))) peers.add(pkg)
  }
  return peers
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

/** 建议写的范围：下限是验证时用的那个内核。发版前检查不知道是哪个，由写插件的人填 */
const SUGGESTED_KERNEL_RANGE = '^<验证时那个内核的版本号>'

/**
 * 不是插件包的不查。拒两类：peer 里没写内核包；写法不是 `^x.y.z`。范围包不包含哪个内核不查：
 * 对照调用这条命令的 home 里的内核，能不能发版就取决于从哪个 home 调
 */
export function kernelPeerProblems(manifest: TicketManifest): string[] {
  if (!manifest.plugin) return []
  const declared = manifest.peers[KERNEL_PACKAGE]
  if (declared === undefined) {
    return [
      `peer 里没写内核包 ${KERNEL_PACKAGE}:在隔离 home 里验过之后,在 package.json 的 peerDependencies 里写 "${KERNEL_PACKAGE}": "${SUGGESTED_KERNEL_RANGE}"`,
    ]
  }
  if (!isCaretRange(declared)) {
    return [`peer 里内核包 ${KERNEL_PACKAGE} 写的是 "${declared}",不是 ^x.y.z:peer 只许这一种写法,改成 "${SUGGESTED_KERNEL_RANGE}"`]
  }
  return []
}

/**
 * peer 里的 gwb 插件（`gwbPluginPeers`，不分范围；内核包不在里面，它只查写法）的范围要和源上 latest 在同一条线上：
 * 0.x 只看 x，≥1 只看主版本号。不在同一条线就是上游出了破坏版，先适配再升范围；`workspace:` 的不查。
 * `latest` 是各 peer 在源上的 `dist-tags.latest`（问不出的缺席）。不是插件包的不查：库的 peer 不进 home
 */
export function peerLineProblems(manifest: TicketManifest, latest: Record<string, string | undefined>, gwbPluginPeers: ReadonlySet<string>): string[] {
  if (!manifest.plugin) return []
  const problems: string[] = []
  for (const [pkg, range] of Object.entries(manifest.peers)) {
    if (!gwbPluginPeers.has(pkg) || pkg === KERNEL_PACKAGE || range.startsWith('workspace:')) continue
    if (!isCaretRange(range)) {
      problems.push(`peer ${pkg} 写的是 "${range}":peer 只许写 ^x.y.z`)
      continue
    }
    const latestOnRegistry = latest[pkg]
    if (latestOnRegistry === undefined) {
      problems.push(`peer ${pkg} 是 "${range}":问不出源上的 dist-tags.latest(源不通,或它还没发过正式版),查不了`)
    } else if (!sameReleaseLine(range.slice(1), latestOnRegistry)) {
      problems.push(`peer ${pkg} 是 "${range}",源上 latest ${latestOnRegistry}(不在同一条线:上游出了破坏版):先适配代码、在隔离 home 验过,再把 peer 改成 "^${latestOnRegistry}"`)
    }
  }
  return problems
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
        `peer 写了 ${pkg},它不是插件(keywords 里没有 gwb-plugin):peer 只写运行时从 home 里得到的东西——cordis、内核包 ${KERNEL_PACKAGE}、用到的别的插件。` +
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
  /** 发布目标：`publishTargetOf` 算出的源 */
  registry: string
  /** peer 里要和源上 latest 比同一条线的 gwb 插件 */
  gwbPluginPeers: Set<string>
  /** 读包目录 node_modules 里某个依赖的清单，读不到或不是 JSON 回 undefined */
  peerManifestOf(pkg: string): unknown
}

function peerManifestReader(pkgDir: string, deps: ReleaseDeps): (pkg: string) => unknown {
  return (pkg) => {
    const text = deps.readText(path.join(pkgDir, 'node_modules', ...pkg.split('/'), 'package.json'))
    if (text === undefined) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }
}

/**
 * 每个包：清单读得出、`publishConfig.registry` 认得出、`files` 白名单里的产物都在、这个版本号在它的发布目标上还没有；
 * `ranges` 是同一次发的包 → `^新版本号`
 */
async function planPackages(input: ReleaseInput, deps: ReleaseDeps): Promise<Refusal | { planned: PlannedPackage[]; ranges: Record<string, string> }> {
  const planned: PlannedPackage[] = []
  const ranges: Record<string, string> = {}
  for (const rel of input.packages) {
    const pkgDir = path.resolve(input.repoDir, rel)
    const manifest = ticketManifestOf(deps.readText(path.join(pkgDir, 'package.json')))
    if (manifest === undefined) {
      return { ok: false, error: `${pkgDir} 下没有能读的 package.json(或缺 name/version)——包目录给的是相对仓根的路径` }
    }
    const target = publishTargetOf(manifest.doc)
    if (!target.ok) return { ok: false, error: `${manifest.name} 的 package.json:${target.error},一个都没发` }
    // 产物在不在照 files 白名单问，不另列一份名单
    const missing = literalArtifacts(manifest.files).filter((one) => !deps.exists(path.join(pkgDir, one)))
    if (missing.length > 0) {
      return { ok: false, error: `${manifest.name} 的产物不全,没发:${missing.join('、')} 不在。仓根 pnpm build 刚跑过还缺,多半是 files 白名单里那一项根本没人生成` }
    }
    if (await deps.published(`${manifest.name}@${manifest.version}`, target.registry)) {
      return { ok: false, error: `${manifest.name}@${manifest.version} 已经在源 ${target.registry} 上了——同一个号永不重发,先抬 package.json 里的号再发` }
    }
    const peerManifestOf = peerManifestReader(pkgDir, deps)
    planned.push({ pkgDir, manifest, registry: target.registry, gwbPluginPeers: gwbPluginPeersOf(manifest, peerManifestOf), peerManifestOf })
    ranges[manifest.name] = `^${manifest.version}`
  }
  return { planned, ranges }
}

/** 各包 peer 里的 gwb 插件（不分范围）在源上的 latest；问哪个源由 `.npmrc` 按包名范围决定。dev 依赖不问 */
async function latestOfUpstreams(planned: PlannedPackage[], deps: ReleaseDeps): Promise<Record<string, string | undefined>> {
  const upstreams = new Set<string>()
  for (const { gwbPluginPeers } of planned) {
    for (const pkg of gwbPluginPeers) upstreams.add(pkg)
  }
  const latest: Record<string, string | undefined> = {}
  for (const pkg of upstreams) latest[pkg] = await deps.latest(pkg)
  return latest
}

async function ticketFor(repoDir: string, plannedPackage: PlannedPackage, latest: Record<string, string | undefined>, deps: ReleaseDeps): Promise<Ticket> {
  const { pkgDir, manifest, gwbPluginPeers, peerManifestOf } = plannedPackage
  const providers = manifest.plugin ? await deps.browserProviders?.(pkgDir, manifest.doc) : undefined
  const providerIo = providers === undefined || !providers.declared
    ? deps : { ...deps, browserImports: providers.imports }
  const problems = [
    ...(providers?.problems ?? []),
    ...peerLineProblems(manifest, latest, gwbPluginPeers),
    ...peerProblems(manifest, peerManifestOf),
    ...kernelPeerProblems(manifest),
    ...artifactProblems(pkgDir, manifest.doc, manifest.plugin, providerIo),
    ...(await styleProblems(pkgDir, manifest, deps)),
    ...(manifest.plugin ? wiringProblems({ pkgDir, repoDir, manifest: { ...manifest.doc, name: manifest.name } }, deps) : []),
  ]
  return { pkg: `${manifest.name}@${manifest.version}`, problems }
}

/** 按给的顺序发：被依赖的先发，不然装的时候源上还没有它 */
async function publishInOrder(planned: PlannedPackage[], ranges: Record<string, string>, deps: ReleaseDeps): Promise<Refusal & { data: { shipped: ReleasedPackage[] } } | ReleasedPackage[]> {
  const shipped: ReleasedPackage[] = []
  for (const plannedPackage of planned) {
    const sent = await deps.publish({ pkgDir: plannedPackage.pkgDir, version: plannedPackage.manifest.version, registry: plannedPackage.registry, ranges })
    if (!sent.ok) {
      return { ok: false, error: `${plannedPackage.manifest.name}@${plannedPackage.manifest.version} 发版没成:\n${sent.tail}`, data: { shipped } }
    }
    shipped.push({ pkg: plannedPackage.manifest.name, version: plannedPackage.manifest.version, dir: plannedPackage.pkgDir, registry: plannedPackage.registry })
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
  const tickets: Ticket[] = []
  for (const plannedPackage of plan.planned) tickets.push(await ticketFor(input.repoDir, plannedPackage, latest, deps))
  if (tickets.some((ticket) => ticket.problems.length > 0)) return { ok: false, error: ticketRefusal(tickets) }

  const shipped = await publishInOrder(plan.planned, plan.ranges, deps)
  if (!Array.isArray(shipped)) return shipped

  const shippedList = shipped.map((one) => `${one.pkg}@${one.version} → ${one.registry}`).join('、')
  return {
    ok: true,
    data: {
      repoDir: input.repoDir,
      shipped,
      note: `发好了 ${shippedList}(tag latest)。这条命令只发到源、没碰任何 home:升级 default 用 plugin-manager.update {"all":true}(由插件管理自己做,热重新加载时它不会被停掉)。发版前该在隔离 home 里验过的,验完再升级`,
    },
  }
}
