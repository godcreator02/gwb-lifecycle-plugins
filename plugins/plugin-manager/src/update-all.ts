import { bareId, installSpec } from './ids.js'
import { readEntries, type EntrySnapshot } from './inventory.js'
import type { OutdatedMap } from './outdated.js'

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

export interface UpdateAllPlan {
  /** 一次 `pnpm add` 的参数：`['add', 'a@1.2.3', …]`，精确版本（outdated 查到的 latest，不是 `@latest` 标签）；清单为空时是空数组 */
  pnpmArgs: string[]
  /** 要升级的包，按包名排，**本插件自己所在的包排最后** */
  packages: PlannedPackage[]
  /** 本插件自己在不在这次升级里 */
  selfIncluded: boolean
  /** `only` 里点了名、却不在过期清单里的包——回执里说明，免得人以为它升级了 */
  ignored: string[]
}

/** 这个包的条目，本插件自己那条挪到最后：同包的其它实例在处理器里重新加载，自己那条留到回执之后 */
function plannedEntriesWithOwnLast(pkg: string, entries: readonly EntrySnapshot[], ownBareId: string): PlannedEntry[] {
  const plannedEntries = entries
    .filter((entry) => entry.pkg === pkg)
    .map<PlannedEntry>((entry) => ({ id: entry.id, disabled: entry.disabled, self: entry.id === ownBareId }))
  return [...plannedEntries.filter((entry) => !entry.self), ...plannedEntries.filter((entry) => entry.self)]
}

/** `ownEntryId` 完整 id（`home:plugins`）或不带前缀的都接受；`only` 给了就只升级点名的那几个 */
export function planUpdateAll(
  outdated: Readonly<OutdatedMap>,
  store: unknown,
  ownEntryId: string,
  only?: readonly string[],
): UpdateAllPlan {
  const ownBareId = bareId(ownEntryId)
  const onlyThesePackages = only === undefined ? undefined : new Set(only)
  const ignored = only === undefined ? [] : only.filter((pkg) => outdated[pkg] === undefined)

  const pluginEntries = readEntries(store).filter((entry) => !entry.group)
  const packages: PlannedPackage[] = []
  for (const pkg of Object.keys(outdated).sort((a, b) => a.localeCompare(b))) {
    if (onlyThesePackages !== undefined && !onlyThesePackages.has(pkg)) continue
    const versionGap = outdated[pkg]
    if (versionGap === undefined) continue
    const plannedEntries = plannedEntriesWithOwnLast(pkg, pluginEntries, ownBareId)
    packages.push({ pkg, from: versionGap.current, to: versionGap.latest, entries: plannedEntries, self: plannedEntries.some((entry) => entry.self) })
  }
  // 自己所在的包排最后：它前面的每一条都在处理器里做完，回执才完整
  packages.sort((a, b) => Number(a.self) - Number(b.self))

  return {
    pnpmArgs: packages.length === 0 ? [] : ['add', ...packages.map((p) => installSpec(p.pkg, p.to))],
    packages,
    selfIncluded: packages.some((p) => p.self),
    ignored,
  }
}

/** cordis 的 `FiberState`，按它的定义照抄数字顺序（`const enum`，`isolatedModules` 下引用不到）；`tests/fiber-state.test.ts` 核对 */
export const FIBER_STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const

/** 条目此刻到哪一步了，一个词。取法与内核 `main.ts` 的 `describe()` 一致：没 fiber 是 import 失败，认不出的数字原样带出来 */
export function fiberStateOf(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return 'no entry'
  const record = entry as { disabled?: unknown; fiber?: unknown }
  if (record.disabled === true) return 'disabled'
  const fiber = record.fiber
  if (typeof fiber !== 'object' || fiber === null) return 'no fiber（import 失败，原因在日志里）'
  const state = (fiber as { state?: unknown }).state
  if (typeof state !== 'number') return `state=${String(state)}`
  return FIBER_STATE[state] ?? `state=${String(state)}`
}

/**
 * 等 fiber 把手头的加载或卸载做完，最多等 `ms` 毫秒。cordis 的 `Fiber.await()` 在 PENDING 时立刻返回，
 * 会卡住的只有某个插件的 `apply` 自己不返回，所以超时就继续；它抛的错（FAILED）忽略，状态另外读
 */
export function settleFiber(fiber: unknown, ms: number): Promise<void> {
  if (typeof fiber !== 'object' || fiber === null) return Promise.resolve()
  const awaitMethod = (fiber as { await?: unknown }).await
  if (typeof awaitMethod !== 'function') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const finish = (): void => {
      clearTimeout(timer)
      resolve()
    }
    Promise.resolve((awaitMethod as () => Promise<unknown>).call(fiber)).then(finish, finish)
  })
}
