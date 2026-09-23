import { describe, expect, it } from 'vitest'
import { readEntries, reconcile, toDependencies, toLabels, type EntrySnapshot } from '../src/inventory.js'

interface FakeEntry {
  key: string
  value: unknown
}

/** loader 条目树的 store 是 `Object.create(null)` 建的平表，键是不带前缀的 id */
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

describe('home 的 package.json 收窄', () => {
  it('只收 dependencies 里的字符串格', () => {
    expect(toDependencies({ dependencies: { a: '1.0.0', b: 2, c: '^0.1' } })).toEqual({ a: '1.0.0', c: '^0.1' })
  })

  it('没有 dependencies、不是对象、null 一律当空表——不抛', () => {
    for (const bad of [{}, { dependencies: [] }, null, 'nope', undefined]) {
      expect(toDependencies(bad)).toEqual({})
    }
  })
})

describe('显示名文档收窄', () => {
  it('坏的那格丢掉，不废掉整份', () => {
    expect(toLabels({ a: '命令总线', b: 3, c: '' })).toEqual({ a: '命令总线' })
  })

  it('整份坏了当没有', () => {
    expect(toLabels(['a'])).toEqual({})
    expect(toLabels(null)).toEqual({})
  })
})

describe('从条目树读快照', () => {
  it('键是不带前缀的 id，entryId 是完整的', () => {
    const [only] = readEntries(fakeStore([entry({ id: 'commands', pkg: '@x/gwb-commands', state: 2 })]))
    expect(only).toMatchObject({ id: 'commands', entryId: 'home:commands', pkg: '@x/gwb-commands' })
  })

  it('是否加载成功看的是 fiber 的状态，不是 fiber 在不在', () => {
    const rows = readEntries(
      fakeStore([
        entry({ id: 'a', pkg: 'p', state: 2 }),
        // inject 没满足：fiber 建出来了,但永远到不了 ACTIVE
        entry({ id: 'b', pkg: 'p', state: 1 }),
        entry({ id: 'c', pkg: 'p' }),
      ]),
    )
    expect(rows.map((r) => r.active)).toEqual([true, false, false])
  })

  it('停着的那条报 disabled', () => {
    const [only] = readEntries(fakeStore([entry({ id: 'a', pkg: 'p', disabled: true })]))
    expect(only?.disabled).toBe(true)
  })

  it('分组条目标出来——它是个分组，不是插件', () => {
    const [only] = readEntries(fakeStore([entry({ id: 'g', pkg: 'cordis:group', group: true })]))
    expect(only?.group).toBe(true)
  })

  it('形状对不上的那格跳过,不废掉整棵树', () => {
    const store = fakeStore([entry({ id: 'a', pkg: 'p', state: 2 })])
    store['broken'] = 'not an entry'
    expect(readEntries(store)).toHaveLength(1)
  })

  it('store 整个不是对象时回空数组', () => {
    expect(readEntries(undefined)).toEqual([])
    expect(readEntries('nope')).toEqual([])
  })
})

describe('包与条目对照', () => {
  const snapshot = (id: string, pkg: string): EntrySnapshot => ({
    id,
    entryId: `home:${id}`,
    pkg,
    disabled: false,
    active: true,
    group: false,
  })

  it('装了包也有条目：条目归到那个包底下', () => {
    const rows = reconcile({ '@x/gwb-commands': '0.0.3' }, [snapshot('commands', '@x/gwb-commands')], {})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pkg: '@x/gwb-commands', spec: '0.0.3', installed: true })
    expect(rows[0]?.entries).toHaveLength(1)
  })

  it('装了包但一条条目都没有：如实报 0 条，不推断原因', () => {
    const rows = reconcile({ '@x/gwb-shared-react': '1.0.0' }, [], {})
    expect(rows[0]).toMatchObject({ pkg: '@x/gwb-shared-react', installed: true })
    expect(rows[0]?.entries).toEqual([])
  })

  it('条目引着一个没装的包：报 installed false,不静默丢掉', () => {
    const rows = reconcile({}, [snapshot('ghost', '@x/gone')], {})
    expect(rows[0]).toMatchObject({ pkg: '@x/gone', installed: false })
    expect(rows[0]).not.toHaveProperty('spec')
    expect(rows[0]?.entries).toHaveLength(1)
  })

  it('同一个包的多条条目并在一起', () => {
    const rows = reconcile({ '@x/gwb-py-cli': '1' }, [snapshot('py-311', '@x/gwb-py-cli'), snapshot('py-312', '@x/gwb-py-cli')], {})
    expect(rows).toHaveLength(1)
    expect(rows[0]?.entries.map((e) => e.id)).toEqual(['py-311', 'py-312'])
  })

  it('显示名按不带前缀的 id 对上，没设过就没有这个字段', () => {
    const rows = reconcile({ p: '1' }, [snapshot('a', 'p'), snapshot('b', 'p')], { a: '甲' })
    expect(rows[0]?.entries[0]).toMatchObject({ id: 'a', label: '甲' })
    expect(rows[0]?.entries[1]).not.toHaveProperty('label')
  })

  it('按包名排序,界面上位置稳定', () => {
    const rows = reconcile({ zeta: '1', alpha: '1' }, [], {})
    expect(rows.map((r) => r.pkg)).toEqual(['alpha', 'zeta'])
  })
})
