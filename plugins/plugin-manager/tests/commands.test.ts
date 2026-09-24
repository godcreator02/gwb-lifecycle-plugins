import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GwbResult } from '@godcreator/gwb-plugin-api'
import type { EntryTreeLike } from '../src/tree.js'

/**
 * 命令这一层：在假 ctx 上运行 `apply`，按命令名调登记下来的处理函数。条目树、数据插件、设置插件、命令插件都是假的；
 * pnpm 换成记录参数的假实现（真 pnpm 会去网络上装包），找 pnpm、跑 pnpm 之外的部分都是真代码。
 */

interface PnpmCall {
  args: readonly string[]
  cwd: string
}

const fakePnpm = vi.hoisted(() => ({
  calls: [] as PnpmCall[],
  runExitCode: 0,
  captureExitCode: 0 as number | null,
  captureStdout: '{}',
  afterRun: undefined as ((args: readonly string[]) => void) | undefined,
}))

vi.mock('../src/pnpm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pnpm.js')>()
  return {
    ...actual,
    locatePnpm: () => ({ ok: true, file: 'fake-pnpm.exe', version: '0.0.0' }),
    runPnpm: (opts: { pnpm: string; cwd: string; args: readonly string[] }) => {
      fakePnpm.calls.push({ args: opts.args, cwd: opts.cwd })
      fakePnpm.afterRun?.(opts.args)
      return Promise.resolve(fakePnpm.runExitCode === 0 ? { ok: true, exitCode: 0 } : { ok: false, exitCode: fakePnpm.runExitCode, tail: 'pnpm 说的原因' })
    },
    runPnpmCapture: (opts: { pnpm: string; cwd: string; args: readonly string[] }) => {
      fakePnpm.calls.push({ args: opts.args, cwd: opts.cwd })
      return Promise.resolve({ exitCode: fakePnpm.captureExitCode, stdout: fakePnpm.captureStdout, stderrTail: '' })
    },
  }
})

const { apply } = await import('../src/index.js')

const OWN_PKG = '@godcreator/gwb-plugin-manager'
const ACTIVE = 2

interface FakeEntry {
  id: string
  options: Record<string, unknown>
  disabled?: boolean
  fiber?: { state: number; await: () => Promise<void> }
}

interface FakeTree extends EntryTreeLike {
  store: Record<string, FakeEntry>
  failUpdateFor: Set<string>
}

function activeFiber(): { state: number; await: () => Promise<void> } {
  return { state: ACTIVE, await: () => Promise.resolve() }
}

function fakeTree(entries: Record<string, string>): FakeTree {
  const store = Object.create(null) as Record<string, FakeEntry>
  const add = (options: Record<string, unknown>): void => {
    const id = String(options['id'])
    store[id] = { id: `home:${id}`, options, fiber: activeFiber() }
  }
  for (const [id, pkg] of Object.entries(entries)) add({ id, name: pkg })
  const failUpdateFor = new Set<string>()
  return {
    store,
    failUpdateFor,
    create: (options) => {
      add(options)
      return Promise.resolve(`home:${String(options['id'])}`)
    },
    remove: (id) => {
      delete store[id]
    },
    resolve: (id) => store[id],
    update: (id, options) => {
      if (failUpdateFor.has(id)) return Promise.reject(new Error(`cannot update ${id}`))
      const entry = store[id]
      if (entry === undefined) return Promise.reject(new Error(`cannot resolve entry ${id}`))
      if (options['disabled'] === true) {
        entry.disabled = true
        delete entry.fiber
      } else if (options['disabled'] === null) {
        delete entry.disabled
        entry.fiber = activeFiber()
      }
      return Promise.resolve()
    },
  }
}

interface FakeDataPlugin {
  docs: Record<string, unknown>
  ownerRecords: Record<string, string>
  transfers: [string, string][]
  readDoc(doc: string): Promise<unknown>
  writeDoc(doc: string, value: unknown): Promise<void>
  owners(): Record<string, string>
  transferOwner(id: string, pkg: string): Promise<void>
}

function fakeDataPlugin(ownerRecords: Record<string, string> = {}): FakeDataPlugin {
  const plugin: FakeDataPlugin = {
    docs: {},
    ownerRecords,
    transfers: [],
    readDoc: (doc) => Promise.resolve(plugin.docs[doc]),
    writeDoc: (doc, value) => {
      plugin.docs[doc] = value
      return Promise.resolve()
    },
    owners: () => plugin.ownerRecords,
    transferOwner: (id, pkg) => {
      plugin.transfers.push([id, pkg])
      return Promise.resolve()
    },
  }
  return plugin
}

type Handler = (args?: unknown) => unknown

interface Mounted {
  tree: FakeTree
  logs: string[]
  run(name: string, args?: unknown): Promise<unknown>
  shellReloads: number
}

let homeDir = ''

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function writeHomeDependencies(dependencies: Record<string, string>): void {
  writeJson(path.join(homeDir, 'package.json'), { dependencies })
}

function writeInstalledManifest(pkg: string, manifest: Record<string, unknown>): void {
  writeJson(path.join(homeDir, 'node_modules', ...pkg.split('/'), 'package.json'), manifest)
}

function mount(opts: { entries: Record<string, string>; data?: FakeDataPlugin; settings?: FakeDataPlugin; shellReload?: boolean }): Mounted {
  const tree = fakeTree({ 'plugin-manager': OWN_PKG, ...opts.entries })
  const logs: string[] = []
  const handlers = new Map<string, Handler>()
  const mounted: Mounted = {
    tree,
    logs,
    shellReloads: 0,
    run: (name, args) => {
      const handler = handlers.get(name)
      if (handler === undefined) throw new Error(`没有登记 ${name}`)
      return Promise.resolve().then(() => handler(args))
    },
  }
  const commandNames = (): { name: string }[] => [...handlers.keys(), ...(opts.shellReload === true ? ['shell.reload'] : [])].map((name) => ({ name }))
  const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`warn ${m}`), error: (m: string) => logs.push(`error ${m}`), debug: () => undefined }
  const ctx: Record<string, unknown> = {
    gwbKernel: { dataDir: homeDir, version: '0.2.7' },
    fiber: { entry: { id: 'home:plugin-manager', parent: { tree } } },
    logger: () => logger,
    effect: (fn: () => unknown) => {
      fn()
      return () => undefined
    },
    provide: () => () => undefined,
    inject: (names: string[], callback: (scoped: unknown) => void) => {
      if (names.every((serviceName) => ctx[serviceName] !== undefined)) callback(ctx)
      return () => undefined
    },
    gwbCommands: {
      register: (def: { name: string }, handler: Handler) => {
        handlers.set(def.name, handler)
        return () => undefined
      },
      list: commandNames,
      run: (name: string): Promise<GwbResult> => {
        if (name === 'shell.reload') {
          mounted.shellReloads += 1
          return Promise.resolve({ ok: true })
        }
        return Promise.resolve({ ok: false, error: `没有这条命令：${name}` })
      },
    },
    gwbData: opts.data,
    gwbSettings: opts.settings,
  }
  apply(ctx as never)
  return mounted
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-commands-'))
  fakePnpm.calls = []
  fakePnpm.runExitCode = 0
  fakePnpm.captureExitCode = 0
  fakePnpm.captureStdout = '{}'
  fakePnpm.afterRun = undefined
})

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('plugin-manager.list', () => {
  it('包与条目两层对上，带内核测试状态与没满足的要求；条目指向没装的包报 installed: false', async () => {
    writeHomeDependencies({ '@x/gwb-a': '^1.0.0' })
    writeInstalledManifest('@x/gwb-a', { version: '1.2.0', gwb: { testedKernel: '0.2.1', requires: { '@x/gwb-b': '1.0.0' } } })
    writeInstalledManifest('@x/gwb-b', { version: '0.9.0' })
    const pm = mount({ entries: { a: '@x/gwb-a', ghost: '@x/gwb-ghost' } })
    const listed = (await pm.run('plugin-manager.list')) as { pkg: string }[]
    expect(listed.find((view) => view.pkg === '@x/gwb-a')).toEqual({
      pkg: '@x/gwb-a',
      spec: '^1.0.0',
      installed: true,
      entries: [{ id: 'a', entryId: 'home:a', pkg: '@x/gwb-a', disabled: false, active: true, group: false }],
      testedKernel: '0.2.1',
      kernelUntested: false,
      requires: { '@x/gwb-b': '1.0.0' },
      unmetRequires: [{ pkg: '@x/gwb-b', required: '1.0.0', installed: '0.9.0' }],
    })
    expect(listed.find((view) => view.pkg === '@x/gwb-ghost')).toEqual({
      pkg: '@x/gwb-ghost',
      installed: false,
      entries: [{ id: 'ghost', entryId: 'home:ghost', pkg: '@x/gwb-ghost', disabled: false, active: true, group: false }],
      kernelUntested: true,
      unmetRequires: [],
    })
    expect(listed.map((view) => view.pkg)).toEqual([...listed.map((view) => view.pkg)].sort((a, b) => a.localeCompare(b)))
  })
})

describe('条目命令', () => {
  it('add-entry：没装的包抛错；装了的包按默认 id 加，重名加后缀，磁盘上属于别的包的 id 跳过', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0', '@x/gwb-bar': '^1.0.0' })
    const pm = mount({ entries: {}, data: fakeDataPlugin({ bar: '@y/bar' }) })
    await expect(pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-nope' })).rejects.toThrow('home 里没装 @x/gwb-nope')
    expect(await pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo' })).toEqual({ ok: true, data: { entryId: 'home:foo' } })
    expect(await pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo' })).toEqual({ ok: true, data: { entryId: 'home:foo-2' } })
    expect(await pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-bar' })).toEqual({ ok: true, data: { entryId: 'home:bar-2' } })
    expect(pm.tree.store['foo']?.options).toEqual({ id: 'foo', name: '@x/gwb-foo' })
    await expect(pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo', id: 'foo' })).rejects.toThrow('已经被占用')
    await expect(pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo', id: 'bar' })).rejects.toThrow('归 @y/bar')
  })

  it('add-entry 带 config：原样放进条目的 options', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0' })
    const pm = mount({ entries: {} })
    await pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo', id: 'custom', config: { a: 1 } })
    expect(pm.tree.store['custom']?.options).toEqual({ id: 'custom', name: '@x/gwb-foo', config: { a: 1 } })
  })

  it('remove-entry、enable、disable：完整 entryId 与不带前缀的 id 都认；没有这条就抛错', async () => {
    const pm = mount({ entries: { foo: '@x/gwb-foo', bar: '@x/gwb-bar' } })
    expect(await pm.run('plugin-manager.disable', { entryId: 'home:foo' })).toEqual({ ok: true })
    expect(pm.tree.store['foo']?.disabled).toBe(true)
    expect(await pm.run('plugin-manager.enable', { entryId: 'foo' })).toEqual({ ok: true })
    expect(pm.tree.store['foo']?.disabled).toBeUndefined()
    expect(await pm.run('plugin-manager.remove-entry', { entryId: 'bar' })).toEqual({ ok: true })
    expect(pm.tree.store['bar']).toBeUndefined()
    await expect(pm.run('plugin-manager.enable', { entryId: 'nope' })).rejects.toThrow('cordis.yml 里没有 id 是 "nope" 的条目')
  })

  it('参数不是对象、缺字段：直接抛错', async () => {
    const pm = mount({ entries: {} })
    await expect(pm.run('plugin-manager.remove-entry', 'foo')).rejects.toThrow('参数要是一个对象')
    await expect(pm.run('plugin-manager.enable', {})).rejects.toThrow('entryId 要是个非空字符串')
    await expect(pm.run('plugin-manager.search', { scope: '' })).rejects.toThrow('scope 给了就要是非空字符串')
    await expect(pm.run('plugin-manager.update-all', { only: [''] })).rejects.toThrow('only 给了就要是个非空字符串数组')
  })
})

describe('plugin-manager.set-label', () => {
  it('没装数据插件：ok false，说明要装数据插件', async () => {
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    const result = (await pm.run('plugin-manager.set-label', { entryId: 'foo', label: '名字' })) as GwbResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没装数据插件')
  })

  it('装了数据插件：写进 labels 文档、list 带出来；空串清除', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0' })
    const data = fakeDataPlugin()
    const pm = mount({ entries: { foo: '@x/gwb-foo' }, data })
    expect(await pm.run('plugin-manager.set-label', { entryId: 'foo', label: '  名字  ' })).toEqual({ ok: true })
    expect(data.docs['labels']).toEqual({ foo: '名字' })
    const listed = (await pm.run('plugin-manager.list')) as { pkg: string; entries: { label?: string }[] }[]
    expect(listed.find((view) => view.pkg === '@x/gwb-foo')?.entries[0]?.label).toBe('名字')
    await pm.run('plugin-manager.set-label', { entryId: 'foo', label: '' })
    expect(data.docs['labels']).toEqual({})
  })
})

describe('plugin-manager.transfer-owner', () => {
  it('装了哪个插件就转哪份归属，没装的那一项是 false；完整 entryId 也认', async () => {
    const data = fakeDataPlugin()
    const pm = mount({ entries: {}, data })
    expect(await pm.run('plugin-manager.transfer-owner', { id: 'home:foo', pkg: '@x/gwb-new' })).toEqual({
      ok: true,
      data: { id: 'foo', pkg: '@x/gwb-new', data: true, settings: false },
    })
    expect(data.transfers).toEqual([['foo', '@x/gwb-new']])
  })
})

describe('plugin-manager.remount', () => {
  it('别的条目：在这条命令里做完，回 remounted 与重新加载后的状态', async () => {
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    expect(await pm.run('plugin-manager.remount', { entryId: 'home:foo' })).toEqual({ ok: true, data: { id: 'foo', action: 'remounted', state: 'ACTIVE' } })
  })

  it('插件管理自己：先回 deferred', async () => {
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.remount', { entryId: 'plugin-manager' })).toEqual({
      ok: true,
      data: { id: 'plugin-manager', action: 'deferred', state: 'ACTIVE' },
    })
    await settle()
  })

  it('动条目树时抛错：ok false，data 里 action 是 failed', async () => {
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    pm.tree.failUpdateFor.add('foo')
    const result = (await pm.run('plugin-manager.remount', { entryId: 'foo' })) as GwbResult
    expect(result.ok).toBe(false)
    expect(result.error).toBe('条目 foo 重新加载失败：Error: cannot update foo')
    expect(result.data).toEqual({ id: 'foo', action: 'failed', state: 'Error: cannot update foo' })
  })
})

describe('plugin-manager.install 与 uninstall', () => {
  it('install：在 home 里 pnpm add 包名@spec，再加一条条目', async () => {
    fakePnpm.afterRun = () => writeHomeDependencies({ '@x/gwb-foo': '^1.0.0' })
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.install', { pkg: '@x/gwb-foo', spec: '^1.0.0' })).toEqual({
      ok: true,
      data: { ok: true, pkg: '@x/gwb-foo', entryId: 'home:foo' },
    })
    expect(fakePnpm.calls).toEqual([{ args: ['add', '@x/gwb-foo@^1.0.0'], cwd: homeDir }])
    expect(pm.tree.store['foo']?.options).toEqual({ id: 'foo', name: '@x/gwb-foo' })
  })

  it('install：pnpm 失败时不加条目，error 带上输出的最后几行', async () => {
    fakePnpm.runExitCode = 1
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.install', { pkg: '@x/gwb-foo' })).toEqual({
      ok: false,
      error: 'pnpm add @x/gwb-foo 失败（退出码 1）\npnpm 说的原因',
      data: { ok: false, pkg: '@x/gwb-foo', error: 'pnpm add @x/gwb-foo 失败（退出码 1）', tail: 'pnpm 说的原因' },
    })
    expect(pm.tree.store['foo']).toBeUndefined()
  })

  it('install：包名不合规直接抛错，不运行 pnpm', async () => {
    const pm = mount({ entries: {} })
    await expect(pm.run('plugin-manager.install', { pkg: '-r' })).rejects.toThrow('包名 "-r" 不合规')
    expect(fakePnpm.calls).toEqual([])
  })

  it('uninstall：没装的包抛错；装了的先删它的全部条目，再 pnpm remove', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0' })
    const pm = mount({ entries: { foo: '@x/gwb-foo', 'foo-2': '@x/gwb-foo', bar: '@x/gwb-bar' } })
    await expect(pm.run('plugin-manager.uninstall', { pkg: '@x/gwb-bar' })).rejects.toThrow('home 里没装 @x/gwb-bar，无法卸载')
    expect(await pm.run('plugin-manager.uninstall', { pkg: '@x/gwb-foo' })).toEqual({
      ok: true,
      data: { ok: true, pkg: '@x/gwb-foo', removedEntries: ['foo', 'foo-2'] },
    })
    expect(Object.keys(pm.tree.store).sort()).toEqual(['bar', 'plugin-manager'])
    expect(fakePnpm.calls).toEqual([{ args: ['remove', '@x/gwb-foo'], cwd: homeDir }])
  })

  it('uninstall：pnpm 失败时条目已删、包还在，回执说明', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0' })
    fakePnpm.runExitCode = 1
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    expect(await pm.run('plugin-manager.uninstall', { pkg: '@x/gwb-foo' })).toEqual({
      ok: false,
      error: 'pnpm remove @x/gwb-foo 失败（退出码 1）。条目已删除 1 条，包还在 home 里\npnpm 说的原因',
      data: { ok: false, pkg: '@x/gwb-foo', removedEntries: ['foo'], error: 'pnpm remove @x/gwb-foo 失败（退出码 1）。条目已删除 1 条，包还在 home 里', tail: 'pnpm 说的原因' },
    })
  })
})

describe('plugin-manager.outdated', () => {
  it('退出码 1 是「有过期包」：回版本差距', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.outdated')).toEqual({ ok: true, data: { ok: true, updates: { '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } } } })
    expect(fakePnpm.calls).toEqual([{ args: ['outdated', '--json'], cwd: homeDir }])
  })

  it('别的退出码、没启动、输出解析不了：ok false 带说明', async () => {
    const pm = mount({ entries: {} })
    fakePnpm.captureExitCode = 2
    expect(await pm.run('plugin-manager.outdated')).toEqual({ ok: false, error: 'pnpm outdated 失败（退出码 2）' })
    fakePnpm.captureExitCode = null
    expect(await pm.run('plugin-manager.outdated')).toEqual({ ok: false, error: 'pnpm 启动失败（退出码 null）' })
    fakePnpm.captureExitCode = 0
    fakePnpm.captureStdout = 'not json'
    expect(await pm.run('plugin-manager.outdated')).toEqual({ ok: false, error: 'pnpm outdated 的输出解析不了（需要的是 JSON）——pnpm 升大版本时输出格式可能变了' })
  })
})

describe('plugin-manager.update-all', () => {
  it('全都最新：不运行 pnpm add，note 说全都最新', async () => {
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.update-all')).toEqual({ ok: true, data: { ok: true, updated: [], selfDeferred: false, note: '全都最新' } })
    expect(fakePnpm.calls.map((call) => call.args[0])).toEqual(['outdated'])
  })

  it('升一个包：一次 pnpm add 精确版本，它的条目在这条命令里重新加载，停用的跳过，最后整页重新加载', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    const pm = mount({ entries: { foo: '@x/gwb-foo', 'foo-2': '@x/gwb-foo' }, shellReload: true })
    pm.tree.store['foo-2']!.disabled = true
    expect(await pm.run('plugin-manager.update-all', { only: ['@x/gwb-foo', '@x/gwb-other'] })).toEqual({
      ok: true,
      data: {
        ok: true,
        updated: [
          {
            pkg: '@x/gwb-foo',
            from: '1.0.0',
            to: '1.1.0',
            entries: [
              { id: 'foo', action: 'remounted', state: 'ACTIVE' },
              { id: 'foo-2', action: 'skipped', state: 'disabled' },
            ],
          },
        ],
        selfDeferred: false,
        reload: 'done',
        note: 'only 里这几个不在过期清单里，没动：@x/gwb-other',
      },
    })
    expect(fakePnpm.calls.map((call) => call.args)).toEqual([['outdated', '--json'], ['add', '@x/gwb-foo@1.1.0']])
    expect(pm.shellReloads).toBe(1)
  })

  it('命令表里没有 shell.reload：reload 是 unavailable，note 说要手动刷新', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    const result = (await pm.run('plugin-manager.update-all')) as GwbResult & { data: { reload: string; note: string } }
    expect(result.data.reload).toBe('unavailable')
    expect(result.data.note).toBe('命令表里没有 shell.reload（外壳没装或版本太旧），界面要手动刷新')
  })

  it('升级清单里有插件管理自己：自己那条先回 deferred，回执之后才重新加载，再整页重新加载', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ [OWN_PKG]: { current: '0.7.0', latest: '0.7.1' } })
    const pm = mount({ entries: {}, shellReload: true })
    expect(await pm.run('plugin-manager.update-all')).toEqual({
      ok: true,
      data: {
        ok: true,
        updated: [{ pkg: OWN_PKG, from: '0.7.0', to: '0.7.1', entries: [{ id: 'plugin-manager', action: 'deferred', state: 'ACTIVE' }] }],
        selfDeferred: true,
        reload: 'deferred',
      },
    })
    expect(pm.shellReloads).toBe(0)
    await settle()
    expect(pm.shellReloads).toBe(1)
  })

  it('pnpm add 失败：一条条目都不动，error 带上输出的最后几行', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    fakePnpm.runExitCode = 1
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    expect(await pm.run('plugin-manager.update-all')).toEqual({
      ok: false,
      error: 'pnpm add @x/gwb-foo@1.1.0 失败（退出码 1）。一条条目都没动\npnpm 说的原因',
      data: { ok: false, updated: [], selfDeferred: false, error: 'pnpm add @x/gwb-foo@1.1.0 失败（退出码 1）。一条条目都没动', tail: 'pnpm 说的原因' },
    })
  })
})
