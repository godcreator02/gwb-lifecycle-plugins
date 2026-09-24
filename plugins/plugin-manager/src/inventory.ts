import type { KernelCompatStatus } from './kernel-compat.js'
import type { RequiresStatus } from './requires.js'
import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑：这个文件里不 import node:fs

/** cordis 的 `FiberState.ACTIVE`。那是 `const enum`，`isolatedModules` 下 import 不进来，照抄字面量 */
const FIBER_ACTIVE = 2

/** cordis.yml 里一条条目此刻的样子 */
export interface EntrySnapshot {
  /** 不带前缀的 id。改这条条目要用它——`tree.resolve` 只认这个 */
  id: string
  /** 完整 entryId（`home:commands`）。插件从自己的 ctx 上读到的是这个 */
  entryId: string
  /** 加载的是哪个包。group 这类内建条目是 `cordis:group` */
  pkg: string
  /** cordis.yml 里 `disabled: true` */
  disabled: boolean
  /** fiber 的状态是 ACTIVE。看状态不看 fiber 在不在：inject 没满足的插件也有 fiber，只是到不了 ACTIVE */
  active: boolean
  /** `group: true` 的那种条目——它是个分组，不是插件 */
  group: boolean
}

/** 一条条目在 `list` 里的样子：快照加上显示名 */
export interface PluginEntryView extends EntrySnapshot {
  /** 人给它起的名字。没设过就没有这个字段，界面改为显示 id */
  label?: string
}

/** home 的 dependencies 与条目树对照出的一个包 */
export interface ReconciledPackage {
  pkg: string
  /** home 的 `package.json` 的 dependencies 里它对应的值。条目引用一个没装的包时没有这个字段 */
  spec?: string
  /** home 的 dependencies 里有它 */
  installed: boolean
  /** 它在 cordis.yml 里的条目，按树里的先后。空数组只表示「一条条目都没有」，不推断原因 */
  entries: PluginEntryView[]
}

/** 一个包在 `list` 里的样子：对照结果加上它 peer 里内核包的范围包不包含运行中的内核、它要求的别的包满没满足 */
export interface PluginPackageView extends ReconciledPackage, KernelCompatStatus, RequiresStatus {}

/** home 的 `package.json` → 包名 → 版本范围。格式不对的部分当作没有，不因此作废整份 */
export function toDependencies(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const dependencies = raw['dependencies']
  if (!isRecord(dependencies)) return {}
  const versionRangesByPackage: Record<string, string> = {}
  for (const [pkg, spec] of Object.entries(dependencies)) {
    if (typeof spec === 'string') versionRangesByPackage[pkg] = spec
  }
  return versionRangesByPackage
}

/** 本插件自己的 labels 文档 → 不带前缀的 id → 显示名。格式不对的项丢掉，不作废整份 */
export function toLabels(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const labelsById: Record<string, string> = {}
  for (const [id, label] of Object.entries(raw)) {
    if (typeof label === 'string' && label !== '') labelsById[id] = label
  }
  return labelsById
}

function entrySnapshotOf(id: string, storedEntry: Record<string, unknown>): EntrySnapshot {
  const options = isRecord(storedEntry['options']) ? storedEntry['options'] : {}
  const fiber = isRecord(storedEntry['fiber']) ? storedEntry['fiber'] : undefined
  const entryId = storedEntry['id']
  return {
    id,
    entryId: typeof entryId === 'string' && entryId !== '' ? entryId : id,
    pkg: typeof options['name'] === 'string' ? options['name'] : '',
    disabled: storedEntry['disabled'] === true,
    active: fiber?.['state'] === FIBER_ACTIVE,
    group: options['group'] === true,
  }
}

/** loader 条目树的 `store`（键是不带前缀的 id）→ 快照。形状不对的那一项跳过：条目来自可以手工改的 cordis.yml */
export function readEntries(store: unknown): EntrySnapshot[] {
  if (!isRecord(store)) return []
  const snapshots: EntrySnapshot[] = []
  for (const [id, storedEntry] of Object.entries(store)) {
    if (!isRecord(storedEntry)) continue
    snapshots.push(entrySnapshotOf(id, storedEntry))
  }
  return snapshots
}

function entryViewOf(entry: EntrySnapshot, labels: Readonly<Record<string, string>>): PluginEntryView {
  const label = labels[entry.id]
  return label === undefined ? { ...entry } : { ...entry, label }
}

/** dependencies 里有、条目树上没有的报成 `entries: []`；条目指向不在 dependencies 里的包报成 `installed: false` */
export function reconcile(
  deps: Readonly<Record<string, string>>,
  entries: readonly EntrySnapshot[],
  labels: Readonly<Record<string, string>>,
): ReconciledPackage[] {
  const entryViewsByPackage = new Map<string, PluginEntryView[]>()
  for (const pkg of Object.keys(deps)) entryViewsByPackage.set(pkg, [])
  for (const entry of entries) {
    const view = entryViewOf(entry, labels)
    const entryViewsOfPackage = entryViewsByPackage.get(entry.pkg)
    if (entryViewsOfPackage === undefined) entryViewsByPackage.set(entry.pkg, [view])
    else entryViewsOfPackage.push(view)
  }
  return [...entryViewsByPackage.entries()]
    .map(([pkg, entryViews]) => {
      const spec = deps[pkg]
      return spec === undefined
        ? { pkg, installed: false, entries: entryViews }
        : { pkg, spec, installed: true, entries: entryViews }
    })
    .sort((a, b) => a.pkg.localeCompare(b.pkg))
}
