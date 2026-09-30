import { describe, expect, it } from 'vitest'
import { fiberStateOf, settleFiber } from '../src/fiber.js'
import {
  assertOnlyNotKernelManaged,
  assertOnlyPackagesInHome,
  deferredAfterSelf,
  deferredEntryIdsOf,
  packageRemountingSelf,
  packagesToRemount,
  peerCycleNote,
  peerNamesOf,
  planOutdatedUpdate,
  planSpecsUpdate,
  remountOrderOf,
  versionChangesAfterAdd,
} from '../src/update.js'

/**
 * `update` 装之前的计划（pnpm 参数与回执里的版本）与装之后按真实目录定下的重新加载对象。fixture 照 uninstall.test 的样式——store 是
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

const outdated = {
  [MANAGER]: { current: '0.2.1', latest: '0.3.0' },
  [HELLO]: { current: '0.2.0', latest: '0.2.1' },
  [COMMANDS]: { current: '0.2.0', latest: '0.2.2' },
}

describe('planOutdatedUpdate：一次 pnpm add，精确版本', () => {
  it('pnpm add 的每一项用 outdated 查到的版本号，不用 @latest 标签；回执里的 from / to 按包名排', () => {
    const plan = planOutdatedUpdate(outdated)
    expect(plan.addSpecs).toEqual([`${COMMANDS}@0.2.2`, `${HELLO}@0.2.1`, `${MANAGER}@0.3.0`])
    expect([...plan.versionChanges]).toEqual([
      [COMMANDS, { from: '0.2.0', to: '0.2.2' }],
      [HELLO, { from: '0.2.0', to: '0.2.1' }],
      [MANAGER, { from: '0.2.1', to: '0.3.0' }],
    ])
  })

  it('空清单：addSpecs 空、versionChanges 空', () => {
    expect(planOutdatedUpdate({})).toEqual({ addSpecs: [], versionChanges: new Map(), alreadyLatest: [] })
  })
})

describe('assertOnlyNotKernelManaged：内核包与 cordis 热升级不了', () => {
  const KERNEL = '@godcreator/gwb-kernel-desktop'

  it('only 点了它们的名：抛错、说出是哪几个、指向 specs 写法', () => {
    expect(() => assertOnlyNotKernelManaged([HELLO, KERNEL, 'cordis'])).toThrow(`only 里的 ${KERNEL}、cordis 由内核决定版本`)
    expect(() => assertOnlyNotKernelManaged([KERNEL])).toThrow(`plugin-manager.update {"specs":{"${KERNEL}"`)
  })

  it('only 没点它们：不抛', () => {
    expect(() => assertOnlyNotKernelManaged([HELLO])).not.toThrow()
  })
})

describe('planOutdatedUpdate：only 限定', () => {
  it('只升点了名的；点了名、不在过期清单里的（已是最新）进 alreadyLatest，不进 addSpecs', () => {
    const plan = planOutdatedUpdate(outdated, [HELLO, '@x/gwb-not-outdated'])
    expect(plan.addSpecs).toEqual([`${HELLO}@0.2.1`])
    expect([...plan.versionChanges.keys()]).toEqual([HELLO])
    expect(plan.alreadyLatest).toEqual(['@x/gwb-not-outdated'])
  })

  it('only 是空数组：什么都不升，也不是「全升」', () => {
    const plan = planOutdatedUpdate(outdated, [])
    expect(plan.addSpecs).toEqual([])
    expect(plan.versionChanges.size).toBe(0)
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

  it('每项 <包名>@<写法> 原样交给 pnpm，按包名排；没有内核包', () => {
    const plan = planSpecsUpdate({ [MANAGER]: 'file:D:/repo/pm.tgz', [HELLO]: '0.2.1-dev.3' }, homeDependencies)
    expect(plan).toEqual({ addSpecs: [`${HELLO}@0.2.1-dev.3`, `${MANAGER}@file:D:/repo/pm.tgz`], pkgs: [HELLO, MANAGER], includesKernel: false })
  })

  it('有内核包：includesKernel 为真', () => {
    const plan = planSpecsUpdate({ [KERNEL]: '0.6.1-dev.1', [HELLO]: 'latest' }, homeDependencies)
    expect(plan.includesKernel).toBe(true)
    expect(plan.addSpecs).toEqual([`${KERNEL}@0.6.1-dev.1`, `${HELLO}@latest`])
  })

  it('包不在 home 的 dependencies 里：直接抛错，说出是哪几个、指向 install', () => {
    expect(() => planSpecsUpdate({ [HELLO]: '0.2.1', '@x/gwb-new': '1.0.0' }, homeDependencies)).toThrow('specs 里的 @x/gwb-new 不在 home 的 package.json 的 dependencies 里')
    expect(() => planSpecsUpdate({ '@x/gwb-new': '1.0.0' }, homeDependencies)).toThrow('plugin-manager.install')
  })

  it('写了 cordis（带不带内核包都一样）：直接抛错，cordis 由插件管理照装上的内核包对齐', () => {
    expect(() => planSpecsUpdate({ cordis: '4.0.0-rc.11' }, homeDependencies)).toThrow('specs 里不写 cordis')
    expect(() => planSpecsUpdate({ [KERNEL]: '0.6.1', cordis: '4.0.0-rc.11' }, homeDependencies)).toThrow('specs 里不写 cordis')
  })

  it('包名或写法不合规：直接抛错', () => {
    expect(() => planSpecsUpdate({ [HELLO]: '-r' }, homeDependencies)).toThrow('不合规')
    expect(() => planSpecsUpdate({ [HELLO]: '0.2.1 --force' }, homeDependencies)).toThrow('不合规')
    expect(() => planSpecsUpdate({ '-r': '1.0.0' }, homeDependencies)).toThrow('包名 "-r" 不合规')
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

describe('packagesToRemount：pnpm add 前后真实目录变了的包都重新加载，点了名的归 updated、其余归 dependents', () => {
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

  it('点了名、目录变了的进 updated；没点名、目录变了的进 dependents，按包名排，条目照树里的先后（停用的带 disabled）；目录没变的不算', () => {
    expect(packagesToRemount(before, after, [HELLO], dependentsStore, 'home:plugin-manager')).toEqual({
      updated: [{ pkg: HELLO, entries: [{ id: 'hello', disabled: false, self: false }] }],
      dependents: [
        { pkg: BOARD, entries: [{ id: 'board', disabled: false, self: false }] },
        {
          pkg: NOTES,
          entries: [
            { id: 'notes', disabled: false, self: false },
            { id: 'notes-off', disabled: true, self: false },
          ],
        },
      ],
    })
  })

  it('点了名、目录没变的（装的就是原来那一版）：照样列进 updated，但 entries 为空、不重新加载', () => {
    expect(packagesToRemount(before, new Map(before), [PLAIN], dependentsStore, 'home:plugin-manager')).toEqual({
      updated: [{ pkg: PLAIN, entries: [] }],
      dependents: [],
    })
  })

  it('装之前读不到、装之后读得到（或反过来）也算目录变了；一条条目都没有的包 entries 为空，分组条目不归任何包', () => {
    const missingBefore = new Map(before).set(PLAIN, undefined)
    expect(packagesToRemount(missingBefore, after, [HELLO, NOTES, BOARD], dependentsStore, 'home:plugin-manager').dependents).toEqual([
      { pkg: PLAIN, entries: [{ id: 'plain', disabled: false, self: false }] },
    ])
    const tokens = '@x/gwb-tokens'
    const withTokens = new Map(after).set(tokens, 'D:/h/node_modules/.pnpm/tokens@0.0.6/node_modules/@x/gwb-tokens')
    expect(packagesToRemount(before, withTokens, [HELLO, NOTES, BOARD], dependentsStore, 'home:plugin-manager').dependents).toEqual([{ pkg: tokens, entries: [] }])
  })

  it('插件管理自己的目录变了：照包名排，不挪位置，自己那条条目标 self；裸 id 与完整 entryId 都认得出自己', () => {
    const managerBefore = new Map(before).set(MANAGER, 'D:/h/node_modules/.pnpm/pm@0.10.0_hello@0.2.0/node_modules/@x/gwb-plugin-manager')
    const managerAfter = new Map(after).set(MANAGER, 'D:/h/node_modules/.pnpm/pm@0.10.0_hello@0.2.1/node_modules/@x/gwb-plugin-manager')
    for (const ownEntryId of ['plugin-manager', 'home:plugin-manager']) {
      const { dependents } = packagesToRemount(managerBefore, managerAfter, [HELLO], dependentsStore, ownEntryId)
      expect(dependents.map((d) => d.pkg)).toEqual([BOARD, NOTES, MANAGER])
      expect(dependents[2]).toEqual({ pkg: MANAGER, entries: [{ id: 'plugin-manager', disabled: false, self: true }] })
    }
  })

  it('哪个包都没点名、目录都没变：两份都是空的', () => {
    expect(packagesToRemount(before, new Map(before), [], dependentsStore, 'home:plugin-manager')).toEqual({ updated: [], dependents: [] })
  })
})

describe('peerNamesOf：装上后清单里 peerDependencies 的包名', () => {
  it('读不到清单、没写 peer、写法不是对象：空表；写了就是全部键', () => {
    expect(peerNamesOf(undefined)).toEqual([])
    expect(peerNamesOf({ name: HELLO })).toEqual([])
    expect(peerNamesOf({ peerDependencies: 'x' })).toEqual([])
    expect(peerNamesOf({ peerDependencies: { [COMMANDS]: '^0.2.0', cordis: '4.0.0-rc.10' } })).toEqual([COMMANDS, 'cordis'])
  })
})

describe('remountOrderOf：一批要重新加载的包按 peer 排先后', () => {
  const CORE = '@godcreator/gwb-bn-core'
  const COMMENT = '@godcreator/gwb-bn-comment'
  const QUERY = '@godcreator/gwb-bn-query'
  const JOURNAL = '@godcreator/gwb-bn-journal'
  const PROPS = '@godcreator/gwb-bn-props'
  const SINGLE = '@godcreator/gwb-bn-single'
  const PAPERS = '@godcreator/gwb-bn-papers'
  const KERNEL = '@godcreator/gwb-kernel-desktop'
  const BUS = '@godcreator/gwb-commands'

  it('块笔记那一批：点了名的四个与跟着重新加载的三个合在一起排，被依赖的先、同一层按包名', () => {
    const peersOf = new Map([
      [CORE, [KERNEL, BUS]],
      [COMMENT, [KERNEL, CORE]],
      [QUERY, [KERNEL, CORE]],
      [JOURNAL, [KERNEL, CORE]],
      [PROPS, [KERNEL, CORE]],
      [SINGLE, [KERNEL, CORE]],
      [PAPERS, [KERNEL, CORE, PROPS]],
    ])
    const order = remountOrderOf([COMMENT, CORE, JOURNAL, QUERY, PAPERS, PROPS, SINGLE], peersOf)
    expect(order).toEqual({ ordered: [CORE, COMMENT, JOURNAL, PROPS, QUERY, SINGLE, PAPERS], cycles: [], heldBack: [] })
  })

  it('互不依赖的包在同一层：按包名，不按给的先后', () => {
    expect(remountOrderOf(['@x/c', '@x/a', '@x/b'], new Map()).ordered).toEqual(['@x/a', '@x/b', '@x/c'])
  })

  it('这批之外的 peer 不影响先后；自己写自己不算环', () => {
    const peersOf = new Map([
      ['@x/a', ['@x/outside', '@x/b']],
      ['@x/b', ['@x/outside', '@x/b']],
    ])
    expect(remountOrderOf(['@x/a', '@x/b'], peersOf)).toEqual({ ordered: ['@x/b', '@x/a'], cycles: [], heldBack: [] })
  })

  it('peer 成环：环上的与传递地依赖环的挑出来不排、环按 peer 方向从包名最小的起；其余照排', () => {
    const peersOf = new Map([
      ['@x/a', ['@x/b']],
      ['@x/b', ['@x/a']],
      ['@x/c', ['@x/a']],
      ['@x/e', ['@x/c']],
      ['@x/x', ['@x/y']],
      ['@x/y', ['@x/z']],
      ['@x/z', ['@x/x']],
      ['@x/free', []],
      ['@x/after-free', ['@x/free']],
    ])
    const order = remountOrderOf(['@x/e', '@x/c', '@x/b', '@x/a', '@x/z', '@x/y', '@x/x', '@x/after-free', '@x/free'], peersOf)
    expect(order.ordered).toEqual(['@x/free', '@x/after-free'])
    expect(order.heldBack).toEqual(['@x/a', '@x/b', '@x/c', '@x/e', '@x/x', '@x/y', '@x/z'])
    expect(order.cycles).toEqual([
      ['@x/a', '@x/b', '@x/a'],
      ['@x/x', '@x/y', '@x/z', '@x/x'],
    ])
  })

  it('peerCycleNote：写出每个环、这次没重新加载的包、重启后才生效、反方向改用局部注入', () => {
    const note = peerCycleNote([['@x/a', '@x/b', '@x/a']], ['@x/a', '@x/b', '@x/c'])
    expect(note).toContain('peer 成环：@x/a → @x/b → @x/a')
    expect(note).toContain('这次没有重新加载 @x/a、@x/b、@x/c')
    expect(note).toContain('重启工作台后才换成新装的版本')
    expect(note).toContain('<上下文>.inject([...], fn)')
  })
})

describe('deferredAfterSelf：插件管理自己与传递地 peer 了它的包推迟到回执之后', () => {
  const PM = '@godcreator/gwb-plugin-manager'
  const BASEUI = '@godcreator/gwb-baseui'
  const DEVKIT = '@godcreator/gwb-devkit'
  const SHELL = '@godcreator/gwb-shell'
  const CORE = '@godcreator/gwb-bn-core'
  const COMMENT = '@godcreator/gwb-bn-comment'
  const PANE = '@x/gwb-some-pane'
  const peersOf = new Map([
    [PM, [COMMANDS]],
    [BASEUI, [PM, SHELL]],
    [DEVKIT, [PM, COMMANDS]],
    [CORE, [SHELL]],
    [COMMENT, [CORE]],
    [PANE, [BASEUI]],
  ])
  const batch = [PM, BASEUI, DEVKIT, CORE, COMMENT, PANE]

  it('插件管理、baseui、devkit 与块笔记一起升级：块笔记在命令里重新加载，其余按依赖顺序在回执之后，插件管理最前', () => {
    const { ordered } = remountOrderOf(batch, peersOf)
    expect(ordered).toEqual([CORE, PM, BASEUI, COMMENT, DEVKIT, PANE])
    expect(deferredAfterSelf(ordered, peersOf, PM)).toEqual({ now: [CORE, COMMENT], afterReceipt: [PM, BASEUI, DEVKIT, PANE] })
  })

  it('这次不重新加载插件管理自己：全部在命令里', () => {
    const { ordered } = remountOrderOf(batch, peersOf)
    expect(deferredAfterSelf(ordered, peersOf, undefined)).toEqual({ now: ordered, afterReceipt: [] })
  })

  it('packageRemountingSelf 与 deferredEntryIdsOf：自己那条（启用着的）所在的包；推迟的条目自己在最前、停用的不算', () => {
    const planned = [
      { pkg: BASEUI, entries: [{ id: 'baseui', disabled: false, self: false }, { id: 'baseui-off', disabled: true, self: false }] },
      { pkg: PM, entries: [{ id: 'pm-second', disabled: false, self: false }, { id: 'plugin-manager', disabled: false, self: true }] },
      { pkg: DEVKIT, entries: [{ id: 'devkit', disabled: false, self: false }] },
    ]
    expect(packageRemountingSelf(planned)).toBe(PM)
    expect(deferredEntryIdsOf([PM, BASEUI, DEVKIT], planned)).toEqual(['plugin-manager', 'pm-second', 'baseui', 'devkit'])
    expect(packageRemountingSelf([{ pkg: PM, entries: [{ id: 'plugin-manager', disabled: true, self: true }] }])).toBeUndefined()
    expect(packageRemountingSelf([{ pkg: PM, entries: [] }])).toBeUndefined()
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
