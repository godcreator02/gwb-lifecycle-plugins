import type { GwbContext } from '@godcreator/gwb-plugin-api'
import { isRecord } from './vocab.js'

/**
 * 承载 `cordis.yml` 的那棵条目树。
 *
 * **改 cordis.yml 只有这一条路，不许自己写文件。** loader 把「磁盘上的 yml」与「内存里
 * 已加载的条目」绑在一起：`tree.create` 一次做完——把 options 放进 group、写回 yml、
 * 立即加载。绕过它自己写 yml，内存里的那份不知道，改动要等下次重启才生效，而
 * 中间任何一次 `write()` 都会用旧的内存状态把磁盘上的覆盖回去。
 *
 * **写入磁盘推迟到下一个宏任务**：include 插件的 `write()` 只排一个 `setTimeout(0)`，序列化
 * 的是那时的内存状态。所以这几个方法返回时磁盘上还是旧的——**别在调用之后读回 yml
 * 去「确认改成了」**，那样读到的必然是上一版。内存里的条目树才是当前的真实状态。
 */

/** 收窄到用得着的那几样。不依赖 `@cordisjs/plugin-loader`，按运行时形状取 */
export interface EntryTreeLike {
  /** 不带前缀的 id → Entry 的表，不分层。同一棵树里的分组也在这张表上，没有嵌套 */
  store: Record<string, unknown>
  /** 加一条：写回 yml + 立即加载。`parent` 给 null 就是放在 yml 顶层 */
  create(options: Record<string, unknown>, parent?: string | null, position?: number): Promise<string>
  /** 删除一条 + 写回 yml */
  remove(id: string): void
  /** 改 options + 写回 yml。值给 null 是**删掉那个字段** */
  update(id: string, options: Record<string, unknown>, parent?: string | null, position?: number): Promise<void>
  /** 取一条。**只认不带前缀的 id**——传入完整 entryId 会直接抛错 */
  resolve(id: string): unknown
}

/** 那四个方法都在才算一棵树。少一个就立即说清楚——比后面某一步莫名其妙地失败好排查 */
export function asTree(candidate: unknown): EntryTreeLike {
  if (!isRecord(candidate)) {
    throw new Error('取不到承载 cordis.yml 的条目树——这个件只能经 cordis.yml 挂上，不能被别的件直接 ctx.plugin 进来。')
  }
  for (const key of ['create', 'remove', 'update', 'resolve']) {
    if (typeof candidate[key] !== 'function') {
      throw new Error(`条目树上没有 ${key}()——loader 的面变了，这个件要跟着改。`)
    }
  }
  return candidate as unknown as EntryTreeLike
}

/**
 * 本插件所在的那棵树。
 *
 * `ctx.fiber.entry.parent` 是 `EntryGroup`，它的 `tree` 就是承载 `cordis.yml` 的那个
 * Include 实例。**这么取不需要硬编码**——不用知道内核那条 include 条目叫 `home`
 * （那是内核的 `ENTRY_ROOT` 常量，插件不该依赖它）。
 *
 * `fiber.entry` 是 loader 加上去的字段、不在 cordis 本体的类型定义里，所以按运行时形状取、
 * 不改全局类型声明（`gwb-data` 与 `gwb-settings` 的 `owner()` 用的是同一个写法）。
 *
 * **在构造时取**：那时 `this.ctx` 还是提供方自己的；方法里的 `this.ctx` 是调用方的，
 * 从那里取会拿到别人的条目。
 */
export function treeOf(ctx: GwbContext): EntryTreeLike {
  const fiber = ctx.fiber as unknown as { entry?: { parent?: { tree?: unknown } } } | undefined
  return asTree(fiber?.entry?.parent?.tree)
}

/** 本插件自己那条条目的完整 id。取不到就抛——身份取不到的话后面每一步都没有依据 */
export function ownEntryId(ctx: GwbContext): string {
  const fiber = ctx.fiber as unknown as { entry?: { id?: unknown } } | undefined
  const id = fiber?.entry?.id
  if (typeof id !== 'string' || id === '') {
    throw new Error('取不到自己那条条目的 id——这个件只能经 cordis.yml 挂上。')
  }
  return id
}
