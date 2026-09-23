import { bareId, installSpec } from './ids.js'
import { readEntries } from './inventory.js'
import type { OutdatedMap } from './outdated.js'

/**
 * 一键热升级的**计划**：pnpm 参数与重新加载顺序。纯函数，单独测；实际运行 pnpm、实际操作条目树的
 * 部分在 `index.ts` 的 `updateAll`。
 *
 * 热重新加载依靠 loader 的一对动作：条目 `disabled: true` → `fiber.dispose()`；再把 `disabled`
 * 去掉（`update(id, { disabled: null })`）→ `update()` 见 fiber 没了走 `init()`，而 `_init()`
 * **每次重新 `tree.import(name)`**——所以「停用再启用」就是一次干净的重新 import，不用
 * remove / create，条目在 yml 里的位置与 id 完全不变。
 *
 * **升级了的每个包的每条条目都要各自重新加载，不能指望级联**：被其他插件 inject 的插件（commands /
 * settings…）重新加载时 cordis 会把依赖它的插件停用再启动，但那是重跑**内存里的旧代码**，磁盘上的
 * 新版本完全没有加载。
 *
 * **本插件自己排最后**：处理器里停用自己等于把正在执行的这条 await 链整个终止，回执就没了。
 * 所以计划里把自己那条条目单独标出来（`self`），执行时先把回执返回、再在下一个宏任务
 * 里处理它。
 */

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
  /**
   * 一次 `pnpm add` 的参数：`['add', 'a@1.2.3', 'b@0.4.0', …]`，**精确版本**（outdated 返回的
   * `latest`，不是 `@latest` 标签——查到什么就装什么，两次查询 registry 之间又发了一版也不会
   * 装成回执上没写的那个）。清单为空时是空数组
   */
  pnpmArgs: string[]
  /** 要升级的包，按包名排，**本插件自己所在的包排最后** */
  packages: PlannedPackage[]
  /** 本插件自己在不在这次升级里 */
  selfIncluded: boolean
  /** `only` 里点了名、却不在过期清单里的包——回执里说明，免得人以为它升级了 */
  ignored: string[]
}

/**
 * 生成计划。`ownEntryId` 是本插件自己那条条目的完整 id（`home:plugins`）或不带前缀的 id 都接受。
 * `only` 给了就只升级点名的那几个。
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
    // 自己那条挪到包内最后：同包的其它实例照常在处理器里重新加载，自己那条留到回执之后
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
 * cordis 的 `FiberState`，照原名。它是 `const enum`，`isolatedModules` 下引用不到，按它的定义照抄数字顺序。
 * `tests/fiber-state.test.ts` 核对它与已安装的 cordis 声明的成员顺序一致
 */
export const FIBER_STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const

/**
 * 条目重新加载之后到哪一步了，一个词。取法与内核 `main.ts` 的 `describe()` 一致：没 fiber 是
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
 * 等一个 fiber 把手头的事做完（加载或卸载），最多等 `ms` 毫秒。
 *
 * cordis 的 `Fiber.await()` 是 `while (inertia) await inertia`——卸载中 inertia 是那次
 * `_unload`，加载中是 `_reload`，PENDING（inject 没满足）时 inertia 是空的、立刻返回。
 * 所以它本身不会因为「依赖永远不满足」而卡死；会卡死的只有某个插件的 `apply` 自己不返回，
 * 那种情况不该拖住整个升级，超时就继续。出错（FAILED）它会 throw，这里忽略——状态另外读
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
