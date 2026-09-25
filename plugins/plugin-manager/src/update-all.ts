import { bareId, installSpec } from './ids.js'
import { readEntries, type EntrySnapshot } from './inventory.js'
import { KERNEL_MANAGED_PACKAGES } from './kernel-upgrade.js'
import type { OutdatedMap } from './outdated.js'

/** 一条要重新加载的条目 */
export interface PlannedEntry {
  /** 不带前缀的 id——`tree.update` 认的那一个 */
  id: string
  /** 本来就停用的：保持停用，不动它（记 skipped） */
  disabled: boolean
  /** 这条就是本插件自己的条目：执行时只记 deferred，回执发出之后才重新加载 */
  self: boolean
}

/** 一个要升的包 */
export interface PlannedPackage {
  pkg: string
  from: string
  to: string
  /** 它在条目树上的全部条目（分组条目不算），按树里的先后 */
  entries: PlannedEntry[]
}

/**
 * 没升级、但 `pnpm add` 前后真实目录变了的一个包（多半是 peer 写了被升级包的插件：pnpm 虚拟存储的目录名带着 peer 的版本）。
 * 不重新加载，运行着的还是旧目录里的代码，旧目录被 pnpm 清掉后再加载文件就失败
 */
export interface PlannedDependent {
  pkg: string
  /** 它在条目树上的全部条目（分组条目不算），按树里的先后 */
  entries: PlannedEntry[]
}

export interface UpdateAllPlan {
  /** 一次 `pnpm add` 的参数：`['add', 'a@1.2.3', …]`，精确版本（outdated 查到的 latest，不是 `@latest` 标签）；清单为空时是空数组 */
  pnpmArgs: string[]
  /** 要升级的包，按包名排 */
  packages: PlannedPackage[]
  /** `only` 里点了名、在 home 里但不在过期清单里的包（已是最新）——回执里说明，免得人以为它升级了 */
  alreadyLatest: string[]
}

/** 包名 → `node_modules/<包名>` 指向的真实目录；读不到（没装）的是 undefined */
export type InstalledDirectories = ReadonlyMap<string, string | undefined>

function pluginEntriesOf(store: unknown): EntrySnapshot[] {
  return readEntries(store).filter((entry) => !entry.group)
}

function plannedEntriesOf(pkg: string, entries: readonly EntrySnapshot[], ownBareId: string): PlannedEntry[] {
  return entries
    .filter((entry) => entry.pkg === pkg)
    .map<PlannedEntry>((entry) => ({ id: entry.id, disabled: entry.disabled, self: entry.id === ownBareId }))
}

/** `only` 里不在 home 的 dependencies 里的包名多半是拼错了：直接抛错，说出是哪几个；不给 `only` 不查 */
export function assertOnlyPackagesInHome(only: readonly string[] | undefined, homeDependencies: Readonly<Record<string, string>>): void {
  const notInHome = (only ?? []).filter((pkg) => homeDependencies[pkg] === undefined)
  if (notInHome.length > 0) {
    throw new Error(`only 里的 ${notInHome.join('、')} 不在 home 的 package.json 的 dependencies 里（拼错了？）。装了哪些包调用 plugin-manager.list 看`)
  }
}

/** 内核包与 cordis 热升级不了：`only` 点了它们的名直接抛错，指向升内核的命令 */
export function assertOnlyNotKernelManaged(only: readonly string[] | undefined): void {
  const kernelManaged = (only ?? []).filter((pkg) => KERNEL_MANAGED_PACKAGES.has(pkg))
  if (kernelManaged.length > 0) {
    throw new Error(`only 里的 ${kernelManaged.join('、')} 由内核决定版本，热升级不了：内核包用 plugin-manager.update-kernel 升，cordis 随它对齐`)
  }
}

/** `outdated` 已经不含内核包与 cordis。`ownEntryId` 完整 id（`home:plugins`）或不带前缀的都接受；`only` 给了就只升级点名的那几个 */
export function planUpdateAll(outdated: Readonly<OutdatedMap>, store: unknown, ownEntryId: string, only?: readonly string[]): UpdateAllPlan {
  const ownBareId = bareId(ownEntryId)
  const onlyThesePackages = only === undefined ? undefined : new Set(only)
  const alreadyLatest = only === undefined ? [] : only.filter((pkg) => outdated[pkg] === undefined)

  const pluginEntries = pluginEntriesOf(store)
  const packages: PlannedPackage[] = []
  for (const pkg of Object.keys(outdated).sort((a, b) => a.localeCompare(b))) {
    if (onlyThesePackages !== undefined && !onlyThesePackages.has(pkg)) continue
    const versionGap = outdated[pkg]
    if (versionGap === undefined) continue
    packages.push({ pkg, from: versionGap.current, to: versionGap.latest, entries: plannedEntriesOf(pkg, pluginEntries, ownBareId) })
  }

  return {
    pnpmArgs: packages.length === 0 ? [] : ['add', ...packages.map((p) => installSpec(p.pkg, p.to))],
    packages,
    alreadyLatest,
  }
}

/**
 * `pnpm add` 前后各读一次的真实目录 → 要跟着重新加载的包：目录变了（包括一次读得到、一次读不到）、本身又没升级的，按包名排
 */
export function plannedDependents(
  directoriesBefore: InstalledDirectories,
  directoriesAfter: InstalledDirectories,
  upgradedPackages: readonly string[],
  store: unknown,
  ownEntryId: string,
): PlannedDependent[] {
  const ownBareId = bareId(ownEntryId)
  const upgraded = new Set(upgradedPackages)
  const pluginEntries = pluginEntriesOf(store)
  return [...new Set([...directoriesBefore.keys(), ...directoriesAfter.keys()])]
    .filter((pkg) => !upgraded.has(pkg) && directoriesBefore.get(pkg) !== directoriesAfter.get(pkg))
    .sort((a, b) => a.localeCompare(b))
    .map((pkg) => ({ pkg, entries: plannedEntriesOf(pkg, pluginEntries, ownBareId) }))
}
