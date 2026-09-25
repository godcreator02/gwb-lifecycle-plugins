import type { GwbContext } from '@godcreator/gwb-kernel-desktop'
// 只取类型：loader 的 EntryTree，以及它给 cordis 的 Fiber 补上的 entry 字段；产物与 d.ts 里都没有这个包名
import type { EntryTree } from '@cordisjs/plugin-loader'
import { isRecord } from './vocab.js'

/**
 * loader 的 `EntryTree` 收窄到用得着的几样。`treeOf` 把 loader 的树直接赋给它，loader 改了签名类型检查就在那里失败。
 * create / remove / update 写回 yml 推迟到下一个宏任务：返回时磁盘上还是旧的，别读回 yml 核对
 */
export interface EntryTreeLike {
  /** 不带前缀的 id → Entry 的表，不分层。同一棵树里的分组也在这张表上，没有嵌套 */
  store: Record<string, unknown>
  /** 加一条：写回 yml + 立即加载。`parent` 给 null 就是放在 yml 顶层 */
  create(options: Record<string, unknown>, parent?: string | null): Promise<string>
  /** 删除一条 + 写回 yml */
  remove(id: string): void
  /** 改 options + 写回 yml。值给 null 是**删掉那个字段** */
  update(id: string, options: Record<string, unknown>): Promise<void>
}

export function asTree(candidate: unknown): EntryTreeLike {
  if (!isRecord(candidate)) {
    throw new Error('取不到承载 cordis.yml 的条目树——这个插件只能通过 cordis.yml 里的条目加载，不能被别的插件直接 ctx.plugin 加载。')
  }
  return candidate as unknown as EntryTreeLike
}

/** 在构造时调用：那时 `this.ctx` 还是本插件自己的，方法里的 `this.ctx` 是调用方的 */
export function treeOf(ctx: GwbContext): EntryTreeLike {
  const loaderTree: EntryTree | undefined = ctx.fiber.entry?.parent.tree
  const narrowed: EntryTreeLike | undefined = loaderTree
  return asTree(narrowed)
}

/** 本插件自己那条条目的完整 id */
export function ownEntryId(ctx: GwbContext): string {
  const id = ctx.fiber.entry?.id
  if (id === undefined || id === '') {
    throw new Error('取不到自己那条条目的 id——这个插件只能通过 cordis.yml 里的条目加载。')
  }
  return id
}
