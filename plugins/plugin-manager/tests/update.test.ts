import { describe, expect, it } from 'vitest'
import { fiberStateOf, settleFiber } from '../src/fiber.js'
import { assertOnlyNotKernelManaged, assertOnlyPackagesInHome, planOutdatedUpdate, planSpecsUpdate, plannedDependents, versionChangesAfterAdd } from '../src/update.js'

/**
 * `update` 的计划：pnpm 参数、重新加载哪些条目、按什么顺序。fixture 照 uninstall.test 的样式——store 是
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

describe('planOutdatedUpdate：一次 pnpm add，精确版本', () => {
  it('pnpm 参数是一次 add，每个包用 outdated 查到的版本号，不用 @latest 标签', () => {
    const plan = planOutdatedUpdate(outdated, store, 'home:plugin-manager')
    expect(plan.pnpmArgs).toEqual(['add', `${COMMANDS}@0.2.2`, `${HELLO}@0.2.1`, `${MANAGER}@0.3.0`])
  })

  it('空清单：pnpmArgs 空、packages 空、自己不在里面', () => {
    const plan = planOutdatedUpdate({}, store, 'home:plugin-manager')
    expect(plan).toEqual({ pnpmArgs: [], packages: [], alreadyLatest: [] })
  })
})

describe('assertOnlyNotKernelManaged：内核包与 cordis 热升级不了', () => {
  const KERNEL = '@godcreator/gwb-kernel-desktop'

  it('only 点了它们的名：抛错、说出是哪几个、指向 update-kernel', () => {
    expect(() => assertOnlyNotKernelManaged([HELLO, KERNEL, 'cordis'])).toThrow(`only 里的 ${KERNEL}、cordis 由内核决定版本`)
    expect(() => assertOnlyNotKernelManaged([KERNEL])).toThrow('plugin-manager.update-kernel')
  })

  it('only 没点它们：不抛', () => {
    expect(() => assertOnlyNotKernelManaged([HELLO])).not.toThrow()
  })
})

describe('planOutdatedUpdate：条目的先后与自己那条的标记', () => {
  const ZETA = '@x/gwb-zeta'

  it('包只按名排、包内条目照树里的先后，自己所在的包与自己那条都不挪；自己那条标 self', () => {
    const withZeta = fakeStore([entry({ id: 'zeta', pkg: ZETA, state: 2 }), ...Object.entries(store).map(([key, value]) => ({ key, value }))])
    const plan = planOutdatedUpdate({ ...outdated, [ZETA]: { current: '1.0.0', latest: '1.0.1' } }, withZeta, 'home:plugin-manager')
    expect(plan.packages.map((p) => p.pkg)).toEqual([COMMANDS, HELLO, MANAGER, ZETA])
    const manager = plan.packages[2]!
    expect(manager.entries.map((e) => e.id)).toEqual(['plugin-manager', 'plugin-manager-2'])
    expect(manager.entries.map((e) => e.self)).toEqual([true, false])
  })

  it('裸 id 与完整 entryId 都认得出自己', () => {
    for (const ownEntryId of ['plugin-manager', 'home:plugin-manager']) {
      const plan = planOutdatedUpdate(outdated, store, ownEntryId)
      expect(plan.packages.flatMap((p) => p.entries).filter((e) => e.self).map((e) => e.id)).toEqual(['plugin-manager'])
    }
  })

  it('自己不在清单里：没有哪条标 self', () => {
    const plan = planOutdatedUpdate({ [HELLO]: outdated[HELLO] }, store, 'home:plugin-manager')
    expect(plan.packages.flatMap((p) => p.entries).every((e) => !e.self)).toBe(true)
  })
})

describe('planOutdatedUpdate：每条条目怎么处理', () => {
  it('停用的条目带 disabled——执行时保持停用，不重新加载', () => {
    const plan = planOutdatedUpdate(outdated, store, 'home:plugin-manager')
    const hello = plan.packages.find((p) => p.pkg === HELLO)!
    expect(hello.entries).toEqual([
      { id: 'hello', disabled: false, self: false },
      { id: 'hello-2', disabled: true, self: false },
    ])
    expect(hello).toMatchObject({ from: '0.2.0', to: '0.2.1' })
  })

  it('装了包、一条条目都没有的照样升，entries 为空；分组条目不归任何包', () => {
    const plan = planOutdatedUpdate({ ...outdated, '@x/gwb-tokens': { current: '0.0.5', latest: '0.0.6' } }, store, 'home:plugin-manager')
    expect(plan.packages.find((p) => p.pkg === '@x/gwb-tokens')).toEqual({
      pkg: '@x/gwb-tokens',
      from: '0.0.5',
      to: '0.0.6',
      entries: [],
    })
    expect(plan.packages.flatMap((p) => p.entries.map((e) => e.id))).not.toContain('grp')
  })
})

describe('planOutdatedUpdate：only 限定', () => {
  it('只升点了名的；点了名、不在过期清单里的（已是最新）进 alreadyLatest，不进 pnpm 参数', () => {
    const plan = planOutdatedUpdate(outdated, store, 'home:plugin-manager', [HELLO, '@x/gwb-not-outdated'])
    expect(plan.pnpmArgs).toEqual(['add', `${HELLO}@0.2.1`])
    expect(plan.packages.map((p) => p.pkg)).toEqual([HELLO])
    expect(plan.alreadyLatest).toEqual(['@x/gwb-not-outdated'])
  })

  it('only 是空数组：什么都不升，也不是「全升」', () => {
    const plan = planOutdatedUpdate(outdated, store, 'home:plugin-manager', [])
    expect(plan.pnpmArgs).toEqual([])
    expect(plan.packages).toEqual([])
  })
})

describe('assertOnlyPackagesInHome：only 里的包名必须在 home 的 dependencies 里', () => {
  const homeDependencies = { [HELLO]: '^0.2.0', [COMMANDS]: '^0.2.0' }

  it('有不在 home 里的（多半拼错）：直接抛错，说出是哪几个', () => {
    expect(() => assertOnlyPackagesInHome([HELLO, '@x/gwb-helo', '@x/gwb-nope'], homeDependencies)).toThrow('@x/gwb-helo、@x/gwb-nope')
  })

  it('都在 home 里、给了空数组：不抛', () => {
    expect(() => assertOnlyPackagesInHome([HELLO, COMMANDS], homeDependencies)).not.toThrow()
    expect(() => assertOnlyPackagesInHome([], homeDependencies)).not.toThrow()
  })
})

describe('planSpecsUpdate：给已装的包按给定写法装', () => {
  const KERNEL = '@godcreator/gwb-kernel-desktop'
  const homeDependencies = { [HELLO]: '^0.2.0', [MANAGER]: '^0.2.0', [KERNEL]: '0.6.0', cordis: '4.0.0-rc.10' }

  it('每项 <包名>@<写法> 原样交给 pnpm，按包名排；条目照树里的先后、自己那条标 self；没有内核包', () => {
    const plan = planSpecsUpdate({ [MANAGER]: 'file:D:/repo/pm.tgz', [HELLO]: '0.2.1-dev.3' }, homeDependencies, store, 'home:plugin-manager')
    expect(plan.addSpecs).toEqual([`${HELLO}@0.2.1-dev.3`, `${MANAGER}@file:D:/repo/pm.tgz`])
    expect(plan.packages).toEqual([
      {
        pkg: HELLO,
        entries: [
          { id: 'hello', disabled: false, self: false },
          { id: 'hello-2', disabled: true, self: false },
        ],
      },
      {
        pkg: MANAGER,
        entries: [
          { id: 'plugin-manager', disabled: false, self: true },
          { id: 'plugin-manager-2', disabled: false, self: false },
        ],
      },
    ])
    expect(plan.includesKernel).toBe(false)
  })

  it('有内核包（可以连同 cordis）：includesKernel 为真', () => {
    const plan = planSpecsUpdate({ [KERNEL]: '0.6.1-dev.1', cordis: '4.0.0-rc.11', [HELLO]: 'latest' }, homeDependencies, store, 'home:plugin-manager')
    expect(plan.includesKernel).toBe(true)
    expect(plan.addSpecs).toEqual([`${KERNEL}@0.6.1-dev.1`, `${HELLO}@latest`, 'cordis@4.0.0-rc.11'])
  })

  it('包不在 home 的 dependencies 里：直接抛错，说出是哪几个、指向 install', () => {
    expect(() => planSpecsUpdate({ [HELLO]: '0.2.1', '@x/gwb-new': '1.0.0' }, homeDependencies, store, 'home:plugin-manager')).toThrow(
      'specs 里的 @x/gwb-new 不在 home 的 package.json 的 dependencies 里',
    )
    expect(() => planSpecsUpdate({ '@x/gwb-new': '1.0.0' }, homeDependencies, store, 'home:plugin-manager')).toThrow('plugin-manager.install')
  })

  it('只给 cordis 不给内核包：直接抛错，指向 update-kernel', () => {
    expect(() => planSpecsUpdate({ cordis: '4.0.0-rc.11' }, homeDependencies, store, 'home:plugin-manager')).toThrow('plugin-manager.update-kernel')
  })

  it('包名或写法不合规：直接抛错', () => {
    expect(() => planSpecsUpdate({ [HELLO]: '-r' }, homeDependencies, store, 'home:plugin-manager')).toThrow('不合规')
    expect(() => planSpecsUpdate({ [HELLO]: '0.2.1 --force' }, homeDependencies, store, 'home:plugin-manager')).toThrow('不合规')
    expect(() => planSpecsUpdate({ '-r': '1.0.0' }, homeDependencies, store, 'home:plugin-manager')).toThrow('包名 "-r" 不合规')
  })
})

describe('versionChangesAfterAdd：回执里的 from / to 取装之前与装之后读到的版本号', () => {
  it('装之前读不到的没有 from；to 是装完读到的版本号（准确版本号对上了、tag 不核对）', () => {
    const result = versionChangesAfterAdd(
      { [HELLO]: '0.2.1-dev.3', [MANAGER]: 'latest' },
      new Map([
        [HELLO, '0.2.0'],
        [MANAGER, undefined],
      ]),
      new Map([
        [HELLO, '0.2.1-dev.3'],
        [MANAGER, '0.3.0'],
      ]),
    )
    expect(result).toEqual({
      ok: true,
      changes: new Map([
        [HELLO, { from: '0.2.0', to: '0.2.1-dev.3' }],
        [MANAGER, { to: '0.3.0' }],
      ]),
    })
  })

  it('装完读不到某个包的版本号：ok false，说出是哪几个', () => {
    const result = versionChangesAfterAdd({ [HELLO]: '0.2.1', [MANAGER]: '1.0.0' }, new Map(), new Map([[HELLO, '0.2.1']]))
    expect(result).toEqual({ ok: false, error: `pnpm add 退出码 0，但装完读不到 ${MANAGER} 在 home 的 node_modules 里的 package.json 的 version` })
  })

  it('写法是准确版本号、装上的不是它：ok false，逐项说出要的与装上的', () => {
    const result = versionChangesAfterAdd(
      { [HELLO]: '0.2.1', [MANAGER]: '0.3.0-dev.2', '@x/gwb-ok': '1.0.0' },
      new Map(),
      new Map([
        [HELLO, '0.2.2-dev.1'],
        [MANAGER, '0.3.0-dev.1'],
        ['@x/gwb-ok', '1.0.0'],
      ]),
    )
    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain(`${HELLO} 是 0.2.2-dev.1，要的是 0.2.1`)
    expect(error).toContain(`${MANAGER} 是 0.3.0-dev.1，要的是 0.3.0-dev.2`)
    expect(error).not.toContain('@x/gwb-ok')
  })

  it('file: 与 tag 写法不核对：装上什么就报什么', () => {
    const result = versionChangesAfterAdd({ [HELLO]: 'file:D:/repo/hello.tgz', [MANAGER]: 'dev' }, new Map(), new Map([
      [HELLO, '0.2.1-dev.9'],
      [MANAGER, '0.3.0-dev.4'],
    ]))
    expect(result).toEqual({
      ok: true,
      changes: new Map([
        [HELLO, { to: '0.2.1-dev.9' }],
        [MANAGER, { to: '0.3.0-dev.4' }],
      ]),
    })
  })
})

describe('plannedDependents：pnpm add 前后真实目录变了、本身没升级的包跟着重新加载', () => {
  const NOTES = '@x/gwb-notes'
  const BOARD = '@x/gwb-board'
  const PLAIN = '@x/gwb-plain'

  const dependentsStore = fakeStore([
    entry({ id: 'plugin-manager', pkg: MANAGER, state: 2 }),
    entry({ id: 'hello', pkg: HELLO, state: 2 }),
    entry({ id: 'notes', pkg: NOTES, state: 2 }),
    entry({ id: 'notes-off', pkg: NOTES, disabled: true }),
    entry({ id: 'board', pkg: BOARD, state: 2 }),
    entry({ id: 'plain', pkg: PLAIN, state: 2 }),
    entry({ id: 'grp', pkg: 'cordis:group', group: true }),
  ])

  const before = new Map<string, string | undefined>([
    [HELLO, 'D:/h/node_modules/.pnpm/hello@0.2.0/node_modules/@x/gwb-hello'],
    [NOTES, 'D:/h/node_modules/.pnpm/notes@1.0.0_hello@0.2.0/node_modules/@x/gwb-notes'],
    [BOARD, 'D:/h/node_modules/.pnpm/board@1.0.0_notes@1.0.0_hello@0.2.0/node_modules/@x/gwb-board'],
    [PLAIN, 'D:/h/node_modules/.pnpm/plain@1.0.0/node_modules/@x/gwb-plain'],
  ])
  const after = new Map<string, string | undefined>([
    [HELLO, 'D:/h/node_modules/.pnpm/hello@0.2.1/node_modules/@x/gwb-hello'],
    [NOTES, 'D:/h/node_modules/.pnpm/notes@1.0.0_hello@0.2.1/node_modules/@x/gwb-notes'],
    [BOARD, 'D:/h/node_modules/.pnpm/board@1.0.0_notes@1.0.0_hello@0.2.1/node_modules/@x/gwb-board'],
    [PLAIN, 'D:/h/node_modules/.pnpm/plain@1.0.0/node_modules/@x/gwb-plain'],
  ])

  it('目录变了、本身没升级的包进 dependents，按包名排，条目照树里的先后（停用的带 disabled）；升级了的包与目录没变的不算', () => {
    expect(plannedDependents(before, after, [HELLO], dependentsStore, 'home:plugin-manager')).toEqual([
      { pkg: BOARD, entries: [{ id: 'board', disabled: false, self: false }] },
      {
        pkg: NOTES,
        entries: [
          { id: 'notes', disabled: false, self: false },
          { id: 'notes-off', disabled: true, self: false },
        ],
      },
    ])
  })

  it('装之前读不到、装之后读得到（或反过来）也算目录变了；一条条目都没有的包 entries 为空，分组条目不归任何包', () => {
    const missingBefore = new Map(before).set(PLAIN, undefined)
    expect(plannedDependents(missingBefore, after, [HELLO, NOTES, BOARD], dependentsStore, 'home:plugin-manager')).toEqual([
      { pkg: PLAIN, entries: [{ id: 'plain', disabled: false, self: false }] },
    ])
    const tokens = '@x/gwb-tokens'
    const withTokens = new Map(after).set(tokens, 'D:/h/node_modules/.pnpm/tokens@0.0.6/node_modules/@x/gwb-tokens')
    expect(plannedDependents(before, withTokens, [HELLO, NOTES, BOARD], dependentsStore, 'home:plugin-manager')).toEqual([{ pkg: tokens, entries: [] }])
  })

  it('插件管理自己的目录变了：它照包名排进 dependents，自己那条条目标 self', () => {
    const managerBefore = new Map(before).set(MANAGER, 'D:/h/node_modules/.pnpm/pm@0.10.0_hello@0.2.0/node_modules/@x/gwb-plugin-manager')
    const managerAfter = new Map(after).set(MANAGER, 'D:/h/node_modules/.pnpm/pm@0.10.0_hello@0.2.1/node_modules/@x/gwb-plugin-manager')
    const dependents = plannedDependents(managerBefore, managerAfter, [HELLO], dependentsStore, 'home:plugin-manager')
    expect(dependents.map((d) => d.pkg)).toEqual([BOARD, NOTES, MANAGER])
    expect(dependents[2]).toEqual({ pkg: MANAGER, entries: [{ id: 'plugin-manager', disabled: false, self: true }] })
  })

  it('哪个包的目录都没变：dependents 是空的', () => {
    expect(plannedDependents(before, new Map(before), [], dependentsStore, 'home:plugin-manager')).toEqual([])
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
