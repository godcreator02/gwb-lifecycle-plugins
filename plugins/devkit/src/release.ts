import path from 'node:path'
import { BUILD_TIMEOUT_MS, PLUGIN_KEYWORD, literalArtifacts, pnpmPlan, type RunPlan, type RunResult } from './dev.js'
import { KERNEL_PACKAGE, isCaretRange } from '@godcreator/gwb-plugin-manager'
import { artifactProblems } from './artifact-check.js'
import type { BrowserProviders } from './browser-providers.js'
import { styleProblems, type StyleCheckIo } from './style-check.js'
import { wiringProblems, type WiringCheckIo } from './wiring-check.js'
import { isCordisPluginManifest, isRecord, NPMJS_REGISTRY, packageManifestOf, parseHttpUrl } from './vocab.js'

/** git 工作区的状态。`dirty` 里是 porcelain 条目原文（两列状态加路径） */
export type GitStatus = { ok: true; dirty: string[] } | { ok: false; error: string }

/** 仓里发 npmjs 的工作流，相对仓根。npmjs 上每个包登记的 trusted publisher 写的就是这个文件名 */
export const PUBLISH_WORKFLOW = '.github/workflows/publish.yml'
/** 等 publish.yml 跑完的上限：它只下载包文件再逐个 npm publish，通常一分钟内跑完 */
export const PUBLISH_RUN_TIMEOUT_MS = 180_000
/** 推到 origin 的 tag 经 gitea 的推送镜像出现在 GitHub 上的上限：镜像开了「推送时同步」，通常几秒到半分钟 */
export const MIRROR_SYNC_TIMEOUT_MS = 180_000
const MIRROR_POLL_MS = 5_000

export interface GithubRepo {
  owner: string
  repo: string
}

/** 交给 Actions 发 npmjs 那一步用到的 GitHub 操作。凭据由实现自己取；连不上、没权限直接抛，信息里写明是哪个请求 */
export interface GithubReleaseGateway {
  /** 这个提交在 GitHub 上的仓里有没有 */
  hasCommit(repo: GithubRepo, sha: string): Promise<boolean>
  /** 在 tag `tag` 上建 release（tag 已经从 origin 同步到 GitHub）：先建草稿、传上包文件，再公开——公开那一刻触发 publish.yml。回 release 的网页地址 */
  createRelease(input: { repo: GithubRepo; tag: string; sha: string; title: string; body: string; assets: { name: string; file: string }[] }): Promise<{ url: string }>
  /** 等 `sha` 上由 release 触发、`since` 之后建的 publish.yml 运行跑完；`timeoutMs` 内没跑完回 `finished: false` */
  waitPublishRun(input: { repo: GithubRepo; sha: string; since: number; timeoutMs: number }): Promise<{ finished: true; success: boolean; url: string } | { finished: false; url?: string }>
}

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
  /** 照 `publish` 组装发布内容，但不发，打成包文件放进 `destination`，回包文件的绝对路径 */
  packRelease(input: { pkgDir: string; version: string; registry: string; ranges: Record<string, string>; destination: string }): Promise<{ ok: true; file: string } | { ok: false; tail: string }>
  /** 仓根 HEAD 的提交号 */
  headCommit(repoDir: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }>
  /** 先 fetch origin，再看这个提交在不在 origin 的某个分支上 */
  onOrigin(repoDir: string, sha: string): Promise<{ ok: true; pushed: boolean } | { ok: false; error: string }>
  /** 在 `sha` 上建 tag `tag` 并推到 origin */
  pushTag(repoDir: string, tag: string, sha: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** 本机装这个包时从哪个源下：`.npmrc` 给包名范围配的源。没配（走默认源）、包名不带范围都回 undefined；问不出就抛 */
  installRegistry(pkg: string): Promise<string | undefined>
  github: GithubReleaseGateway
  sleep(ms: number): Promise<void>
  /** 新建一个空的临时目录，用完交给 `removeDir` */
  tempDir(): string
  removeDir(dir: string): void
  now(): number
  /** 这个版本号在 `registry` 这个源上有没有。问不出来（源连不上、超时）就抛 */
  published(spec: string, registry: string): Promise<boolean>
  /** 源上这个包的 `dist-tags.latest`，问哪个源由 `.npmrc` 按包名范围决定。问不出、没发过正式版都回 undefined */
  latest(pkg: string): Promise<string | undefined>
  /** 仓根的 git 工作区干不干净。问不出（不是 git 仓、没装 git）也是一种答案：拒 */
  gitStatus(repoDir: string): Promise<GitStatus>
  readText(file: string): string | undefined
  realpath: PeerGraphIo['realpath']
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
  /** 发到的源。一个包发到几个源就有几条 */
  registry: string
}

export interface ReleaseReport {
  repoDir: string
  shipped: ReleasedPackage[]
  /** 有包发到 npmjs 时才有：挂包文件的 release 与发布它们的那次 Actions 运行 */
  actions?: { release: string; run: string }
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

const MISSING_PUBLISH_TARGET = `没写 publishConfig.registry:发到哪个源由包自己写明,在 package.json 里加上 "publishConfig": { "registry": "<源的地址>" }(发到 npmjs 是 "publishConfig": { "registry": "${NPMJS_REGISTRY}", "access": "public" })`

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

/** 包清单 `repository` 指向的 GitHub 仓。发到 npmjs 的包由那个仓的 `PUBLISH_WORKFLOW` 发，没写或写的不是 GitHub 地址都拒 */
export function githubRepoOf(doc: Record<string, unknown>): { ok: true; repo: GithubRepo } | { ok: false; error: string } {
  const repository = doc['repository']
  const url = typeof repository === 'string' ? repository : isRecord(repository) && typeof repository['url'] === 'string' ? repository['url'] : undefined
  const match = url === undefined ? null : /^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url)
  if (match === null) {
    return {
      ok: false,
      error: `repository 要写 GitHub 上的仓("repository": { "type": "git", "url": "https://github.com/<owner>/<仓名>.git" }):发到 npmjs 的包由那个仓的 ${PUBLISH_WORKFLOW} 发,实得 ${JSON.stringify(repository)}`,
    }
  }
  return { ok: true, repo: { owner: match[1]!, repo: match[2]! } }
}

/** 这个发布目标是不是 npmjs：只认主机名，结尾的 `/` 写没写都算 */
export function isNpmjsRegistry(registry: string): boolean {
  return parseHttpUrl(registry)?.host === 'registry.npmjs.org'
}

/** 挂包文件的 release 的 tag：`release-<UTC 年月日>-<时分秒>` */
export function releaseTagOf(ms: number): string {
  const stamp = new Date(ms).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '')
  return `release-${stamp.replace('T', '-')}`
}

/** 两个源地址是不是同一个：结尾的 `/` 写没写都算 */
export function sameRegistry(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}

/**
 * 一个包按顺序发到哪些源：本机装它用的源（`installRegistry`）在前，包自己的 `publishConfig.registry` 在后。
 * 本机装包的源与发布目标相同、或是 npmjs、或没配，就只发发布目标——公开包在团队源上也有一份，本机才装得到
 */
export function registriesFor(target: string, installRegistry: string | undefined): string[] {
  if (installRegistry === undefined || isNpmjsRegistry(installRegistry) || sameRegistry(installRegistry, target)) return [target]
  return [installRegistry, target]
}

/** 包清单是不是一个插件：keywords 含 `gwb-plugin` */
export function isPluginManifest(manifest: unknown): boolean {
  return isRecord(manifest) && Array.isArray(manifest['keywords']) && manifest['keywords'].includes(PLUGIN_KEYWORD)
}

/** peer 里能写的插件：gwb 插件与第三方 cordis 插件，运行时都从 home 里得到 */
function isHomePluginManifest(manifest: unknown): boolean {
  return isPluginManifest(manifest) || isCordisPluginManifest(manifest)
}

/** peer 里要和源上 latest 比同一条线的那些：cordis、内核包、`workspace:` 以外，包目录 node_modules 里的清单是插件的，不分范围 */
function pluginPeersOf(manifest: TicketManifest, peerManifestOf: (pkg: string) => unknown): Set<string> {
  const peers = new Set<string>()
  for (const [pkg, range] of Object.entries(manifest.peers)) {
    if (pkg === 'cordis' || pkg === KERNEL_PACKAGE || range.startsWith('workspace:')) continue
    if (isHomePluginManifest(peerManifestOf(pkg))) peers.add(pkg)
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
 * peer 里的插件（`pluginPeers`：gwb 插件与第三方 cordis 插件，不分范围；内核包不在里面，它只查写法）的范围要和源上 latest 在同一条线上：
 * 0.x 只看 x，≥1 只看主版本号。不在同一条线就是上游出了破坏版，先适配再升范围；`workspace:` 的不查。
 * `latest` 是各 peer 在源上的 `dist-tags.latest`（问不出的缺席）。不是插件包的不查：库的 peer 不进 home
 */
export function peerLineProblems(manifest: TicketManifest, latest: Record<string, string | undefined>, pluginPeers: ReadonlySet<string>): string[] {
  if (!manifest.plugin) return []
  const problems: string[] = []
  for (const [pkg, range] of Object.entries(manifest.peers)) {
    if (!pluginPeers.has(pkg) || pkg === KERNEL_PACKAGE || range.startsWith('workspace:')) continue
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
 * `kernelPeerProblems` 查）、用到的插件（`peerManifestOf` 读包目录 node_modules 里它的清单，`isHomePluginManifest` 判：
 * gwb 插件或第三方 cordis 插件）；别的一律拒。node 侧产物只能 import peer 里的包，由产物检查查
 */
export function peerProblems(manifest: TicketManifest, peerManifestOf: (pkg: string) => unknown): string[] {
  if (!manifest.plugin) return []
  const problems: string[] = []
  for (const pkg of Object.keys(manifest.peers).filter((one) => one !== 'cordis' && one !== KERNEL_PACKAGE)) {
    const peerManifest = peerManifestOf(pkg)
    if (peerManifest === undefined) {
      problems.push(`peer 写了 ${pkg},包目录的 node_modules 里读不到它的清单:先在仓根 pnpm install,不猜它是不是插件`)
    } else if (!isHomePluginManifest(peerManifest)) {
      problems.push(
        `peer 写了 ${pkg},它不是插件(keywords 里没有 gwb-plugin,也没有同时写 cordis 与 plugin):peer 只写运行时从 home 里得到的东西——cordis、内核包 ${KERNEL_PACKAGE}、用到的插件(gwb 插件或第三方 cordis 插件)。` +
          `库、接口定义包、importmap 里的包、构建时才用的包写 devDependencies、打包进产物;` +
          `打包不进产物的自用库(原生可执行文件、运行时按路径读自己文件的包)写 dependencies,并在清单里写明原因`,
      )
    }
  }
  return problems
}

function isOptionalPeer(doc: Record<string, unknown>, pkg: string): boolean {
  const meta = doc['peerDependenciesMeta']
  if (!isRecord(meta)) return false
  const entry = meta[pkg]
  return isRecord(entry) && entry['optional'] === true
}

/**
 * 发到 npmjs 的包，必需的 peer（`cordis` 与标了 optional 的不算）也要在 npmjs 上：从 npmjs 装它的人只装得到 npmjs 上的包。
 * 同一次也发 npmjs 的包不查；`workspace:` 的按包目录 node_modules 里装着的版本写成 `^<版本>` 去问
 */
async function publicPeerProblems(plannedPackage: PlannedPackage, npmjsSiblings: ReadonlySet<string>, deps: ReleaseDeps): Promise<string[]> {
  const { manifest, peerManifestOf } = plannedPackage
  const problems: string[] = []
  for (const [pkg, range] of Object.entries(manifest.peers)) {
    if (pkg === 'cordis' || npmjsSiblings.has(pkg) || isOptionalPeer(manifest.doc, pkg)) continue
    let wanted = range
    if (range.startsWith('workspace:')) {
      const installed = peerManifestOf(pkg)
      if (!isRecord(installed) || typeof installed['version'] !== 'string') {
        problems.push(`peer ${pkg} 写的是 "${range}",包目录的 node_modules 里读不到它的版本:先在仓根 pnpm install`)
        continue
      }
      wanted = `^${installed['version']}`
    }
    if (!(await deps.published(`${pkg}@${wanted}`, NPMJS_REGISTRY))) {
      problems.push(
        `peer ${pkg}(${wanted})在 npmjs 上没有:这个包发到 npmjs,从 npmjs 装它的人装不到这个 peer。把 ${pkg} 也公开发到 npmjs;它不是运行的前提的话,在 peerDependenciesMeta 里标 optional`,
      )
    }
  }
  return problems
}

/** 同一次发的包：peer 图里按工作区里的清单算，它们 peer 里写的是 `workspace:*`，装上的未必是这一版 */
export interface ReleaseSibling {
  pkgDir: string
  peers: string[]
  plugin: boolean
}

/** 找 peer 图上的包要读的文件系统 */
export interface PeerGraphIo {
  readText(file: string): string | undefined
  /** 目录链接指向的真实目录：pnpm 把一个包 peer 里的包放在它真实目录的旁边 */
  realpath(target: string): string
}

/** peer 图上的一个包：它 peer 里的包名、是不是 gwb 插件、找它 peer 里的包时从哪个目录往上找 */
interface PeerGraphNode {
  peers: string[]
  plugin: boolean
  resolveFrom: string
}

/** 照 node 的解析规则从 `fromDir` 往上找 `node_modules/<包名>`：找到了回它的真实目录与清单，一直找到根都没有是 undefined */
function installedPeerNode(fromDir: string, pkg: string, io: PeerGraphIo): PeerGraphNode | undefined {
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...pkg.split('/'))
    const text = io.readText(path.join(candidate, 'package.json'))
    if (text !== undefined) {
      const manifest = packageManifestOf(text)
      return { peers: manifest === undefined ? [] : Object.keys(trimmedStringEntriesOf(manifest.peerDependencies)), plugin: isPluginManifest(manifest), resolveFrom: io.realpath(candidate) }
    }
    if (path.dirname(dir) === dir) return undefined
  }
}

/**
 * 插件包顺着 peer 里的 gwb 插件（keywords 含 gwb-plugin；cordis 与内核包不算）的已装清单一路往下走，走回本包就是环。
 * 同一次发的包（`siblings`）按工作区里的清单算。每个直接 peer 各报一条最短的环；读不到清单的包不往下走（第一层读不到由 `peerProblems` 报）。
 * 只认 peer：局部注入不写 peer，不算边
 */
export function peerCycleProblems(manifest: TicketManifest, pkgDir: string, siblings: ReadonlyMap<string, ReleaseSibling>, io: PeerGraphIo): string[] {
  if (!manifest.plugin) return []
  const nodes = new Map<string, PeerGraphNode | undefined>([[manifest.name, { peers: Object.keys(manifest.peers), plugin: true, resolveFrom: pkgDir }]])
  const nodeOf = (pkg: string, reachedFrom: PeerGraphNode): PeerGraphNode | undefined => {
    if (!nodes.has(pkg)) {
      const sibling = siblings.get(pkg)
      nodes.set(pkg, sibling === undefined ? installedPeerNode(reachedFrom.resolveFrom, pkg, io) : { peers: sibling.peers, plugin: sibling.plugin, resolveFrom: sibling.pkgDir })
    }
    return nodes.get(pkg)
  }
  const pluginPeersOfNode = (node: PeerGraphNode): string[] =>
    node.peers
      .filter((pkg) => pkg !== 'cordis' && pkg !== KERNEL_PACKAGE && nodeOf(pkg, node)?.plugin === true)
      .sort((a, b) => a.localeCompare(b))

  const problems: string[] = []
  for (const directPeer of pluginPeersOfNode(nodes.get(manifest.name)!)) {
    const cycle = shortestPathBack(manifest.name, directPeer, (pkg) => pluginPeersOfNode(nodes.get(pkg)!))
    if (cycle === undefined) continue
    problems.push(
      `peer 成环:${cycle.join(' → ')}(顺着 peer 里的 gwb 插件的已装清单走回了本包;同一次发的包按工作区里的清单)。` +
        '插件管理升级时按 peer 排重新加载的先后,环上的包排不出先后,只能重启工作台才换上新版本。' +
        '去掉环上的一条 peer:反方向改用局部注入 <上下文>.inject([...], fn)、不写 peer,提供方是同一个工作区里 peer 写了本包的插件时,发版前检查对这种写法放行',
    )
  }
  return problems
}

/** 广度优先：从 `start` 的直接 peer `first` 出发走回 `start` 的最短路径，连同首尾的 `start`；走不回来是 undefined */
function shortestPathBack(start: string, first: string, peersOf: (pkg: string) => string[]): string[] | undefined {
  const cameFrom = new Map<string, string>([[first, start]])
  const queue = [first]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === start) break
    for (const next of peersOf(current)) {
      if (cameFrom.has(next)) continue
      cameFrom.set(next, current)
      queue.push(next)
    }
  }
  if (!cameFrom.has(start)) return undefined
  const route = [start]
  for (let step = cameFrom.get(start)!; step !== start; step = cameFrom.get(step)!) route.unshift(step)
  return [start, ...route]
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
  /** 按发布顺序的发布目标，见 `registriesFor` */
  registries: string[]
  /** peer 里要和源上 latest 比同一条线的 gwb 插件 */
  pluginPeers: Set<string>
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
 * 每个包：清单读得出、`publishConfig.registry` 认得出、`files` 白名单里的产物都在、这个版本号在 `publishConfig.registry` 上还没有
 * （本机装包的源上已经有的，这次不再发到那里）；
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
    let installRegistry: string | undefined
    try {
      installRegistry = await deps.installRegistry(manifest.name)
    } catch (err) {
      return { ok: false, error: `问不出本机从哪个源装 ${manifest.name}:${err instanceof Error ? err.message : String(err)},一个都没发` }
    }
    const registries: string[] = []
    for (const registry of registriesFor(target.registry, installRegistry)) {
      if (!(await deps.published(`${manifest.name}@${manifest.version}`, registry))) {
        registries.push(registry)
        continue
      }
      if (sameRegistry(registry, target.registry)) {
        return { ok: false, error: `${manifest.name}@${manifest.version} 已经在源 ${registry} 上了——同一个号永不重发,先抬 package.json 里的号再发` }
      }
      // 只在本机装包的源上有：上一次发到了这里、交给 Actions 那步没成，这一次只补发布目标
    }
    const peerManifestOf = peerManifestReader(pkgDir, deps)
    planned.push({ pkgDir, manifest, registries, pluginPeers: pluginPeersOf(manifest, peerManifestOf), peerManifestOf })
    ranges[manifest.name] = `^${manifest.version}`
  }
  return { planned, ranges }
}

/** 各包 peer 里的插件（gwb 插件与第三方 cordis 插件，不分范围）在源上的 latest；问哪个源由 `.npmrc` 按包名范围决定。dev 依赖不问 */
async function latestOfUpstreams(planned: PlannedPackage[], deps: ReleaseDeps): Promise<Record<string, string | undefined>> {
  const upstreams = new Set<string>()
  for (const { pluginPeers } of planned) {
    for (const pkg of pluginPeers) upstreams.add(pkg)
  }
  const latest: Record<string, string | undefined> = {}
  for (const pkg of upstreams) latest[pkg] = await deps.latest(pkg)
  return latest
}

async function ticketFor(
  repoDir: string,
  plannedPackage: PlannedPackage,
  siblings: ReadonlyMap<string, ReleaseSibling>,
  latest: Record<string, string | undefined>,
  deps: ReleaseDeps,
): Promise<Ticket> {
  const { pkgDir, manifest, pluginPeers, peerManifestOf } = plannedPackage
  const providers = manifest.plugin ? await deps.browserProviders?.(pkgDir, manifest.doc) : undefined
  const providerIo = providers === undefined || !providers.declared
    ? deps : { ...deps, browserImports: providers.imports }
  const problems = [
    ...(providers?.problems ?? []),
    ...peerLineProblems(manifest, latest, pluginPeers),
    ...peerProblems(manifest, peerManifestOf),
    ...peerCycleProblems(manifest, pkgDir, siblings, deps),
    ...kernelPeerProblems(manifest),
    ...artifactProblems(pkgDir, manifest.doc, manifest.plugin, providerIo),
    ...(await styleProblems(pkgDir, manifest, deps)),
    ...(manifest.plugin ? wiringProblems({ pkgDir, repoDir, manifest: { ...manifest.doc, name: manifest.name } }, deps) : []),
  ]
  return { pkg: `${manifest.name}@${manifest.version}`, problems }
}

/** 交给 Actions 发 npmjs 的那一批：都指向同一个 GitHub 仓，HEAD 已经推到 origin */
interface ActionsHandoff {
  repoDir: string
  repo: GithubRepo
  sha: string
  packages: PlannedPackage[]
}

/** 发任何一个包之前查：仓里有 publish.yml、包都指向同一个 GitHub 仓、HEAD 已推到 origin。没有包发 npmjs 回 undefined */
async function actionsHandoffOf(repoDir: string, planned: PlannedPackage[], deps: ReleaseDeps): Promise<Refusal | ActionsHandoff | undefined> {
  const viaActions = planned.filter((one) => one.registries.some(isNpmjsRegistry))
  if (viaActions.length === 0) return undefined
  if (!deps.exists(path.join(repoDir, PUBLISH_WORKFLOW))) {
    return {
      ok: false,
      error: `发到 npmjs 的包由仓里的 ${PUBLISH_WORKFLOW} 经 GitHub Actions 发,${repoDir} 里没有这个文件,一个都没发:从 devkit 包的 template/repo/${PUBLISH_WORKFLOW}.tpl 复制一份(去掉 .tpl)、提交并推送;npmjs 上每个包还要登记 trusted publisher(工作流文件名 publish.yml),做法见说明书 gwb-devkit「发版」`,
    }
  }
  let repo: GithubRepo | undefined
  for (const one of viaActions) {
    const found = githubRepoOf(one.manifest.doc)
    if (!found.ok) return { ok: false, error: `${one.manifest.name} 的 package.json:${found.error},一个都没发` }
    if (repo !== undefined && (repo.owner !== found.repo.owner || repo.repo !== found.repo.repo)) {
      return { ok: false, error: `同一次发到 npmjs 的包要指向同一个 GitHub 仓:${one.manifest.name} 写的是 ${found.repo.owner}/${found.repo.repo},前面的包是 ${repo.owner}/${repo.repo},一个都没发` }
    }
    repo = found.repo
  }
  const head = await deps.headCommit(repoDir)
  if (!head.ok) return { ok: false, error: `问不出 ${repoDir} 的 HEAD:${head.error},一个都没发` }
  const pushed = await deps.onOrigin(repoDir, head.sha)
  if (!pushed.ok) return { ok: false, error: `问不出 HEAD 在不在 origin 上:${pushed.error},一个都没发` }
  if (!pushed.pushed) {
    return { ok: false, error: `HEAD ${head.sha.slice(0, 7)} 还没推到 origin:npmjs 那份由 GitHub 上的 Actions 照这个提交发,提交要先经 origin(gitea 的推送镜像)到 GitHub。先 git push 再来,一个都没发` }
  }
  return { repoDir, repo: repo!, sha: head.sha, packages: viaActions }
}

/** tag 推到 origin 之后，等推送镜像把这个提交同步到 GitHub。origin 就是 GitHub 的仓不用等 */
async function waitForMirror(handoff: ActionsHandoff, deps: ReleaseDeps): Promise<Refusal | undefined> {
  const deadline = deps.now() + MIRROR_SYNC_TIMEOUT_MS
  while (!(await deps.github.hasCommit(handoff.repo, handoff.sha))) {
    if (deps.now() >= deadline) {
      return {
        ok: false,
        error: `${String(MIRROR_SYNC_TIMEOUT_MS / 60_000)} 分钟内 GitHub 的 ${handoff.repo.owner}/${handoff.repo.repo} 上还没有提交 ${handoff.sha.slice(0, 7)}:origin 没开到 GitHub 的推送镜像,或镜像同步失败。到 gitea 仓的「设置 → 仓库 → 推送镜像」看最近一次同步的结果(开镜像用 gitea.push-mirror.add)。修好后再调一次 devkit.release:本机装包的源上已经有的版本不重发,只补 GitHub 与 npmjs 这几步`,
      }
    }
    await deps.sleep(MIRROR_POLL_MS)
  }
  return undefined
}

/** 按发布顺序打包、挂到 release 上，等 publish.yml 跑完。包文件名带两位序号，工作流按文件名排序依次发 */
async function handOffToActions(handoff: ActionsHandoff, ranges: Record<string, string>, deps: ReleaseDeps): Promise<{ ok: true; release: string; run: string } | Refusal> {
  const destination = deps.tempDir()
  try {
    const assets: { name: string; file: string }[] = []
    for (const [index, one] of handoff.packages.entries()) {
      const packed = await deps.packRelease({ pkgDir: one.pkgDir, version: one.manifest.version, registry: NPMJS_REGISTRY, ranges, destination })
      if (!packed.ok) return { ok: false, error: `${one.manifest.name}@${one.manifest.version} 打包没成:\n${packed.tail}` }
      assets.push({ name: `${String(index + 1).padStart(2, '0')}-${path.basename(packed.file)}`, file: packed.file })
    }
    const specs = handoff.packages.map((one) => `${one.manifest.name}@${one.manifest.version}`)
    const since = deps.now()
    const tag = releaseTagOf(since)
    // tag 先推到 origin：只在 GitHub 上建的 tag，下一次推送镜像同步时会被删掉，release 就挂空了
    const tagged = await deps.pushTag(handoff.repoDir, tag, handoff.sha)
    if (!tagged.ok) return { ok: false, error: `tag ${tag} 推到 origin 没成:${tagged.error}` }
    const mirrored = await waitForMirror(handoff, deps)
    if (mirrored !== undefined) return mirrored
    const release = await deps.github.createRelease({
      repo: handoff.repo,
      tag,
      sha: handoff.sha,
      title: specs.join('、'),
      body: `由 devkit.release 组装，${PUBLISH_WORKFLOW} 按序号依次发到 npmjs：\n\n${specs.map((one) => `- ${one}`).join('\n')}`,
      assets,
    })
    const run = await deps.github.waitPublishRun({ repo: handoff.repo, sha: handoff.sha, since, timeoutMs: PUBLISH_RUN_TIMEOUT_MS })
    if (!run.finished) {
      return {
        ok: false,
        error: `npmjs 那份交给了 Actions(release ${release.url}),${String(PUBLISH_RUN_TIMEOUT_MS / 60_000)} 分钟内没跑完:到 ${run.url ?? release.url} 看结果。跑成功了就是发完了;失败了修好后在网页上重跑,工作流会跳过已经在 npmjs 上的包`,
      }
    }
    if (!run.success) return { ok: false, error: `Actions 发 npmjs 没成:${run.url}。看日志修好后在网页上重跑,工作流会跳过已经在 npmjs 上的包;同一个号别改了内容再发` }
    return { ok: true, release: release.url, run: run.url }
  } finally {
    deps.removeDir(destination)
  }
}

/** 按给的顺序发：被依赖的先发，不然装的时候源上还没有它。一个包的各个发布目标都发完，再发下一个包。npmjs 不在这里发，交给 `handOffToActions` */
async function publishInOrder(planned: PlannedPackage[], ranges: Record<string, string>, deps: ReleaseDeps): Promise<Refusal & { data: { shipped: ReleasedPackage[] } } | ReleasedPackage[]> {
  const shipped: ReleasedPackage[] = []
  for (const plannedPackage of planned) {
    for (const registry of plannedPackage.registries.filter((one) => !isNpmjsRegistry(one))) {
      const sent = await deps.publish({ pkgDir: plannedPackage.pkgDir, version: plannedPackage.manifest.version, registry, ranges })
      if (!sent.ok) {
        return { ok: false, error: `${plannedPackage.manifest.name}@${plannedPackage.manifest.version} 发到 ${registry} 没成:\n${sent.tail}`, data: { shipped } }
      }
      shipped.push({ pkg: plannedPackage.manifest.name, version: plannedPackage.manifest.version, dir: plannedPackage.pkgDir, registry })
    }
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
  const siblings = new Map(plan.planned.map((planned) => [planned.manifest.name, { pkgDir: planned.pkgDir, peers: Object.keys(planned.manifest.peers), plugin: planned.manifest.plugin }]))
  const toNpmjs = new Set(plan.planned.filter((planned) => planned.registries.some(isNpmjsRegistry)).map((planned) => planned.manifest.name))
  const tickets: Ticket[] = []
  for (const plannedPackage of plan.planned) {
    const ticket = await ticketFor(input.repoDir, plannedPackage, siblings, latest, deps)
    if (toNpmjs.has(plannedPackage.manifest.name)) ticket.problems.push(...(await publicPeerProblems(plannedPackage, toNpmjs, deps)))
    tickets.push(ticket)
  }
  if (tickets.some((ticket) => ticket.problems.length > 0)) return { ok: false, error: ticketRefusal(tickets) }

  let handoff: Awaited<ReturnType<typeof actionsHandoffOf>>
  try {
    handoff = await actionsHandoffOf(input.repoDir, plan.planned, deps)
  } catch (err) {
    return { ok: false, error: `查 GitHub 上的仓时出错,一个都没发:${err instanceof Error ? err.message : String(err)}` }
  }
  if (handoff !== undefined && 'ok' in handoff) return handoff

  const shipped = await publishInOrder(plan.planned, plan.ranges, deps)
  if (!Array.isArray(shipped)) return shipped

  let actions: { release: string; run: string } | undefined
  if (handoff !== undefined) {
    let handedOff: Awaited<ReturnType<typeof handOffToActions>>
    try {
      handedOff = await handOffToActions(handoff, plan.ranges, deps)
    } catch (err) {
      handedOff = { ok: false, error: `交给 GitHub Actions 发 npmjs 时出错:${err instanceof Error ? err.message : String(err)}` }
    }
    if (!handedOff.ok) {
      const done = shipped.length === 0 ? '' : `本机发的已经发完:${shipped.map((one) => `${one.pkg}@${one.version} → ${one.registry}`).join('、')}。`
      return { ok: false, error: `${done}${handedOff.error}`, data: { shipped } }
    }
    actions = { release: handedOff.release, run: handedOff.run }
    for (const one of handoff.packages) shipped.push({ pkg: one.manifest.name, version: one.manifest.version, dir: one.pkgDir, registry: NPMJS_REGISTRY })
  }

  const shippedList = shipped.map((one) => `${one.pkg}@${one.version} → ${one.registry}`).join('、')
  const npmjsLag = actions === undefined ? '' : `npmjs 那份由 Actions 发(${actions.run}),新版本要过几分钟才查得到;`
  return {
    ok: true,
    data: {
      repoDir: input.repoDir,
      shipped,
      ...(actions === undefined ? {} : { actions }),
      note: `发好了 ${shippedList}(tag latest)。${npmjsLag}这条命令只发到源、没碰任何 home:升级 default 用 plugin-manager.update {"all":true}(由插件管理自己做,热重新加载时它不会被停掉)。发版前该在隔离 home 里验过的,验完再升级`,
    },
  }
}
