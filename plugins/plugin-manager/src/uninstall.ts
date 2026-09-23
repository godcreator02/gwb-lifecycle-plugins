import { readEntries } from './inventory.js'

/**
 * 卸载的**选择规则**：一个包在 `cordis.yml` 里的全部条目。纯函数，单独测。
 *
 * 条目与包的归属关系在 `options.name`（yml 里每条写着的包名）——`readEntries` 已经把它
 * 取成 `pkg` 字段，这里只做过滤。分组条目的 name 是 `cordis:group`，不会与真实包名重名，
 * `!group` 那个条件是为「万一有人手写出异常条目」做的防护。
 */

/** 这个包在条目树上的全部不带前缀的 id。空数组是合法情况——装了包、一条条目都没建 */
export function entriesForPackage(store: unknown, pkg: string): string[] {
  return readEntries(store)
    .filter((entry) => entry.pkg === pkg && !entry.group)
    .map((entry) => entry.id)
}
