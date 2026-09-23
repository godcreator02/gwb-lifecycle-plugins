import { isRecord } from './vocab.js'

/**
 * 磁盘上的清单与条目树对照——零 I/O 纯逻辑（出现 `node:fs` import 就违反了这条约定）。
 * 读磁盘的部分在 `home.ts`，取条目树的部分在 `tree.ts`。
 */

/**
 * cordis 的 `FiberState.ACTIVE`。**那是个 `const enum`**，`isolatedModules` 下 import
 * 不进来，所以照抄字面量（状态名表在 `update-all.ts` 的 `FIBER_STATE`，测试核对它与内核的一致）。
 */
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
  /**
   * 是否真的运行起来了。
   *
   * **判断的是 fiber 的状态，不是 fiber 存不存在**：cordis 创建 fiber 是同步的，inject 没满足的
   * 插件照样有一个 fiber，只是永远到不了 ACTIVE。所以判断「已加载」只能看这个状态。
   */
  active: boolean
  /** `group: true` 的那种条目——它是个分组，不是插件 */
  group: boolean
}

/** 一条条目在 `list` 里的样子：快照加上显示名 */
export interface PluginEntryView extends EntrySnapshot {
  /** 人给它起的名字。没设过就没有这个字段，界面改为显示 id */
  label?: string
}

/** 一个包在 `list` 里的样子 */
export interface PluginPackageView {
  pkg: string
  /**
   * home 的 `package.json` 的 dependencies 里它对应的值。
   * 条目引用一个没装的包时没有这个字段（`installed` 同时是 false）。
   */
  spec?: string
  /** home 的 dependencies 里有它 */
  installed: boolean
  /** 它在 cordis.yml 里的条目，按树里的先后。空数组只表示「一条条目都没有」，不推断原因 */
  entries: PluginEntryView[]
}

/** home 的 `package.json` 收窄成一张 包名 → 版本范围 的表。格式不对的部分当作没有，不因此作废整份 */
export function toDependencies(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const deps = raw['dependencies']
  if (!isRecord(deps)) return {}
  const out: Record<string, string> = {}
  for (const [pkg, spec] of Object.entries(deps)) {
    if (typeof spec === 'string') out[pkg] = spec
  }
  return out
}

/** 本插件自己的 labels 文档收窄成 不带前缀的 id → 显示名。格式不对的项丢掉，不作废整份 */
export function toLabels(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const [id, label] of Object.entries(raw)) {
    if (typeof label === 'string' && label !== '') out[id] = label
  }
  return out
}

/**
 * loader 条目树的 `store` → 快照数组。
 *
 * `store` 是 `Object.create(null)` 建的不分层的表，键就是不带前缀的 id。按运行时形状逐格读，形状不对的
 * 那格跳过——条目来自可以手工改的 cordis.yml，一格坏了不该让整个 `list` 失败。
 */
export function readEntries(store: unknown): EntrySnapshot[] {
  if (!isRecord(store)) return []
  const out: EntrySnapshot[] = []
  for (const [id, value] of Object.entries(store)) {
    if (!isRecord(value)) continue
    const options = isRecord(value['options']) ? value['options'] : {}
    const fiber = isRecord(value['fiber']) ? value['fiber'] : undefined
    const entryId = value['id']
    out.push({
      id,
      entryId: typeof entryId === 'string' && entryId !== '' ? entryId : id,
      pkg: typeof options['name'] === 'string' ? options['name'] : '',
      disabled: value['disabled'] === true,
      active: fiber?.['state'] === FIBER_ACTIVE,
      group: options['group'] === true,
    })
  }
  return out
}

/**
 * 包与条目对照。**两边都不丢**：dependencies 里有、条目树上没有的包报成 `entries: []`；
 * 条目引用一个不在 dependencies 里的包（手工改过 cordis.yml、或者包被 `pnpm remove` 删了）
 * 报成 `installed: false`。静默丢掉任何一边都会让界面上少一行，而人在磁盘上明明看得见。
 */
export function reconcile(
  deps: Readonly<Record<string, string>>,
  entries: readonly EntrySnapshot[],
  labels: Readonly<Record<string, string>>,
): PluginPackageView[] {
  const byPkg = new Map<string, PluginEntryView[]>()
  for (const pkg of Object.keys(deps)) byPkg.set(pkg, [])
  for (const entry of entries) {
    const label = labels[entry.id]
    const view: PluginEntryView = label === undefined ? { ...entry } : { ...entry, label }
    const bucket = byPkg.get(entry.pkg)
    if (bucket === undefined) byPkg.set(entry.pkg, [view])
    else bucket.push(view)
  }
  return [...byPkg.entries()]
    .map(([pkg, list]) => {
      const spec = deps[pkg]
      return spec === undefined
        ? { pkg, installed: false, entries: list }
        : { pkg, spec, installed: true, entries: list }
    })
    .sort((a, b) => a.pkg.localeCompare(b.pkg))
}
