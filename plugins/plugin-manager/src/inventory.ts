import { FIBER_STATE } from './fiber.js'
import type { EntrySnapshot, ReconciledPackage } from './receipts.js'
import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑：这个文件里不 import node:fs

const FIBER_ACTIVE = FIBER_STATE.indexOf('ACTIVE')

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
