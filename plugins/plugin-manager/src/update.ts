import { bareId, installSpec } from './ids.js'
import { readEntries } from './inventory.js'
import { isExactVersion, KERNEL_PACKAGE } from './kernel-compat.js'
import { CORDIS_PACKAGE, installedVersionMismatch, KERNEL_MANAGED_PACKAGES, versionChangeOf } from './kernel-upgrade.js'
import type { EntrySnapshot, OutdatedMap, VersionChange } from './receipts.js'
import { isRecord } from './vocab.js'

/** `plugin-manager.update` 的参数：三种恰好给一种 */
export type UpdateArgs = { all: true } | { only: string[] } | { specs: Record<string, string> }

/** 一条要重新加载的条目 */
export interface PlannedEntry {
  /** 不带前缀的 id——`tree.update` 认的那一个 */
  id: string
  /** 本来就停用的：保持停用，不动它（记 skipped） */
  disabled: boolean
  /** 这条就是本插件自己的条目：执行时只记 deferred，回执发出之后才重新加载 */
  self: boolean
}

/** 一个包与它在条目树上的全部条目（分组条目不算），条目按树里的先后；真实目录没变的包 entries 为空 */
export interface PackageEntries {
  pkg: string
  entries: PlannedEntry[]
}

/**
 * `pnpm add` 之后要重新加载的包：真实目录变了的包都在内。点了名的（升级或按 specs 装的）归 `updated`，目录没变的也列出、entries 为空；
 * 没点名、目录变了的归 `dependents`（多半是 peer 写了被升级包的插件：pnpm 虚拟存储的目录名带着 peer 的版本）。两份都按包名排
 */
export interface RemountTargets {
  updated: PackageEntries[]
  dependents: PackageEntries[]
}

export interface OutdatedUpdatePlan {
  /** `pnpm add` 的每一项 `<包名>@<版本号>`，按包名排：精确版本（outdated 查到的 latest，不是 `@latest` 标签）；清单为空时是空数组 */
  addSpecs: string[]
  /** 要升级的包 → 回执里的 from / to，按包名排 */
  versionChanges: Map<string, VersionChange>
  /** `only` 里点了名、在 home 里但不在过期清单里的包（已是最新）——回执里说明，免得人以为它升级了 */
  alreadyLatest: string[]
}

export interface SpecsUpdatePlan {
  /** `pnpm add` 的每一项 `<包名>@<写法>`，按包名排 */
  addSpecs: string[]
  /** 要装的包，按包名排 */
  pkgs: string[]
  /** 有内核包：主进程里的内核换不掉，这次不重新加载任何条目；装完再照内核包 peer 对齐 cordis */
  includesKernel: boolean
}

/** 包名 → `node_modules/<包名>` 指向的真实目录；读不到（没装）的是 undefined */
export type InstalledDirectories = ReadonlyMap<string, string | undefined>

/** 包名 → `node_modules/<包名>/package.json` 里的 version；读不到的是 undefined */
export type InstalledVersions = ReadonlyMap<string, string | undefined>

export type VersionChangesAfterAdd = { ok: true; changes: ReadonlyMap<string, VersionChange> } | { ok: false; error: string }

function pluginEntriesOf(store: unknown): EntrySnapshot[] {
  return readEntries(store).filter((entry) => !entry.group)
}

function plannedEntriesOf(pkg: string, entries: readonly EntrySnapshot[], ownBareId: string): PlannedEntry[] {
  return entries
    .filter((entry) => entry.pkg === pkg)
    .map<PlannedEntry>((entry) => ({ id: entry.id, disabled: entry.disabled, self: entry.id === ownBareId }))
}

/** `only` 里不在 home 的 dependencies 里的包名多半是拼错了：直接抛错，说出是哪几个 */
export function assertOnlyPackagesInHome(only: readonly string[], homeDependencies: Readonly<Record<string, string>>): void {
  const notInHome = only.filter((pkg) => homeDependencies[pkg] === undefined)
  if (notInHome.length > 0) {
    throw new Error(`only 里的 ${notInHome.join('、')} 不在 home 的 package.json 的 dependencies 里（拼错了？）。装了哪些包调用 plugin-manager.list 看`)
  }
}

/** 内核包与 cordis 热升级不了：`only` 点了它们的名直接抛错，指向 specs 写法 */
export function assertOnlyNotKernelManaged(only: readonly string[]): void {
  const kernelManaged = only.filter((pkg) => KERNEL_MANAGED_PACKAGES.has(pkg))
  if (kernelManaged.length > 0) {
    throw new Error(
      `only 里的 ${kernelManaged.join('、')} 由内核决定版本，热升级不了：内核包用 plugin-manager.update {"specs":{"${KERNEL_PACKAGE}":"<版本号、latest 或 file:路径>"}} 换，cordis 由插件管理照装上的内核包对齐`,
    )
  }
}

/** `outdated` 已经不含内核包与 cordis；`only` 给了就只升级点名的那几个 */
export function planOutdatedUpdate(outdated: Readonly<OutdatedMap>, only?: readonly string[]): OutdatedUpdatePlan {
  const onlyThesePackages = only === undefined ? undefined : new Set(only)
  const alreadyLatest = only === undefined ? [] : only.filter((pkg) => outdated[pkg] === undefined)

  const versionChanges = new Map<string, VersionChange>()
  for (const pkg of Object.keys(outdated).sort((a, b) => a.localeCompare(b))) {
    if (onlyThesePackages !== undefined && !onlyThesePackages.has(pkg)) continue
    const versionGap = outdated[pkg]
    if (versionGap === undefined) continue
    versionChanges.set(pkg, { from: versionGap.current, to: versionGap.latest })
  }

  return {
    addSpecs: [...versionChanges].map(([pkg, change]) => installSpec(pkg, change.to)),
    versionChanges,
    alreadyLatest,
  }
}

/**
 * 包名或写法不合规、包不在 home 的 dependencies 里、写了 cordis，都直接抛错。
 * 写法原样交给 pnpm（版本号、tag、`file:<绝对路径>`），`installSpec` 只拦空白与开关
 */
export function planSpecsUpdate(specs: Readonly<Record<string, string>>, homeDependencies: Readonly<Record<string, string>>): SpecsUpdatePlan {
  const pkgs = Object.keys(specs).sort((a, b) => a.localeCompare(b))
  const addSpecs = pkgs.map((pkg) => installSpec(pkg, specs[pkg]))

  const notInHome = pkgs.filter((pkg) => homeDependencies[pkg] === undefined)
  if (notInHome.length > 0) {
    throw new Error(`specs 里的 ${notInHome.join('、')} 不在 home 的 package.json 的 dependencies 里：specs 只给已装的包换版本，首次安装用 plugin-manager.install`)
  }
  if (pkgs.includes(CORDIS_PACKAGE)) {
    throw new Error(`specs 里不写 ${CORDIS_PACKAGE}：它的版本跟着内核包 peer 里写的走，specs 里有内核包 ${KERNEL_PACKAGE} 时由插件管理照装上的内核包自己对齐`)
  }
  return { addSpecs, pkgs, includesKernel: pkgs.includes(KERNEL_PACKAGE) }
}

/**
 * `specs` 的 `pnpm add` 前后各读一次的版本号 → 回执里每个包的 `from` / `to`：`to` 是装上的版本号，不是写法原文（tag 与 `file:` 看不出版本）。
 * pnpm 退出码 0 不等于装上了要的版本：写法是准确版本号的，装上的必须就是它（home 清单里原来写 `^` 时 pnpm 可能留着范围内别的预发布版）；
 * 读不到版本号、或准确版本号对不上，回 ok: false 逐项说明。tag 与 `file:` 不核对
 */
export function versionChangesAfterAdd(
  specs: Readonly<Record<string, string>>,
  versionsBefore: InstalledVersions,
  versionsAfter: InstalledVersions,
): VersionChangesAfterAdd {
  const pkgs = Object.keys(specs).sort((a, b) => a.localeCompare(b))
  const unreadable = pkgs.filter((pkg) => versionsAfter.get(pkg) === undefined)
  if (unreadable.length > 0) {
    return { ok: false, error: `pnpm add 退出码 0，但装完读不到 ${unreadable.join('、')} 在 home 的 node_modules 里的 package.json 的 version` }
  }
  const mismatches = pkgs
    .filter((pkg) => isExactVersion(specs[pkg]!))
    .map((pkg) => installedVersionMismatch(pkg, specs[pkg]!, versionsAfter.get(pkg)))
    .filter((mismatch) => mismatch !== undefined)
  if (mismatches.length > 0) return { ok: false, error: mismatches.join('；') }
  return { ok: true, changes: new Map(pkgs.map((pkg) => [pkg, versionChangeOf(versionsBefore.get(pkg), versionsAfter.get(pkg)!)])) }
}

/** 包名 → 它装上后的 `package.json` 里 peerDependencies 的全部包名；表里没有的包按没写 peer 算 */
export type PeerNamesByPackage = ReadonlyMap<string, readonly string[]>

/** 装上后的包清单 → peerDependencies 的包名；清单读不到、没写 peer 都是空表 */
export function peerNamesOf(manifest: unknown): string[] {
  if (!isRecord(manifest)) return []
  const peers = manifest['peerDependencies']
  return isRecord(peers) ? Object.keys(peers) : []
}

/** 一批要重新加载的包按 peer 排出的先后 */
export interface RemountOrder {
  /** 被依赖的在前；同一层（前面的都排完后同时可以重新加载的那些）按包名 */
  ordered: string[]
  /** 这批包里 peer 成的环，每个环从环上包名最小的那个起、按 peer 的方向走一圈回到它（首尾是同一个包），环之间按起点的包名 */
  cycles: string[][]
  /** 环上的包与传递地 peer 了环上包的包，这次不重新加载，按包名 */
  heldBack: string[]
}

/**
 * 只看落在 `pkgs` 里的 peer（自己写自己不算）：集合外的包这次不重新加载，先后无从谈起。
 * 分层的 Kahn 拓扑排序，排不进去的就是环上的与依赖环的
 */
export function remountOrderOf(pkgs: readonly string[], peersOf: PeerNamesByPackage): RemountOrder {
  const byName = (a: string, b: string): number => a.localeCompare(b)
  const batch = new Set(pkgs)
  const peersInBatch = new Map([...batch].map((pkg) => [pkg, new Set((peersOf.get(pkg) ?? []).filter((peer) => peer !== pkg && batch.has(peer)))]))
  const waitingOn = new Map([...peersInBatch].map(([pkg, peers]) => [pkg, peers.size]))

  const ordered: string[] = []
  let layer = [...batch].filter((pkg) => waitingOn.get(pkg) === 0).sort(byName)
  while (layer.length > 0) {
    ordered.push(...layer)
    const nextLayer: string[] = []
    for (const [pkg, peers] of peersInBatch) {
      const settledPeers = layer.filter((done) => peers.has(done)).length
      if (settledPeers === 0) continue
      const remaining = waitingOn.get(pkg)! - settledPeers
      waitingOn.set(pkg, remaining)
      if (remaining === 0) nextLayer.push(pkg)
    }
    layer = nextLayer.sort(byName)
  }

  const placed = new Set(ordered)
  const heldBack = [...batch].filter((pkg) => !placed.has(pkg)).sort(byName)
  return { ordered, cycles: peerCyclesAmong(heldBack, peersInBatch), heldBack }
}

/**
 * `candidates` 里在环上的包各自所在的环：从还没归进哪个环的、包名最小的包起，沿 peer 找回到它的最短路径。
 * 同一个强连通块只报一个环，改掉它再来一次会报出下一个
 */
function peerCyclesAmong(candidates: readonly string[], peersInBatch: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = []
  const covered = new Set<string>()
  for (const start of candidates) {
    if (covered.has(start)) continue
    const cycle = shortestPeerPathBackTo(start, peersInBatch)
    if (cycle === undefined) continue
    cycles.push(cycle)
    for (const member of stronglyConnectedWith(start, peersInBatch)) covered.add(member)
  }
  return cycles
}

/** 广度优先：`start` 沿 peer 走回 `start` 的最短一圈（首尾都是 `start`）；走不回来是 undefined */
function shortestPeerPathBackTo(start: string, peersOf: ReadonlyMap<string, ReadonlySet<string>>): string[] | undefined {
  const cameFrom = new Map<string, string>()
  const queue = [...(peersOf.get(start) ?? [])].sort((a, b) => a.localeCompare(b))
  for (const first of queue) cameFrom.set(first, start)
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === start) {
      const path = [start]
      for (let step = cameFrom.get(start)!; step !== start; step = cameFrom.get(step)!) path.unshift(step)
      return [start, ...path]
    }
    for (const next of [...(peersOf.get(current) ?? [])].sort((a, b) => a.localeCompare(b))) {
      if (cameFrom.has(next)) continue
      cameFrom.set(next, current)
      queue.push(next)
    }
  }
  return undefined
}

function reachableFrom(start: string, peersOf: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const reached = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    for (const next of peersOf.get(queue.shift()!) ?? []) {
      if (reached.has(next)) continue
      reached.add(next)
      queue.push(next)
    }
  }
  return reached
}

function stronglyConnectedWith(start: string, peersOf: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  return [...reachableFrom(start, peersOf)].filter((other) => other === start || reachableFrom(other, peersOf).has(start))
}

/** 排好的先后分成两段：命令里重新加载的，回执之后才重新加载的 */
export interface RemountSchedule {
  /** 在命令里依次重新加载 */
  now: string[]
  /** 回执之后依次重新加载：插件管理自己在最前，其后是传递地 peer 了它的包，照 `ordered` 的先后 */
  afterReceipt: string[]
}

/**
 * 插件管理自己要到回执之后才重新加载（命令还在它的 fiber 上运行）；peer 了它的包在它之前重新加载，拿到的是旧插件管理，
 * 所以传递地 peer 了它的包一起推迟到它之后。`selfPkg` 是这次要重新加载自己那条条目的包，不重新加载自己时是 undefined
 */
export function deferredAfterSelf(ordered: readonly string[], peersOf: PeerNamesByPackage, selfPkg: string | undefined): RemountSchedule {
  if (selfPkg === undefined || !ordered.includes(selfPkg)) return { now: [...ordered], afterReceipt: [] }
  const waitsForSelf = new Set([selfPkg])
  for (const pkg of ordered) {
    if ((peersOf.get(pkg) ?? []).some((peer) => waitsForSelf.has(peer))) waitsForSelf.add(pkg)
  }
  return { now: ordered.filter((pkg) => !waitsForSelf.has(pkg)), afterReceipt: ordered.filter((pkg) => waitsForSelf.has(pkg)) }
}

/** 这次要重新加载本插件自己那条条目（启用着的）的包；自己不在这批里、或那条停用着，是 undefined */
export function packageRemountingSelf(plannedPackages: readonly PackageEntries[]): string | undefined {
  return plannedPackages.find((planned) => planned.entries.some((entry) => entry.self && !entry.disabled))?.pkg
}

/** 回执之后依次重新加载的条目 id：本插件自己那条在最前，其后照 `afterReceipt` 的包序、包内照树里的先后；停用着的不算 */
export function deferredEntryIdsOf(afterReceipt: readonly string[], plannedPackages: readonly PackageEntries[]): string[] {
  const enabledEntries = afterReceipt.flatMap((pkg) => plannedPackages.find((planned) => planned.pkg === pkg)!.entries.filter((entry) => !entry.disabled))
  return [...enabledEntries.filter((entry) => entry.self), ...enabledEntries.filter((entry) => !entry.self)].map((entry) => entry.id)
}

/** 回执 `note` 与日志里那句：环是哪几个、哪些包这次没重新加载、要怎么改 */
export function peerCycleNote(cycles: readonly (readonly string[])[], heldBack: readonly string[]): string {
  return (
    `peer 成环：${cycles.map((cycle) => cycle.join(' → ')).join('，')}。这次没有重新加载 ${heldBack.join('、')}（环上的包与依赖环上包的包），` +
    '它们重启工作台后才换成新装的版本，重启由人决定。peer 成环要去改包：去掉环上的一条 peer，反方向改用局部注入 <上下文>.inject([...], fn)'
  )
}

/**
 * `pnpm add` 前后各读一次的真实目录 → 要重新加载的包：目录变了（包括一次读得到、一次读不到）的包都重新加载，没变的不动。
 * 升级必换目录（pnpm 虚拟存储的目录名带版本号），所以点了名的包也只看目录变没变。`ownEntryId` 完整 id 或不带前缀的都接受
 */
export function packagesToRemount(
  directoriesBefore: InstalledDirectories,
  directoriesAfter: InstalledDirectories,
  requestedPackages: readonly string[],
  store: unknown,
  ownEntryId: string,
): RemountTargets {
  const ownBareId = bareId(ownEntryId)
  const pluginEntries = pluginEntriesOf(store)
  const directoryChanged = (pkg: string): boolean => directoriesBefore.get(pkg) !== directoriesAfter.get(pkg)
  const withEntries = (pkg: string): PackageEntries => ({ pkg, entries: directoryChanged(pkg) ? plannedEntriesOf(pkg, pluginEntries, ownBareId) : [] })
  const requested = new Set(requestedPackages)
  const byName = (a: string, b: string): number => a.localeCompare(b)
  return {
    updated: [...requested].sort(byName).map(withEntries),
    dependents: [...new Set([...directoriesBefore.keys(), ...directoriesAfter.keys()])]
      .filter((pkg) => !requested.has(pkg) && directoryChanged(pkg))
      .sort(byName)
      .map(withEntries),
  }
}
