import { bareId, installSpec } from './ids.js'
import { readEntries, type EntrySnapshot } from './inventory.js'
import { isExactVersion, KERNEL_PACKAGE } from './kernel-compat.js'
import { CORDIS_PACKAGE, installedVersionMismatch, KERNEL_MANAGED_PACKAGES, versionChangeOf, type VersionChange } from './kernel-upgrade.js'
import type { OutdatedMap } from './outdated.js'

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

/** 一个包与它在条目树上的全部条目（分组条目不算），条目按树里的先后 */
export interface PackageEntries {
  pkg: string
  entries: PlannedEntry[]
}

/** 一个要升到 outdated 查到的版本的包 */
export interface PlannedPackage extends PackageEntries {
  from: string
  to: string
}

/**
 * 没升级、但 `pnpm add` 前后真实目录变了的一个包（多半是 peer 写了被升级包的插件：pnpm 虚拟存储的目录名带着 peer 的版本）。
 * 不重新加载，运行着的还是旧目录里的代码，旧目录被 pnpm 清掉后再加载文件就失败
 */
export type PlannedDependent = PackageEntries

export interface OutdatedUpdatePlan {
  /** `pnpm add` 的每一项 `<包名>@<版本号>`，按包名排：精确版本（outdated 查到的 latest，不是 `@latest` 标签）；清单为空时是空数组 */
  addSpecs: string[]
  /** 要升级的包，按包名排 */
  packages: PlannedPackage[]
  /** `only` 里点了名、在 home 里但不在过期清单里的包（已是最新）——回执里说明，免得人以为它升级了 */
  alreadyLatest: string[]
}

export interface SpecsUpdatePlan {
  /** `pnpm add` 的每一项 `<包名>@<写法>`，按包名排 */
  addSpecs: string[]
  /** 要装的包，按包名排 */
  packages: PackageEntries[]
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

/** `outdated` 已经不含内核包与 cordis。`ownEntryId` 完整 id（`home:plugins`）或不带前缀的都接受；`only` 给了就只升级点名的那几个 */
export function planOutdatedUpdate(outdated: Readonly<OutdatedMap>, store: unknown, ownEntryId: string, only?: readonly string[]): OutdatedUpdatePlan {
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
    addSpecs: packages.map((p) => installSpec(p.pkg, p.to)),
    packages,
    alreadyLatest,
  }
}

/**
 * 包名或写法不合规、包不在 home 的 dependencies 里、写了 cordis，都直接抛错。
 * 写法原样交给 pnpm（版本号、tag、`file:<绝对路径>`），`installSpec` 只拦空白与开关
 */
export function planSpecsUpdate(
  specs: Readonly<Record<string, string>>,
  homeDependencies: Readonly<Record<string, string>>,
  store: unknown,
  ownEntryId: string,
): SpecsUpdatePlan {
  const pkgs = Object.keys(specs).sort((a, b) => a.localeCompare(b))
  const addSpecs = pkgs.map((pkg) => installSpec(pkg, specs[pkg]))

  const notInHome = pkgs.filter((pkg) => homeDependencies[pkg] === undefined)
  if (notInHome.length > 0) {
    throw new Error(`specs 里的 ${notInHome.join('、')} 不在 home 的 package.json 的 dependencies 里：specs 只给已装的包换版本，首次安装用 plugin-manager.install`)
  }
  if (pkgs.includes(CORDIS_PACKAGE)) {
    throw new Error(`specs 里不写 ${CORDIS_PACKAGE}：它的版本跟着内核包 peer 里写的走，specs 里有内核包 ${KERNEL_PACKAGE} 时由插件管理照装上的内核包自己对齐`)
  }
  const includesKernel = pkgs.includes(KERNEL_PACKAGE)

  const ownBareId = bareId(ownEntryId)
  const pluginEntries = pluginEntriesOf(store)
  return {
    addSpecs,
    packages: pkgs.map((pkg) => ({ pkg, entries: plannedEntriesOf(pkg, pluginEntries, ownBareId) })),
    includesKernel,
  }
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
