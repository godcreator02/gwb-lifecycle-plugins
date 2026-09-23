import { bareId, installSpec } from './ids.js'
import { readEntries } from './inventory.js'
import type { OutdatedMap } from './outdated.js'

/**
 * 一键热升的**计划**：pnpm 参数与重挂顺序。纯函数，单独测；真去跑 pnpm、真去动条目树的
 * 那半在 `index.ts` 的 `updateAll`。
 *
 * 热重挂靠的是 loader 的一对动作：条目 `disabled: true` → `fiber.dispose()`；再把 `disabled`
 * 抹掉（`update(id, { disabled: null })`）→ `update()` 见 fiber 没了走 `init()`，而 `_init()`
 * **每次重新 `tree.import(name)`**——所以「停用再启用」就是一次干净的重 import，不用
 * remove / create，条目在 yml 里的位置与 id 一个字不动。
 *
 * **升了的每个包的每条条目都要自己重挂，不能指望级联**：被大家 inject 的件（commands /
 * settings…）重挂时 cordis 会把依赖它的件停了再起，可那是重跑**内存里的旧代码**，盘上的
 * 新版本它碰都没碰。
 *
 * **本件自己排最后**：处理器里停用自己等于把正在跑的这条 await 链连根拔掉，回执就没了。
 * 所以计划里把自己那条条目单独标出来（`self`），执行时先把回执交出去、再在下一个宏任务
 * 里处理它。
 */

/** 一条要重挂的条目 */
export interface PlannedEntry {
  /** 裸 id——`tree.update` 认的那一个 */
  id: string
  /** 本来就停用的：保持停用，不动它（记 skipped） */
  disabled: boolean
  /** 这条就是本件自己的条目 */
  self: boolean
}

/** 一个要升的包 */
export interface PlannedPackage {
  pkg: string
  from: string
  to: string
  /** 它在条目树上的全部条目（分组条目不算），树里的先后；本件自己那条挪到最后 */
  entries: PlannedEntry[]
  /** 本件自己在这个包里 */
  self: boolean
}

export interface UpdateAllPlan {
  /**
   * 一趟 `pnpm add` 的参数：`['add', 'a@1.2.3', 'b@0.4.0', …]`，**精确版本**（outdated 回的
   * `latest`，不是 `@latest` 标签——查到什么就装什么，两次问 registry 之间又发了一版也不会
   * 装成回执上没写的那个）。空清单时是空数组
   */
  pnpmArgs: string[]
  /** 要升的包，按包名排，**本件自己所在的包排最后** */
  packages: PlannedPackage[]
  /** 本件自己在不在这次升级里 */
  selfIncluded: boolean
  /** `only` 里点了名、却不在过期清单里的包——回执里说一声，别让人以为它升了 */
  ignored: string[]
}

/**
 * 出计划。`ownEntryId` 是本件自己那条条目的完整 id（`home:plugins`）或裸 id 都认。
 * `only` 给了就只升点名的那几个。
 */
export function planUpdateAll(
  outdated: Readonly<OutdatedMap>,
  store: unknown,
  ownEntryId: string,
  only?: readonly string[],
): UpdateAllPlan {
  const own = bareId(ownEntryId)
  const wanted = only === undefined ? undefined : new Set(only)
  const ignored = only === undefined ? [] : only.filter((pkg) => outdated[pkg] === undefined)

  const entries = readEntries(store).filter((entry) => !entry.group)
  const packages: PlannedPackage[] = []
  for (const pkg of Object.keys(outdated).sort((a, b) => a.localeCompare(b))) {
    if (wanted !== undefined && !wanted.has(pkg)) continue
    const info = outdated[pkg]
    if (info === undefined) continue
    const mine = entries
      .filter((entry) => entry.pkg === pkg)
      .map<PlannedEntry>((entry) => ({ id: entry.id, disabled: entry.disabled, self: entry.id === own }))
    // 自己那条挪到包内最后：同包的其它实例照常在处理器里重挂，自己那条留给回执之后
    const others = mine.filter((entry) => !entry.self)
    const self = mine.filter((entry) => entry.self)
    packages.push({ pkg, from: info.current, to: info.latest, entries: [...others, ...self], self: self.length > 0 })
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

/**
 * cordis 的 `FiberState`，照原名。它是 `const enum`，`isolatedModules` 下引不到，
 * 数字照它的定义抄（`inventory.ts` 与内核 `main.ts` 里是同一个绕法）
 */
const FIBER_STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const

/**
 * 条目重挂之后到哪一步了，一个词。取法照内核 `main.ts` 的 `describe()`：没 fiber 是
 * import 失败（原因在日志里），有就报状态名；认不出的数字原样带出来
 */
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
 * 等一个 fiber 把手头的事做完（挂载或卸载），最多等 `ms` 毫秒。
 *
 * cordis 的 `Fiber.await()` 是 `while (inertia) await inertia`——卸载中 inertia 是那趟
 * `_unload`，挂载中是 `_reload`，PENDING（inject 没满足）时 inertia 是空的、立刻回来。
 * 所以它本身不会因为「依赖永远不满足」而挂死；会挂死的只有某个件的 `apply` 自己不回来，
 * 那种情况不该拖住整条升级，到点就走。出错（FAILED）它会 throw，这儿吞掉——状态另外读
 */
export function settleFiber(fiber: unknown, ms: number): Promise<void> {
  if (typeof fiber !== 'object' || fiber === null) return Promise.resolve()
  const wait = (fiber as { await?: unknown }).await
  if (typeof wait !== 'function') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    Promise.resolve((wait as () => Promise<unknown>).call(fiber)).then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}
