import { bareId, installSpec } from './ids.js'
import { readEntries, type EntrySnapshot } from './inventory.js'
import { KERNEL_MANAGED_PACKAGES } from './kernel-upgrade.js'
import type { OutdatedMap } from './outdated.js'
import { declaredPluginPeers } from './peers.js'

/** 一条要重新加载的条目 */
export interface PlannedEntry {
  /** 不带前缀的 id——`tree.update` 认的那一个 */
  id: string
  /** 本来就停用的：保持停用，不动它（记 skipped） */
  disabled: boolean
  /** 这条就是本插件自己的条目 */
  self: boolean
}

/** 一个要升的包 */
export interface PlannedPackage {
  pkg: string
  from: string
  to: string
  /** 它在条目树上的全部条目（分组条目不算），按树里的先后；本插件自己那条挪到最后 */
  entries: PlannedEntry[]
  /** 本插件自己在这个包里 */
  self: boolean
}

/**
 * 没升级、但要跟着重新加载的一个包：它 peer 里写了这次换了安装目录的包。pnpm 的虚拟存储目录名带着 peer 的版本，
 * 被 peer 的包一升级，它也被装进新目录；不重新加载，运行着的还是旧目录里的代码，旧目录被 pnpm 清掉后再加载文件就失败
 */
export interface PlannedDependent {
  pkg: string
  /** 它 peer 里写了的、这次换了目录的包（升级了的，或同样跟着重新加载的），按包名排 */
  because: string[]
  /** 它在条目树上的全部条目（分组条目不算），按树里的先后；本插件自己那条挪到最后 */
  entries: PlannedEntry[]
  /** 本插件自己在这个包里 */
  self: boolean
}

/** 过期了、但版本由内核决定而没升的一个包 */
export interface KernelManagedPackage {
  pkg: string
  from: string
  to: string
}

export interface UpdateAllPlan {
  /** 一次 `pnpm add` 的参数：`['add', 'a@1.2.3', …]`，精确版本（outdated 查到的 latest，不是 `@latest` 标签）；清单为空时是空数组 */
  pnpmArgs: string[]
  /** 要升级的包，按包名排，**本插件自己所在的包排最后** */
  packages: PlannedPackage[]
  /**
   * 跟着重新加载的包，在 `packages` 之后处理。先是 peer 直接写了被升级包的，再是 peer 写了这些包的，一层层往外；
   * 同一层按包名排；**本插件自己所在的包挪到整个列表最后**
   */
  dependents: PlannedDependent[]
  /** 本插件自己在不在这次升级或跟着重新加载的包里 */
  selfIncluded: boolean
  /** `only` 里点了名、却不在过期清单里的包——回执里说明，免得人以为它升级了 */
  ignored: string[]
  /** 过期清单里的内核包与 cordis（`only` 给了就只算点了名的），按包名排：一键热升级不升它们，回执里说明 */
  kernelManaged: KernelManagedPackage[]
}

/** 这个包的条目，本插件自己那条挪到最后：同包的其它实例在处理器里重新加载，自己那条留到回执之后 */
function plannedEntriesWithOwnLast(pkg: string, entries: readonly EntrySnapshot[], ownBareId: string): PlannedEntry[] {
  const plannedEntries = entries
    .filter((entry) => entry.pkg === pkg)
    .map<PlannedEntry>((entry) => ({ id: entry.id, disabled: entry.disabled, self: entry.id === ownBareId }))
  return [...plannedEntries.filter((entry) => !entry.self), ...plannedEntries.filter((entry) => entry.self)]
}

/**
 * 被升级的包 → 要跟着重新加载的包。只看插件（keywords 含 gwb-plugin）peer 里除了内核包与 cordis 的那些，可选的 peer 也算；
 * 本身在升级的包、内核包与 cordis 不算。一层层往外找：peer 写了跟着换目录的插件的，目录名里也带着那个插件的 peer，照样换目录
 */
function plannedDependents(
  upgradedPackages: readonly string[],
  homeManifests: ReadonlyMap<string, unknown>,
  pluginEntries: readonly EntrySnapshot[],
  ownBareId: string,
): PlannedDependent[] {
  const peersByPackage = new Map<string, string[]>()
  for (const [pkg, manifest] of homeManifests) {
    if (KERNEL_MANAGED_PACKAGES.has(pkg)) continue
    const peers = declaredPluginPeers(manifest).map((peer) => peer.pkg)
    if (peers.length > 0) peersByPackage.set(pkg, peers)
  }
  const candidates = [...peersByPackage].sort(([a], [b]) => a.localeCompare(b))

  const movedPackages = new Set(upgradedPackages)
  const dependents: PlannedDependent[] = []
  for (;;) {
    const layer: PlannedDependent[] = []
    for (const [pkg, peers] of candidates) {
      if (movedPackages.has(pkg)) continue
      const because = peers.filter((peer) => movedPackages.has(peer)).sort((a, b) => a.localeCompare(b))
      if (because.length === 0) continue
      const entries = plannedEntriesWithOwnLast(pkg, pluginEntries, ownBareId)
      layer.push({ pkg, because, entries, self: entries.some((entry) => entry.self) })
    }
    if (layer.length === 0) break
    for (const dependent of layer) movedPackages.add(dependent.pkg)
    dependents.push(...layer)
  }
  return dependents.sort((a, b) => Number(a.self) - Number(b.self))
}

/**
 * `ownEntryId` 完整 id（`home:plugins`）或不带前缀的都接受；`homeManifests` 是 home 的 dependencies 里每个包 → 它装着的清单
 * （没装的是 undefined），用来找跟着重新加载的包；`only` 给了就只升级点名的那几个
 */
export function planUpdateAll(
  outdated: Readonly<OutdatedMap>,
  store: unknown,
  ownEntryId: string,
  homeManifests: ReadonlyMap<string, unknown>,
  only?: readonly string[],
): UpdateAllPlan {
  const ownBareId = bareId(ownEntryId)
  const onlyThesePackages = only === undefined ? undefined : new Set(only)
  const ignored = only === undefined ? [] : only.filter((pkg) => outdated[pkg] === undefined)

  const pluginEntries = readEntries(store).filter((entry) => !entry.group)
  const packages: PlannedPackage[] = []
  const kernelManaged: KernelManagedPackage[] = []
  for (const pkg of Object.keys(outdated).sort((a, b) => a.localeCompare(b))) {
    if (onlyThesePackages !== undefined && !onlyThesePackages.has(pkg)) continue
    const versionGap = outdated[pkg]
    if (versionGap === undefined) continue
    if (KERNEL_MANAGED_PACKAGES.has(pkg)) {
      kernelManaged.push({ pkg, from: versionGap.current, to: versionGap.latest })
      continue
    }
    const plannedEntries = plannedEntriesWithOwnLast(pkg, pluginEntries, ownBareId)
    packages.push({ pkg, from: versionGap.current, to: versionGap.latest, entries: plannedEntries, self: plannedEntries.some((entry) => entry.self) })
  }
  // 自己所在的包排最后：它前面的每一条都在处理器里做完，回执才完整
  packages.sort((a, b) => Number(a.self) - Number(b.self))
  const dependents = plannedDependents(packages.map((p) => p.pkg), homeManifests, pluginEntries, ownBareId)

  return {
    pnpmArgs: packages.length === 0 ? [] : ['add', ...packages.map((p) => installSpec(p.pkg, p.to))],
    packages,
    dependents,
    selfIncluded: packages.some((p) => p.self) || dependents.some((d) => d.self),
    ignored,
    kernelManaged,
  }
}
