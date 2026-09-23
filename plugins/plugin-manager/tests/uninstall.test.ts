import { describe, expect, it } from 'vitest'
import { entriesForPackage } from '../src/uninstall.js'

/**
 * 卸载的选择规则：一个包在条目树上的全部条目。fixture 照 inventory.test 的样式——
 * store 是 `Object.create(null)` 的平表，包名在 `options.name`。
 */

interface FakeEntry {
  key: string
  value: unknown
}

function fakeStore(entries: readonly FakeEntry[]): Record<string, unknown> {
  const store = Object.create(null) as Record<string, unknown>
  for (const item of entries) store[item.key] = item.value
  return store
}

function entry(opts: { id: string; pkg: string; state?: number; disabled?: boolean; group?: boolean }): FakeEntry {
  return {
    key: opts.id,
    value: {
      id: `home:${opts.id}`,
      options: { id: opts.id, name: opts.pkg, group: opts.group },
      fiber: opts.state === undefined ? undefined : { state: opts.state },
      disabled: opts.disabled ?? false,
    },
  }
}

describe('entriesForPackage：卸载摘哪些条目', () => {
  it('同包多条全归一堆——卸载是包级动作，漏一条就留一个 ghost', () => {
    const ids = entriesForPackage(
      fakeStore([
        entry({ id: 'hello', pkg: '@x/gwb-hello', state: 2 }),
        entry({ id: 'hello-2', pkg: '@x/gwb-hello', disabled: true }),
        entry({ id: 'logger', pkg: '@x/gwb-logger', state: 2 }),
      ]),
      '@x/gwb-hello',
    )
    expect(ids).toEqual(['hello', 'hello-2'])
  })

  it('停用没停用、挂上没挂上，都不影响归属——摘的是条目，不是「活着的条目」', () => {
    const ids = entriesForPackage(
      fakeStore([
        entry({ id: 'a', pkg: 'p' }),
        entry({ id: 'b', pkg: 'p', state: 2 }),
        entry({ id: 'c', pkg: 'p', disabled: true, state: 2 }),
      ]),
      'p',
    )
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('回的是裸 id——tree.remove 认的那一个', () => {
    const [only] = entriesForPackage(fakeStore([entry({ id: 'shell', pkg: '@x/gwb-shell', state: 2 })]), '@x/gwb-shell')
    expect(only).toBe('shell')
  })

  it('没挂条目的包回空数组——装了包、一条没挂，卸载照样走（只卸包那半）', () => {
    expect(entriesForPackage(fakeStore([entry({ id: 'logger', pkg: '@x/gwb-logger' })]), '@x/gwb-hello')).toEqual([])
  })

  it('没有 name 的条目、分组条目（name 是 cordis:group）、形状坏的格，一概不归到任何真包名下', () => {
    const store = fakeStore([
      { key: 'no-name', value: { id: 'home:no-name', options: { id: 'no-name' } } },
      entry({ id: 'grp', pkg: 'cordis:group', group: true }),
      { key: 'broken', value: 42 },
    ])
    expect(entriesForPackage(store, 'cordis:group')).toEqual([])
    expect(entriesForPackage(store, '@x/gwb-hello')).toEqual([])
    // 空串查询会撞上「没有 name 的条目」（pkg 兜底是 ''）——生产路上 assertPkgName
    // 早把空包名拦了，到不了这儿；钉下这个事实，免得有人拿它当 bug 修
    expect(entriesForPackage(store, '')).toEqual(['no-name'])
  })

  it('store 不是对象也回空数组，不抛——跟 readEntries 同一个底', () => {
    for (const bad of [null, undefined, 'nope', 42] as unknown[]) {
      expect(entriesForPackage(bad, 'p')).toEqual([])
    }
  })
})
