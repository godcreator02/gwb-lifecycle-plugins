import { describe, expect, it } from 'vitest'
import { fiberStateOf, planUpdateAll, settleFiber } from '../src/update-all.js'

/**
 * 一键热升的计划：pnpm 参数与重挂顺序。fixture 照 uninstall.test 的样式——store 是
 * `Object.create(null)` 的平表，包名在 `options.name`，停用在 `disabled`。
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

const HELLO = '@x/gwb-hello'
const MANAGER = '@x/gwb-plugin-manager'
const COMMANDS = '@x/gwb-commands'

const store = fakeStore([
  entry({ id: 'plugin-manager', pkg: MANAGER, state: 2 }),
  entry({ id: 'hello', pkg: HELLO, state: 2 }),
  entry({ id: 'hello-2', pkg: HELLO, disabled: true }),
  entry({ id: 'commands', pkg: COMMANDS, state: 2 }),
  entry({ id: 'plugin-manager-2', pkg: MANAGER, state: 2 }),
  entry({ id: 'grp', pkg: 'cordis:group', group: true }),
])

const outdated = {
  [MANAGER]: { current: '0.2.1', latest: '0.3.0' },
  [HELLO]: { current: '0.2.0', latest: '0.2.1' },
  [COMMANDS]: { current: '0.2.0', latest: '0.2.2' },
}

describe('planUpdateAll：一趟 pnpm，精确版本', () => {
  it('pnpm 参数是一趟 add，每个包钉 outdated 回的 latest——不是 @latest 标签', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager')
    expect(plan.pnpmArgs).toEqual(['add', `${COMMANDS}@0.2.2`, `${HELLO}@0.2.1`, `${MANAGER}@0.3.0`])
  })

  it('空清单：pnpmArgs 空、packages 空、自己不在里面', () => {
    const plan = planUpdateAll({}, store, 'home:plugin-manager')
    expect(plan).toEqual({ pnpmArgs: [], packages: [], selfIncluded: false, ignored: [] })
  })
})

describe('planUpdateAll：重挂顺序，自己最后', () => {
  it('包按名排、自己所在的包挪到最后；包内自己那条条目也在最后', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager')
    expect(plan.packages.map((p) => p.pkg)).toEqual([COMMANDS, HELLO, MANAGER])
    expect(plan.selfIncluded).toBe(true)
    const self = plan.packages[2]!
    expect(self.self).toBe(true)
    // plugin-manager-2 在树里排在 plugin-manager 后面，但自己那条得让到最后
    expect(self.entries.map((e) => e.id)).toEqual(['plugin-manager-2', 'plugin-manager'])
    expect(self.entries.map((e) => e.self)).toEqual([false, true])
  })

  it('裸 id 与完整 entryId 都认得出自己', () => {
    expect(planUpdateAll(outdated, store, 'plugin-manager').selfIncluded).toBe(true)
    expect(planUpdateAll(outdated, store, 'home:plugin-manager').selfIncluded).toBe(true)
  })

  it('自己不在清单里：selfIncluded 假、没有哪条标 self', () => {
    const plan = planUpdateAll({ [HELLO]: outdated[HELLO] }, store, 'home:plugin-manager')
    expect(plan.selfIncluded).toBe(false)
    expect(plan.packages.flatMap((p) => p.entries).every((e) => !e.self)).toBe(true)
  })
})

describe('planUpdateAll：每条条目怎么处置', () => {
  it('停用着的条目带 disabled 标——执行时保持停用，不重挂', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager')
    const hello = plan.packages.find((p) => p.pkg === HELLO)!
    expect(hello.entries).toEqual([
      { id: 'hello', disabled: false, self: false },
      { id: 'hello-2', disabled: true, self: false },
    ])
    expect(hello).toMatchObject({ from: '0.2.0', to: '0.2.1', self: false })
  })

  it('装了包一条条目都没挂的（共享包）照样升，entries 空；分组条目不归任何包', () => {
    const plan = planUpdateAll({ ...outdated, '@x/gwb-tokens': { current: '0.0.5', latest: '0.0.6' } }, store, 'home:plugin-manager')
    expect(plan.packages.find((p) => p.pkg === '@x/gwb-tokens')).toEqual({
      pkg: '@x/gwb-tokens',
      from: '0.0.5',
      to: '0.0.6',
      entries: [],
      self: false,
    })
    expect(plan.packages.flatMap((p) => p.entries.map((e) => e.id))).not.toContain('grp')
  })
})

describe('planUpdateAll：only 限定', () => {
  it('只升点了名的；点了名却不在过期清单里的进 ignored，不进 pnpm 参数', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager', [HELLO, '@x/gwb-not-outdated'])
    expect(plan.pnpmArgs).toEqual(['add', `${HELLO}@0.2.1`])
    expect(plan.packages.map((p) => p.pkg)).toEqual([HELLO])
    expect(plan.ignored).toEqual(['@x/gwb-not-outdated'])
    expect(plan.selfIncluded).toBe(false)
  })

  it('only 是空数组：什么都不升，也不是「全升」', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager', [])
    expect(plan.pnpmArgs).toEqual([])
    expect(plan.packages).toEqual([])
  })
})

describe('fiberStateOf：重挂后到哪一步', () => {
  it('照 cordis FiberState 的原名报', () => {
    expect(fiberStateOf({ fiber: { state: 2 } })).toBe('ACTIVE')
    expect(fiberStateOf({ fiber: { state: 0 } })).toBe('PENDING')
    expect(fiberStateOf({ fiber: { state: 3 } })).toBe('FAILED')
  })

  it('停用、没 fiber、认不出的数字、根本不是条目——各说各的', () => {
    expect(fiberStateOf({ disabled: true, fiber: { state: 2 } })).toBe('disabled')
    expect(fiberStateOf({ fiber: undefined })).toContain('no fiber')
    expect(fiberStateOf({ fiber: { state: 42 } })).toBe('state=42')
    expect(fiberStateOf(undefined)).toBe('no entry')
  })
})

describe('settleFiber：等 fiber 把手头的事做完，到点就走', () => {
  it('await 回来就回来；抛了也回来（状态另外读）', async () => {
    await expect(settleFiber({ await: () => Promise.resolve() }, 1000)).resolves.toBeUndefined()
    await expect(settleFiber({ await: () => Promise.reject(new Error('apply 抛了')) }, 1000)).resolves.toBeUndefined()
  })

  it('永远不回来的 await 到点就走', async () => {
    const started = Date.now()
    await settleFiber({ await: () => new Promise(() => undefined) }, 20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('没有 fiber、没有 await 方法：立刻回来', async () => {
    await expect(settleFiber(undefined, 1000)).resolves.toBeUndefined()
    await expect(settleFiber({}, 1000)).resolves.toBeUndefined()
  })
})
