import { fiberStateOf, settleFiber } from './fiber.js'
import type { RemountedEntry } from './receipts.js'
import { isRecord } from './vocab.js'
import type { EntryTreeLike } from './tree.js'

/** 停用/启用之后等 fiber 把手头的事做完，最多等这么久。超时就继续，读到什么状态报什么 */
export const SETTLE_MS = 5_000

/** 事先拿到的 logger：本插件重新加载自己时，ctx 上的东西都不能用 */
export interface RemountLog {
  info(message: string): void
  warn(message: string): void
}

/** 把一个函数排到下一个宏任务。测试里换成手动触发 */
export type Schedule = (task: () => void) => void

const nextMacrotask: Schedule = (task) => {
  setTimeout(task, 0)
}

/**
 * 停用 → 等旧 fiber 卸载完 → 启用 → 等新 fiber 启动完，返回它的状态。不等旧的卸载完就启用，
 * 旧服务可能还没撤销，cordis 报「service has been registered」。原本停用的条目，最终是启用的
 */
export async function remountEntry(tree: EntryTreeLike, id: string, settleMs: number = SETTLE_MS): Promise<string> {
  const oldFiber = fiberOf(tree.store[id])
  await tree.update(id, { disabled: true })
  await settleFiber(oldFiber, settleMs)
  await tree.update(id, { disabled: null })
  const entry = tree.store[id]
  await settleFiber(fiberOf(entry), settleMs)
  return fiberStateOf(entry)
}

/** 在调用方的 await 链里重新加载一条（不是本插件自己的），操作条目树时抛错就记为 `failed` */
export async function remountNow(tree: EntryTreeLike, id: string, log: RemountLog, settleMs: number = SETTLE_MS): Promise<RemountedEntry> {
  try {
    const state = await remountEntry(tree, id, settleMs)
    log.info(`条目 ${id} 重新加载了：${state}`)
    return { id, action: 'remounted', state }
  } catch (err: unknown) {
    log.warn(`条目 ${id} 重新加载失败：${String(err)}`)
    return { id, action: 'failed', state: String(err) }
  }
}

/**
 * 本插件自己那条排到下一个宏任务里重新加载，接着按 `followingIds` 的先后逐条重新加载依赖本插件的包的条目，每条等前一条做完。
 * 闭包只持有条目树、id 与 logger：本插件重新加载之后旧实例的 ctx 不能用。一条失败只记 warn，接着处理下一条
 */
export function remountSelfLater(
  tree: EntryTreeLike,
  ownId: string,
  followingIds: readonly string[],
  log: RemountLog,
  schedule: Schedule = nextMacrotask,
  settleMs: number = SETTLE_MS,
): void {
  const describe = (id: string): string => (id === ownId ? `插件管理自己（${id}）` : `条目 ${id} `)
  schedule(() => {
    void (async () => {
      for (const id of [ownId, ...followingIds]) {
        try {
          log.info(`${describe(id)}重新加载了：${await remountEntry(tree, id, settleMs)}`)
        } catch (err: unknown) {
          log.warn(`${describe(id)}重新加载失败：${String(err)}`)
        }
      }
    })()
  })
}

function fiberOf(entry: unknown): unknown {
  return isRecord(entry) ? entry['fiber'] : undefined
}
