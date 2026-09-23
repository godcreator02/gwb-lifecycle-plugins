import { readEntries } from './inventory.js'

/**
 * 卸载的**选择规则**：一个包在 `cordis.yml` 里的全部条目。纯函数，单独测。
 *
 * 条目与包的归属关系在 `options.name`（yml 里每条写着的包名）——`readEntries` 已经把它
 * 摊成 `pkg` 字段，这儿只做过滤。分组条目的 name 是 `cordis:group`，跟真包名撞不上，
 * `!group` 那半是给「万一有人手写出怪条目」兜的底。
 */

/** 这个包在条目树上的全部裸 id。空数组是合法形态——装了包、一条条目都没挂 */
export function entriesForPackage(store: unknown, pkg: string): string[] {
  return readEntries(store)
    .filter((entry) => entry.pkg === pkg && !entry.group)
    .map((entry) => entry.id)
}
