import { isRecord } from './vocab.js'
import type { EntryTreeLike } from './tree.js'
import { fiberStateOf, settleFiber } from './update-all.js'

/**
 * 条目重新加载：停用 → 等旧 fiber 卸载完 → 启用 → 等新 fiber 启动完。一键热升级与 `remount` 命令
 * 共用这一套时序。
 *
 * **重新加载由不会被这次重新加载卸掉的代码一次做完**，停用与启用之间不经过第二条命令：
 *
 * - 目标是别的条目（包括命令总线）：在调用方的 await 链里做完。这条链只持有条目树与 logger，
 *   不经任何 ctx、不经总线，总线的 fiber 被卸载不影响它继续执行
 * - 目标是本插件自己：处理器里停用自己，这条链随本插件的 fiber 一起被卸载、回执到不了调用方。
 *   所以先回 `deferred`，下一个宏任务再重新加载
 */

/** 停用/启用之后等 fiber 把手头的事做完，最多等这么久。超时就继续，读到什么状态报什么 */
export const SETTLE_MS = 5_000

/** 一条条目重新加载的结果 */
export interface RemountedEntry {
  /** 不带前缀的 id */
  id: string
  /**
   * `remounted`：停用再启用，重新 import 了新版本；`skipped`：本来就停用，保持停用（只在一键热升级里出现）；
   * `deferred`：本插件自己那条，回执发出之后才重新加载；`failed`：操作条目树时抛错，`state` 里是那句错误
   */
  action: 'remounted' | 'skipped' | 'deferred' | 'failed'
  /** 重新加载之后 fiber 到哪一步（ACTIVE / PENDING / FAILED…）。skipped 是 disabled，deferred 是动手前的状态 */
  state: string
}

/** 重新加载要用的两个日志级别。传入的是事先拿到的 logger——本插件重新加载自己时 ctx 上的东西都不能用 */
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
 * 停用 → 等旧 fiber 卸载完 → 启用（`_init` 重新 `tree.import`，拿到新版本）→ 等新 fiber 启动完，
 * 返回它的状态。**等旧的卸载完再启用**：loader 的 `update({ disabled: true })` 调 `fiber.dispose()`
 * 不等它完成，而 Service 插件的 provide 是在卸载过程中撤销的——不等就启用，新 fiber 启动时旧服务
 * 可能还没撤销，cordis 会报「service has been registered」。原本停用的条目，最终状态是启用
 */
export async function remountEntry(tree: EntryTreeLike, id: string, settleMs: number = SETTLE_MS): Promise<string> {
  const old = fiberOf(tree.store[id])
  await tree.update(id, { disabled: true })
  await settleFiber(old, settleMs)
  await tree.update(id, { disabled: null })
  const entry = tree.store[id]
  await settleFiber(fiberOf(entry), settleMs)
  return fiberStateOf(entry)
}

/** 在调用方的 await 链里重新加载一条（不是本插件自己的），操作条目树时抛错就记为 `failed` */
export async function remountNow(tree: EntryTreeLike, id: string, log: RemountLog, settleMs: number = SETTLE_MS): Promise<RemountedEntry> {
  try {
    const state = await remountEntry(tree, id, settleMs)
    log.info(`条目 ${id} 重挂了：${state}`)
    return { id, action: 'remounted', state }
  } catch (err: unknown) {
    log.warn(`条目 ${id} 重挂没成：${String(err)}`)
    return { id, action: 'failed', state: String(err) }
  }
}

/**
 * 本插件自己那条：排到下一个宏任务里重新加载，当下立刻返回。闭包只持有条目树、id 与 logger；
 * `after` 在重新加载完之后执行（一键热升级用它做整页重载）
 */
export function remountSelfLater(
  tree: EntryTreeLike,
  id: string,
  log: RemountLog,
  after?: () => Promise<void>,
  schedule: Schedule = nextMacrotask,
  settleMs: number = SETTLE_MS,
): void {
  schedule(() => {
    void remountEntry(tree, id, settleMs)
      .then(async (state) => {
        log.info(`本件自己（${id}）重挂了：${state}`)
        if (after !== undefined) await after()
      })
      .catch((err: unknown) => {
        log.warn(`本件自己（${id}）重挂没成：${String(err)}`)
      })
  })
}

/**
 * `remount` 命令的处理：`id` 与 `ownId` 都是不带前缀的 id。是本插件自己就回 `deferred`（`state` 是动手前的），
 * 别的一律在这条链里做完
 */
export function remountOne(
  tree: EntryTreeLike,
  id: string,
  ownId: string,
  log: RemountLog,
  schedule: Schedule = nextMacrotask,
  settleMs: number = SETTLE_MS,
): Promise<RemountedEntry> {
  if (id !== ownId) return remountNow(tree, id, log, settleMs)
  const state = fiberStateOf(tree.store[id])
  remountSelfLater(tree, id, log, undefined, schedule, settleMs)
  log.info(`本件自己（${id}）回执之后重挂`)
  return Promise.resolve({ id, action: 'deferred', state })
}

function fiberOf(entry: unknown): unknown {
  return isRecord(entry) ? entry['fiber'] : undefined
}
