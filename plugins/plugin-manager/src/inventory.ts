import { FIBER_STATE } from './fiber.js'
import type { PeerStatus } from './peers.js'
import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑：这个文件里不 import node:fs

const FIBER_ACTIVE = FIBER_STATE.indexOf('ACTIVE')

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

/** home 的 dependencies 与条目树对照出的一个包 */
export interface ReconciledPackage {
  pkg: string
  /** home 的 `package.json` 的 dependencies 里它对应的值。条目引用一个没装的包时没有这个字段 */
  spec?: string
  /** home 的 dependencies 里有它 */
  installed: boolean
  /** 它在 cordis.yml 里的条目，按树里的先后。空数组只表示「一条条目都没有」，不推断原因 */
  entries: EntrySnapshot[]
}

/** 一个包在 `list` 里的样子：对照结果加上它 peer 里写的包（含内核包）满没满足 */
export interface PluginPackageView extends ReconciledPackage, PeerStatus {}

/** 包清单里的 `version`；清单读不到或没写时是 undefined */
export function installedVersionOf(manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined
  const version = manifest['version']
  return typeof version === 'string' ? version : undefined
}

/** home 的 `package.json`（`file` 是它的路径，只用于报错）→ 包名 → 版本范围。没写 dependencies 是空表；清单不是对象、dependencies 不是对象、某一格不是字符串都抛错 */
export function toDependencies(raw: unknown, file: string): Record<string, string> {
  if (!isRecord(raw)) throw new Error(`${file} 不是一个 JSON 对象`)
  const dependencies = raw['dependencies']
  if (dependencies === undefined) return {}
  if (!isRecord(dependencies)) throw new Error(`${file} 的 dependencies 不是对象：${JSON.stringify(dependencies)}`)
  const versionRangesByPackage: Record<string, string> = {}
  for (const [pkg, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') throw new Error(`${file} 的 dependencies 里 ${pkg} 的值不是字符串：${JSON.stringify(spec)}`)
    versionRangesByPackage[pkg] = spec
  }
  return versionRangesByPackage
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

/** dependencies 里有、条目树上没有的报成 `entries: []`；条目指向不在 dependencies 里的包报成 `installed: false` */
export function reconcile(deps: Readonly<Record<string, string>>, entries: readonly EntrySnapshot[]): ReconciledPackage[] {
  const entriesByPackage = new Map<string, EntrySnapshot[]>()
  for (const pkg of Object.keys(deps)) entriesByPackage.set(pkg, [])
  for (const entry of entries) {
    const entriesOfPackage = entriesByPackage.get(entry.pkg)
    if (entriesOfPackage === undefined) entriesByPackage.set(entry.pkg, [{ ...entry }])
    else entriesOfPackage.push({ ...entry })
  }
  return [...entriesByPackage.entries()]
    .map(([pkg, entriesOfPackage]) => {
      const spec = deps[pkg]
      return spec === undefined
        ? { pkg, installed: false, entries: entriesOfPackage }
        : { pkg, spec, installed: true, entries: entriesOfPackage }
    })
    .sort((a, b) => a.pkg.localeCompare(b.pkg))
}
