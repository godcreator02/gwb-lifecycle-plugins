import { readEntries } from './inventory.js'

/** 这个包在条目树上的全部不带前缀的 id；空数组是合法情况（装了包、一条条目都没建）。分组条目不算，防手写的异常条目 */
export function entriesForPackage(store: unknown, pkg: string): string[] {
  return readEntries(store)
    .filter((entry) => entry.pkg === pkg && !entry.group)
    .map((entry) => entry.id)
}
