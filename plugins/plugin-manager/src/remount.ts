import { isRecord } from './vocab.js'
import type { EntryTreeLike } from './tree.js'
import { fiberStateOf, settleFiber } from './update-all.js'

/**
 * 条目重挂：停用 → 等旧 fiber 拆完 → 启用 → 等新 fiber 起完。一键热升与 `remount` 命令
 * 共用这一份时序。
 *
 * **重挂由活得过重挂的代码一次做完**，停用与启用之间不经过第二条命令：
 *
 * - 目标是别的条目（包括命令总线）：在调用方的 await 链里做完。这条链只持条目树与 logger，
 *   不经任何 ctx、不经总线，总线的 fiber 被拆掉不影响它往下走
 * - 目标是本件自己：处理器里停用自己，这条链随本件的 fiber 一起拆掉、回执到不了调用方。
 *   所以先回 `deferred`，下一个宏任务再重挂
 */

/** 停用/启用之后等 fiber 把手头的事做完，最多等这么久。到点就走，读到什么状态报什么 */
export const SETTLE_MS = 5_000

/** 一条条目重挂的去向 */
export interface RemountedEntry {
  /** 裸 id */
  id: string
  /**
   * `remounted`：停用再启用，重 import 了新版本；`skipped`：本来就停用，保持停用（只在一键热升里出现）；
   * `deferred`：本件自己那条，回执发出之后才重挂；`failed`：动条目树时抛了，`state` 里是那句错
   */
  action: 'remounted' | 'skipped' | 'deferred' | 'failed'
  /** 重挂之后 fiber 到哪一步（ACTIVE / PENDING / FAILED…）。skipped 是 disabled，deferred 是动手前的状态 */
  state: string
}

/** 重挂要的两级嗓门。传的是早就攥在手里的 logger——本件自己重挂时 ctx 上什么都不能碰 */
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
 * 停用 → 等旧 fiber 拆完 → 启用（`_init` 重新 `tree.import`，拿到新版本）→ 等新 fiber 起完，
 * 回它的状态。**等旧的拆完再启用**：loader 的 `update({ disabled: true })` 调 `fiber.dispose()`
 * 不等它，而 Service 件的 provide 是在卸载那趟里撤的——不等就启用，新 fiber 起来时旧服务
 * 可能还没撤，cordis 会报「service has been registered」。本来停用的条目，终态是启用
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

/** 在调用方的 await 链里重挂一条（不是本件自己的），动树时抛了收成 `failed` */
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
 * 本件自己那条：排到下一个宏任务里重挂，当下立刻回。闭包只持条目树、id 与 logger；
 * `after` 在重挂完之后跑（一键热升拿它做整页重载）
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
 * `remount` 命令那一趟：`id` 与 `ownId` 都是裸 id。是本件自己就回 `deferred`（`state` 是动手前的），
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
