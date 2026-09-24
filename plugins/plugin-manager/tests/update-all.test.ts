import { describe, expect, it } from 'vitest'
import { fiberStateOf, settleFiber } from '../src/fiber.js'
import { assertOnlyPackagesInHome, planUpdateAll } from '../src/update-all.js'

/**
 * 一键热升级的计划：pnpm 参数、重新加载哪些条目、按什么顺序。fixture 照 uninstall.test 的样式——store 是
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

/** home 里没有哪个包的 peer 写了别的插件 */
const NO_MANIFESTS: ReadonlyMap<string, unknown> = new Map()

describe('planUpdateAll：一次 pnpm add，精确版本', () => {
  it('pnpm 参数是一次 add，每个包用 outdated 查到的版本号，不用 @latest 标签', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager', NO_MANIFESTS)
    expect(plan.pnpmArgs).toEqual(['add', `${COMMANDS}@0.2.2`, `${HELLO}@0.2.1`, `${MANAGER}@0.3.0`])
  })

  it('空清单：pnpmArgs 空、packages 空、自己不在里面', () => {
    const plan = planUpdateAll({}, store, 'home:plugin-manager', NO_MANIFESTS)
    expect(plan).toEqual({ pnpmArgs: [], packages: [], dependents: [], alreadyLatest: [], kernelManaged: [] })
  })
})

describe('planUpdateAll：内核包与 cordis 不升', () => {
  const KERNEL = '@godcreator/gwb-kernel-desktop'
  const withKernelManaged = {
    ...outdated,
    [KERNEL]: { current: '0.3.0', latest: '0.3.1' },
    cordis: { current: '4.0.0-rc.9', latest: '4.0.0-rc.10' },
  }

  it('过期清单里有它们：不进 pnpm 参数与 packages，列进 kernelManaged', () => {
    const plan = planUpdateAll(withKernelManaged, store, 'home:plugin-manager', NO_MANIFESTS)
    expect(plan.pnpmArgs).toEqual(['add', `${COMMANDS}@0.2.2`, `${HELLO}@0.2.1`, `${MANAGER}@0.3.0`])
    expect(plan.packages.map((p) => p.pkg)).not.toContain(KERNEL)
    expect(plan.packages.map((p) => p.pkg)).not.toContain('cordis')
    expect(plan.kernelManaged).toEqual([
      { pkg: KERNEL, from: '0.3.0', to: '0.3.1' },
      { pkg: 'cordis', from: '4.0.0-rc.9', to: '4.0.0-rc.10' },
    ])
  })

  it('only 点了它们的名也不升，照样列进 kernelManaged、不进 alreadyLatest', () => {
    const plan = planUpdateAll(withKernelManaged, store, 'home:plugin-manager', NO_MANIFESTS, [KERNEL, HELLO])
    expect(plan.pnpmArgs).toEqual(['add', `${HELLO}@0.2.1`])
    expect(plan.kernelManaged).toEqual([{ pkg: KERNEL, from: '0.3.0', to: '0.3.1' }])
    expect(plan.alreadyLatest).toEqual([])
  })

  it('only 没点它们：kernelManaged 是空的', () => {
    const plan = planUpdateAll(withKernelManaged, store, 'home:plugin-manager', NO_MANIFESTS, [HELLO])
    expect(plan.kernelManaged).toEqual([])
  })

  it('过期清单里只有它们：pnpmArgs 空、packages 空', () => {
    const plan = planUpdateAll({ [KERNEL]: { current: '0.3.0', latest: '0.3.1' } }, store, 'home:plugin-manager', NO_MANIFESTS)
    expect(plan.pnpmArgs).toEqual([])
    expect(plan.packages).toEqual([])
    expect(plan.kernelManaged).toEqual([{ pkg: KERNEL, from: '0.3.0', to: '0.3.1' }])
  })
})

describe('planUpdateAll：条目的先后与自己那条的标记', () => {
  const ZETA = '@x/gwb-zeta'

  it('包只按名排、包内条目照树里的先后，自己所在的包与自己那条都不挪；自己那条标 self', () => {
    const withZeta = fakeStore([entry({ id: 'zeta', pkg: ZETA, state: 2 }), ...Object.entries(store).map(([key, value]) => ({ key, value }))])
    const plan = planUpdateAll({ ...outdated, [ZETA]: { current: '1.0.0', latest: '1.0.1' } }, withZeta, 'home:plugin-manager', NO_MANIFESTS)
    expect(plan.packages.map((p) => p.pkg)).toEqual([COMMANDS, HELLO, MANAGER, ZETA])
    const manager = plan.packages[2]!
    expect(manager.entries.map((e) => e.id)).toEqual(['plugin-manager', 'plugin-manager-2'])
    expect(manager.entries.map((e) => e.self)).toEqual([true, false])
  })

  it('裸 id 与完整 entryId 都认得出自己', () => {
    for (const ownEntryId of ['plugin-manager', 'home:plugin-manager']) {
      const plan = planUpdateAll(outdated, store, ownEntryId, NO_MANIFESTS)
      expect(plan.packages.flatMap((p) => p.entries).filter((e) => e.self).map((e) => e.id)).toEqual(['plugin-manager'])
    }
  })

  it('自己不在清单里：没有哪条标 self', () => {
    const plan = planUpdateAll({ [HELLO]: outdated[HELLO] }, store, 'home:plugin-manager', NO_MANIFESTS)
    expect(plan.packages.flatMap((p) => p.entries).every((e) => !e.self)).toBe(true)
  })
})

describe('planUpdateAll：每条条目怎么处理', () => {
  it('停用的条目带 disabled——执行时保持停用，不重新加载', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager', NO_MANIFESTS)
    const hello = plan.packages.find((p) => p.pkg === HELLO)!
    expect(hello.entries).toEqual([
      { id: 'hello', disabled: false, self: false },
      { id: 'hello-2', disabled: true, self: false },
    ])
    expect(hello).toMatchObject({ from: '0.2.0', to: '0.2.1' })
  })

  it('装了包、一条条目都没有的照样升，entries 为空；分组条目不归任何包', () => {
    const plan = planUpdateAll({ ...outdated, '@x/gwb-tokens': { current: '0.0.5', latest: '0.0.6' } }, store, 'home:plugin-manager', NO_MANIFESTS)
    expect(plan.packages.find((p) => p.pkg === '@x/gwb-tokens')).toEqual({
      pkg: '@x/gwb-tokens',
      from: '0.0.5',
      to: '0.0.6',
      entries: [],
    })
    expect(plan.packages.flatMap((p) => p.entries.map((e) => e.id))).not.toContain('grp')
  })
})

describe('planUpdateAll：only 限定', () => {
  it('只升点了名的；点了名、不在过期清单里的（已是最新）进 alreadyLatest，不进 pnpm 参数', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager', NO_MANIFESTS, [HELLO, '@x/gwb-not-outdated'])
    expect(plan.pnpmArgs).toEqual(['add', `${HELLO}@0.2.1`])
    expect(plan.packages.map((p) => p.pkg)).toEqual([HELLO])
    expect(plan.alreadyLatest).toEqual(['@x/gwb-not-outdated'])
  })

  it('only 是空数组：什么都不升，也不是「全升」', () => {
    const plan = planUpdateAll(outdated, store, 'home:plugin-manager', NO_MANIFESTS, [])
    expect(plan.pnpmArgs).toEqual([])
    expect(plan.packages).toEqual([])
  })
})

describe('assertOnlyPackagesInHome：only 里的包名必须在 home 的 dependencies 里', () => {
  const homeDependencies = { [HELLO]: '^0.2.0', [COMMANDS]: '^0.2.0' }

  it('有不在 home 里的（多半拼错）：直接抛错，说出是哪几个', () => {
    expect(() => assertOnlyPackagesInHome([HELLO, '@x/gwb-helo', '@x/gwb-nope'], homeDependencies)).toThrow('@x/gwb-helo、@x/gwb-nope')
  })

  it('都在 home 里、给了空数组、没给 only：不抛', () => {
    expect(() => assertOnlyPackagesInHome([HELLO, COMMANDS], homeDependencies)).not.toThrow()
    expect(() => assertOnlyPackagesInHome([], homeDependencies)).not.toThrow()
    expect(() => assertOnlyPackagesInHome(undefined, homeDependencies)).not.toThrow()
  })
})

describe('planUpdateAll：peer 里写了被升级的包的插件一起重新加载', () => {
  const KERNEL = '@godcreator/gwb-kernel-desktop'
  const NOTES = '@x/gwb-notes'
  const BOARD = '@x/gwb-board'
  const LIB = '@x/gwb-lib'

  function plugin(peers: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { version: '1.0.0', keywords: ['gwb', 'gwb-plugin'], peerDependencies: { [KERNEL]: '^0.5.0', ...peers }, ...extra }
  }

  const dependentsStore = fakeStore([
    entry({ id: 'plugin-manager', pkg: MANAGER, state: 2 }),
    entry({ id: 'hello', pkg: HELLO, state: 2 }),
    entry({ id: 'notes', pkg: NOTES, state: 2 }),
    entry({ id: 'notes-off', pkg: NOTES, disabled: true }),
    entry({ id: 'board', pkg: BOARD, state: 2 }),
  ])

  it('peer 写了被升级的包：进 dependents，because 列出它 peer 的被升级包，条目照树里的先后；不进 pnpm 参数', () => {
    const manifests = new Map<string, unknown>([
      [HELLO, plugin({})],
      [NOTES, plugin({ [HELLO]: '^0.2.0', [COMMANDS]: '^0.2.0' })],
    ])
    const plan = planUpdateAll(outdated, dependentsStore, 'home:plugin-manager', manifests, [HELLO, COMMANDS])
    expect(plan.pnpmArgs).toEqual(['add', `${COMMANDS}@0.2.2`, `${HELLO}@0.2.1`])
    expect(plan.dependents).toEqual([
      {
        pkg: NOTES,
        because: [COMMANDS, HELLO],
        entries: [
          { id: 'notes', disabled: false, self: false },
          { id: 'notes-off', disabled: true, self: false },
        ],
      },
    ])
  })

  it('peer 写了跟着换目录的插件的也算（一层层往外找），because 写它 peer 的那个', () => {
    const manifests = new Map<string, unknown>([
      [NOTES, plugin({ [HELLO]: '^0.2.0' })],
      [BOARD, plugin({ [NOTES]: '^1.0.0' })],
    ])
    const plan = planUpdateAll(outdated, dependentsStore, 'home:plugin-manager', manifests, [HELLO])
    expect(plan.dependents.map((d) => [d.pkg, d.because])).toEqual([
      [NOTES, [HELLO]],
      [BOARD, [NOTES]],
    ])
  })

  it('本身就在升级的包、内核包与 cordis、不是插件的包、peer 没写被升级包的插件：都不算', () => {
    const manifests = new Map<string, unknown>([
      [COMMANDS, plugin({ [HELLO]: '^0.2.0' })],
      [KERNEL, plugin({ [HELLO]: '^0.2.0' })],
      [LIB, { version: '1.0.0', keywords: ['gwb'], peerDependencies: { [HELLO]: '^0.2.0' } }],
      [BOARD, plugin({ '@x/gwb-other': '^1.0.0' })],
      ['@x/gwb-ghost', undefined],
    ])
    const plan = planUpdateAll(outdated, dependentsStore, 'home:plugin-manager', manifests, [HELLO, COMMANDS])
    expect(plan.dependents).toEqual([])
  })

  it('可选的 peer 也算：装着就链到被升级的那一版', () => {
    const manifests = new Map<string, unknown>([[NOTES, plugin({ [HELLO]: '^0.2.0' }, { peerDependenciesMeta: { [HELLO]: { optional: true } } })]])
    const plan = planUpdateAll(outdated, dependentsStore, 'home:plugin-manager', manifests, [HELLO])
    expect(plan.dependents.map((d) => d.pkg)).toEqual([NOTES])
  })

  it('插件管理自己的 peer 写了被升级的包：它照包名排进 dependents，不挪到最后，自己那条条目标 self', () => {
    const ZETA = '@x/gwb-zeta'
    const manifests = new Map<string, unknown>([
      [MANAGER, plugin({ [COMMANDS]: '^0.2.0' })],
      [NOTES, plugin({ [COMMANDS]: '^0.2.0' })],
      [BOARD, plugin({ [COMMANDS]: '^0.2.0' })],
      [ZETA, plugin({ [COMMANDS]: '^0.2.0' })],
    ])
    const plan = planUpdateAll(outdated, dependentsStore, 'home:plugin-manager', manifests, [COMMANDS])
    expect(plan.dependents.map((d) => d.pkg)).toEqual([BOARD, NOTES, MANAGER, ZETA])
    expect(plan.dependents[2]).toEqual({ pkg: MANAGER, because: [COMMANDS], entries: [{ id: 'plugin-manager', disabled: false, self: true }] })
  })

  it('什么都不升：dependents 是空的', () => {
    const manifests = new Map<string, unknown>([[NOTES, plugin({ [HELLO]: '^0.2.0' })]])
    expect(planUpdateAll(outdated, dependentsStore, 'home:plugin-manager', manifests, []).dependents).toEqual([])
  })
})

describe('fiberStateOf：重新加载后到哪一步', () => {
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

describe('settleFiber：等 fiber 把手头的事做完，最多等到时限', () => {
  it('await 回来就回来；抛了也回来（状态另外读）', async () => {
    await expect(settleFiber({ await: () => Promise.resolve() }, 1000)).resolves.toBeUndefined()
    await expect(settleFiber({ await: () => Promise.reject(new Error('apply 抛了')) }, 1000)).resolves.toBeUndefined()
  })

  it('永远不结束的 await：到了时限就继续', async () => {
    const started = Date.now()
    await settleFiber({ await: () => new Promise(() => undefined) }, 20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('没有 fiber、没有 await 方法：立刻回来', async () => {
    await expect(settleFiber(undefined, 1000)).resolves.toBeUndefined()
    await expect(settleFiber({}, 1000)).resolves.toBeUndefined()
  })
})
