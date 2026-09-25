import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GwbResult } from '@godcreator/gwb-kernel-desktop'
import type { EntryTreeLike } from '../src/tree.js'

/**
 * 命令这一层：在假 ctx 上运行 `apply`，按命令名调登记下来的处理函数。条目树、命令插件都是假的；
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

vi.mock('../src/pnpm-location.js', () => ({
  locatePnpm: () => Promise.resolve({ ok: true, file: 'fake-pnpm.exe', version: '0.0.0' }),
}))

vi.mock('../src/pnpm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pnpm.js')>()
  return {
    ...actual,
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
const KERNEL_PKG = '@godcreator/gwb-kernel-desktop'
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

/** 照 pnpm 的布局：`node_modules/<包名>` 是指向 `.pnpm/<目录名>/node_modules/<包名>` 的目录链接；再调一次就改指到新目录 */
function linkInstalled(pkg: string, dirName: string): void {
  const real = path.join(homeDir, 'node_modules', '.pnpm', dirName, 'node_modules', ...pkg.split('/'))
  fs.mkdirSync(real, { recursive: true })
  const link = path.join(homeDir, 'node_modules', ...pkg.split('/'))
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.rmSync(link, { force: true })
  fs.symlinkSync(real, link, 'junction')
}

/** 照 pnpm 升级一个包：装之前链到 `<包>@<from>` 的目录；`pnpm add` 之后改链到 `<包>@<to>`（目录名带版本号，升级必换目录），清单写新版本号 */
function upgradesOnAdd(pkg: string, from: string, to: string): void {
  const dirName = (version: string): string => `${pkg.replace('/', '+')}@${version}`
  linkInstalled(pkg, dirName(from))
  writeInstalledManifest(pkg, { version: from })
  fakePnpm.afterRun = (args) => {
    if (args[0] !== 'add') return
    linkInstalled(pkg, dirName(to))
    writeInstalledManifest(pkg, { version: to })
  }
}

function mount(opts: { entries: Record<string, string>; shellReload?: boolean }): Mounted {
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
  }
  apply(ctx as never)
  return mounted
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-commands-'))
  writeHomeDependencies({})
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
  it('包与条目两层对上，带 peer 里内核包的范围与没满足的别的 peer；条目指向没装的包报 installed: false、不标内核兼容', async () => {
    writeHomeDependencies({ '@x/gwb-a': '^1.0.0' })
    writeInstalledManifest('@x/gwb-a', {
      version: '1.2.0',
      keywords: ['gwb', 'gwb-plugin'],
      peerDependencies: { [KERNEL_PKG]: '^0.2.1', cordis: '4.0.0-rc.10', '@x/gwb-b': '^1.0.0', '@x/gwb-missing': '^0.3.0' },
    })
    writeInstalledManifest('@x/gwb-b', { version: '0.9.0' })
    const pm = mount({ entries: { a: '@x/gwb-a', ghost: '@x/gwb-ghost' } })
    const listed = (await pm.run('plugin-manager.list')) as { pkg: string }[]
    expect(listed.find((view) => view.pkg === '@x/gwb-a')).toEqual({
      pkg: '@x/gwb-a',
      spec: '^1.0.0',
      installed: true,
      entries: [{ id: 'a', entryId: 'home:a', pkg: '@x/gwb-a', disabled: false, active: true, group: false }],
      kernelRange: '^0.2.1',
      kernelUntested: false,
      unmetPeers: [
        { pkg: '@x/gwb-b', range: '^1.0.0', installed: '0.9.0' },
        { pkg: '@x/gwb-missing', range: '^0.3.0' },
      ],
    })
    expect(listed.find((view) => view.pkg === '@x/gwb-ghost')).toEqual({
      pkg: '@x/gwb-ghost',
      installed: false,
      entries: [{ id: 'ghost', entryId: 'home:ghost', pkg: '@x/gwb-ghost', disabled: false, active: true, group: false }],
      kernelUntested: false,
      unmetPeers: [],
    })
    expect(listed.map((view) => view.pkg)).toEqual([...listed.map((view) => view.pkg)].sort((a, b) => a.localeCompare(b)))
  })

  it('home 的 dependencies 里的内核包与 cordis 不列出来：它们没有条目，内核包经 update 的 specs 换、cordis 随它对齐', async () => {
    writeHomeDependencies({ '@x/gwb-a': '^1.0.0', [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9' })
    const pm = mount({ entries: { a: '@x/gwb-a' } })
    const listed = (await pm.run('plugin-manager.list')) as { pkg: string }[]
    expect(listed.map((view) => view.pkg)).toEqual(['@godcreator/gwb-plugin-manager', '@x/gwb-a'])
  })

  it('peer 写的包装着且在范围里：unmetPeers 是空数组；不合包名规则的 peer 不拿去拼路径、按没装报', async () => {
    writeHomeDependencies({ '@x/gwb-a': '^1.0.0', '@x/gwb-b': '^1.0.0' })
    writeInstalledManifest('@x/gwb-a', { version: '1.0.0', keywords: ['gwb-plugin'], peerDependencies: { '@x/gwb-b': '^1.0.0' } })
    writeInstalledManifest('@x/gwb-b', { version: '1.3.0', keywords: ['gwb-plugin'], peerDependencies: { '../escape': '^1.0.0' } })
    const pm = mount({ entries: {} })
    const listed = (await pm.run('plugin-manager.list')) as { pkg: string; unmetPeers: unknown }[]
    expect(listed.find((view) => view.pkg === '@x/gwb-a')?.unmetPeers).toEqual([])
    expect(listed.find((view) => view.pkg === '@x/gwb-b')?.unmetPeers).toEqual([{ pkg: '../escape', range: '^1.0.0' }])
  })
})

describe('条目命令', () => {
  it('add-entry：没装的包抛错；装了的包按默认 id 加，条目树上重名加后缀（不同 scope 的同名包也一样）', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0', '@y/foo': '^1.0.0' })
    const pm = mount({ entries: {} })
    await expect(pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-nope' })).rejects.toThrow('home 里没装 @x/gwb-nope')
    expect(await pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo' })).toEqual({ ok: true, data: { entryId: 'home:foo' } })
    expect(await pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo' })).toEqual({ ok: true, data: { entryId: 'home:foo-2' } })
    expect(await pm.run('plugin-manager.add-entry', { pkg: '@y/foo' })).toEqual({ ok: true, data: { entryId: 'home:foo-3' } })
    expect(pm.tree.store['foo']?.options).toEqual({ id: 'foo', name: '@x/gwb-foo' })
  })

  it('add-entry 只收 pkg：给了 id 或 config 直接抛错，不加条目', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0' })
    const pm = mount({ entries: {} })
    await expect(pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo', id: 'custom' })).rejects.toThrow('认不出参数 id')
    await expect(pm.run('plugin-manager.add-entry', { pkg: '@x/gwb-foo', config: { a: 1 } })).rejects.toThrow('认不出参数 config')
    expect(Object.keys(pm.tree.store)).toEqual(['plugin-manager'])
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
    await expect(pm.run('plugin-manager.search', { scope: '@j' })).rejects.toThrow('认不出参数 scope')
    await expect(pm.run('plugin-manager.remove-entry', { entryId: 'foo', force: true })).rejects.toThrow('认不出参数 force')
    await expect(pm.run('plugin-manager.update', { only: [''] })).rejects.toThrow('only 要是个非空字符串数组')
  })
})

describe('登记的命令', () => {
  it('transfer-owner 不再登记', () => {
    const pm = mount({ entries: {} })
    expect(() => pm.run('plugin-manager.transfer-owner')).toThrow('没有登记 plugin-manager.transfer-owner')
  })

  it('remount 不再登记：手动重新加载一条条目用 disable 再 enable', () => {
    const pm = mount({ entries: {} })
    expect(() => pm.run('plugin-manager.remount')).toThrow('没有登记 plugin-manager.remount')
  })
})

describe('plugin-manager.update 重新加载条目', () => {
  it('动条目树时抛错：这条条目记为 failed，别的照常', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0' })
    upgradesOnAdd('@x/gwb-foo', '1.0.0', '1.1.0')
    const pm = mount({ entries: { foo: '@x/gwb-foo', 'foo-2': '@x/gwb-foo' } })
    pm.tree.failUpdateFor.add('foo')
    const result = (await pm.run('plugin-manager.update', { all: true })) as GwbResult & { data: { updated: { entries: unknown[] }[] } }
    expect(result.ok).toBe(true)
    expect(result.data.updated[0]!.entries).toEqual([
      { id: 'foo', action: 'failed', state: 'Error: cannot update foo' },
      { id: 'foo-2', action: 'remounted', state: 'ACTIVE' },
    ])
  })
})

describe('plugin-manager.install 与 uninstall', () => {
  it('install：在 home 里 pnpm add 包名@spec（不带 --save-exact，清单照 pnpm 默认写 ^ 范围），再加一条条目', async () => {
    fakePnpm.afterRun = () => writeHomeDependencies({ '@x/gwb-foo': '1.2.0' })
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.install', { pkg: '@x/gwb-foo', spec: '^1.0.0' })).toEqual({ ok: true, data: { pkg: '@x/gwb-foo', entryId: 'home:foo' } })
    expect(fakePnpm.calls).toEqual([{ args: ['add', '@x/gwb-foo@^1.0.0'], cwd: homeDir }])
    expect(pm.tree.store['foo']?.options).toEqual({ id: 'foo', name: '@x/gwb-foo' })
  })

  it('install：包已在 home 的 dependencies 里，直接抛错、指向 add-entry 与 update 的 specs，不运行 pnpm', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0' })
    const pm = mount({ entries: {} })
    const installing = pm.run('plugin-manager.install', { pkg: '@x/gwb-foo', spec: '1.1.0' })
    await expect(installing).rejects.toThrow('plugin-manager.add-entry')
    await expect(installing).rejects.toThrow('plugin-manager.update {"specs"')
    expect(fakePnpm.calls).toEqual([])
  })

  it('install：pnpm 失败时不加条目，外层 error 带上输出的最后几行，没有 data', async () => {
    fakePnpm.runExitCode = 1
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.install', { pkg: '@x/gwb-foo' })).toEqual({ ok: false, error: 'pnpm add @x/gwb-foo 失败（退出码 1）\npnpm 说的原因' })
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
    expect(await pm.run('plugin-manager.uninstall', { pkg: '@x/gwb-foo' })).toEqual({ ok: true, data: { pkg: '@x/gwb-foo' } })
    expect(Object.keys(pm.tree.store).sort()).toEqual(['bar', 'plugin-manager'])
    expect(fakePnpm.calls).toEqual([{ args: ['remove', '@x/gwb-foo'], cwd: homeDir }])
  })

  it('uninstall：内核包与 cordis 不许卸载，直接抛错，一次 pnpm 都不运行', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9' })
    const pm = mount({ entries: {} })
    await expect(pm.run('plugin-manager.uninstall', { pkg: KERNEL_PKG })).rejects.toThrow(`${KERNEL_PKG} 是 home 运行必需的包，不许卸载`)
    await expect(pm.run('plugin-manager.uninstall', { pkg: 'cordis' })).rejects.toThrow('cordis 是 home 运行必需的包，不许卸载')
    expect(fakePnpm.calls).toEqual([])
  })

  it('uninstall：pnpm 失败时条目已删、包还在，回执说明', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0' })
    fakePnpm.runExitCode = 1
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    expect(await pm.run('plugin-manager.uninstall', { pkg: '@x/gwb-foo' })).toEqual({
      ok: false,
      error: 'pnpm remove @x/gwb-foo 失败（退出码 1）。条目已删除 1 条，包还在 home 里\npnpm 说的原因',
    })
  })
})

describe('plugin-manager.outdated', () => {
  it('退出码 1 是「有过期包」：回版本差距', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.outdated')).toEqual({ ok: true, data: { updates: { '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } } } })
    expect(fakePnpm.calls).toEqual([{ args: ['outdated', '--json'], cwd: homeDir }])
  })

  it('内核包与 cordis 不进回执：内核包经 update 的 specs 换', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({
      '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' },
      [KERNEL_PKG]: { current: '0.3.0', latest: '0.3.1' },
      cordis: { current: '4.0.0-rc.9', latest: '4.0.0-rc.10' },
    })
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.outdated')).toEqual({ ok: true, data: { updates: { '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } } } })
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

describe('plugin-manager.update', () => {
  it('全都最新：不运行 pnpm add，note 说全都最新', async () => {
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.update', { all: true })).toEqual({ ok: true, data: { updated: [], dependents: [], selfDeferred: false, note: '全都最新' } })
    expect(fakePnpm.calls.map((call) => call.args[0])).toEqual(['outdated'])
  })

  it('升一个包：一次 pnpm add 到 outdated 查到的版本，它的条目在这条命令里重新加载，停用的跳过；不整页重新加载', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0', '@x/gwb-other': '1.0.0' })
    upgradesOnAdd('@x/gwb-foo', '1.0.0', '1.1.0')
    const pm = mount({ entries: { foo: '@x/gwb-foo', 'foo-2': '@x/gwb-foo' }, shellReload: true })
    pm.tree.store['foo-2']!.disabled = true
    expect(await pm.run('plugin-manager.update', { only: ['@x/gwb-foo', '@x/gwb-other'] })).toEqual({
      ok: true,
      data: {
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
        dependents: [],
        selfDeferred: false,
        note: 'only 里这几个已是最新，没动：@x/gwb-other',
      },
    })
    expect(fakePnpm.calls.map((call) => call.args)).toEqual([['outdated', '--json'], ['add', '@x/gwb-foo@1.1.0']])
    expect(pm.shellReloads).toBe(0)
  })

  it('only 里的包名不在 home 的 dependencies 里（多半拼错）：直接抛错、说出是哪个名字，一次 pnpm 都不运行', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0' })
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    await expect(pm.run('plugin-manager.update', { only: ['@x/gwb-foo', '@x/gwb-fooo'] })).rejects.toThrow('@x/gwb-fooo')
    expect(fakePnpm.calls).toEqual([])
  })

  it('升级清单里有插件管理自己：自己那条先回 deferred，回执之后才重新加载，之后不整页重新加载', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ [OWN_PKG]: { current: '0.7.0', latest: '0.7.1' } })
    writeHomeDependencies({ [OWN_PKG]: '0.7.0' })
    upgradesOnAdd(OWN_PKG, '0.7.0', '0.7.1')
    const pm = mount({ entries: {}, shellReload: true })
    expect(await pm.run('plugin-manager.update', { all: true })).toEqual({
      ok: true,
      data: {
        updated: [{ pkg: OWN_PKG, from: '0.7.0', to: '0.7.1', entries: [{ id: 'plugin-manager', action: 'deferred', state: 'ACTIVE' }] }],
        dependents: [],
        selfDeferred: true,
      },
    })
    await settle()
    expect(pm.logs.some((line) => line.includes('插件管理自己（plugin-manager）重新加载了'))).toBe(true)
    expect(pm.shellReloads).toBe(0)
  })

  it('pnpm add 失败：一条条目都不动，外层 error 带上输出的最后几行，没有 data', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    fakePnpm.runExitCode = 1
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    expect(await pm.run('plugin-manager.update', { all: true })).toEqual({
      ok: false,
      error: 'pnpm add @x/gwb-foo@1.1.0 失败（退出码 1）。一条条目都没动\npnpm 说的原因',
    })
  })

  it('pnpm add 前后真实目录变了的别的包：它的条目在同一条命令里跟着重新加载（停用的跳过），回执 dependents 列出来；目录没变的不动', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0', '@x/gwb-bar': '1.0.0', '@x/gwb-plain': '1.0.0' })
    linkInstalled('@x/gwb-foo', '@x+gwb-foo@1.0.0')
    linkInstalled('@x/gwb-bar', '@x+gwb-bar@1.0.0_@x+gwb-foo@1.0.0')
    linkInstalled('@x/gwb-plain', '@x+gwb-plain@1.0.0')
    fakePnpm.afterRun = (args) => {
      if (args[0] !== 'add') return
      linkInstalled('@x/gwb-foo', '@x+gwb-foo@1.1.0')
      linkInstalled('@x/gwb-bar', '@x+gwb-bar@1.0.0_@x+gwb-foo@1.1.0')
    }
    const pm = mount({ entries: { foo: '@x/gwb-foo', bar: '@x/gwb-bar', 'bar-off': '@x/gwb-bar', plain: '@x/gwb-plain' }, shellReload: true })
    pm.tree.store['bar-off']!.disabled = true
    const plainFiberBefore = pm.tree.store['plain']!.fiber
    expect(await pm.run('plugin-manager.update', { all: true })).toEqual({
      ok: true,
      data: {
        updated: [{ pkg: '@x/gwb-foo', from: '1.0.0', to: '1.1.0', entries: [{ id: 'foo', action: 'remounted', state: 'ACTIVE' }] }],
        dependents: [
          {
            pkg: '@x/gwb-bar',
            entries: [
              { id: 'bar', action: 'remounted', state: 'ACTIVE' },
              { id: 'bar-off', action: 'skipped', state: 'disabled' },
            ],
          },
        ],
        selfDeferred: false,
      },
    })
    expect(fakePnpm.calls.map((call) => call.args)).toEqual([['outdated', '--json'], ['add', '@x/gwb-foo@1.1.0']])
    expect(pm.tree.store['plain']!.fiber).toBe(plainFiberBefore)
  })

  it('插件管理自己的真实目录变了：别的都在命令里做完，自己那条先回 deferred，回执之后才重新加载', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' } })
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0', [OWN_PKG]: '0.9.0' })
    linkInstalled('@x/gwb-foo', '@x+gwb-foo@1.0.0')
    linkInstalled(OWN_PKG, '@godcreator+gwb-plugin-manager@0.9.0_@x+gwb-foo@1.0.0')
    fakePnpm.afterRun = (args) => {
      if (args[0] !== 'add') return
      linkInstalled('@x/gwb-foo', '@x+gwb-foo@1.1.0')
      linkInstalled(OWN_PKG, '@godcreator+gwb-plugin-manager@0.9.0_@x+gwb-foo@1.1.0')
    }
    const pm = mount({ entries: { foo: '@x/gwb-foo' }, shellReload: true })
    expect(await pm.run('plugin-manager.update', { all: true })).toEqual({
      ok: true,
      data: {
        updated: [{ pkg: '@x/gwb-foo', from: '1.0.0', to: '1.1.0', entries: [{ id: 'foo', action: 'remounted', state: 'ACTIVE' }] }],
        dependents: [{ pkg: OWN_PKG, entries: [{ id: 'plugin-manager', action: 'deferred', state: 'ACTIVE' }] }],
        selfDeferred: true,
      },
    })
    await settle()
    expect(pm.shellReloads).toBe(0)
  })

  it('pnpm 报内核包与 cordis 过期：不升它们，回执里也不提', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({
      '@x/gwb-foo': { current: '1.0.0', latest: '1.1.0' },
      [KERNEL_PKG]: { current: '0.3.0', latest: '0.3.1' },
      cordis: { current: '4.0.0-rc.9', latest: '4.0.0-rc.10' },
    })
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0' })
    upgradesOnAdd('@x/gwb-foo', '1.0.0', '1.1.0')
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    expect(await pm.run('plugin-manager.update', { all: true })).toEqual({
      ok: true,
      data: {
        updated: [{ pkg: '@x/gwb-foo', from: '1.0.0', to: '1.1.0', entries: [{ id: 'foo', action: 'remounted', state: 'ACTIVE' }] }],
        dependents: [],
        selfDeferred: false,
      },
    })
    expect(fakePnpm.calls.map((call) => call.args)).toEqual([['outdated', '--json'], ['add', '@x/gwb-foo@1.1.0']])
  })

  it('pnpm 只报内核包过期：不运行 pnpm add，note 说全都最新', async () => {
    fakePnpm.captureExitCode = 1
    fakePnpm.captureStdout = JSON.stringify({ [KERNEL_PKG]: { current: '0.3.0', latest: '0.3.1' } })
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.update', { all: true })).toEqual({ ok: true, data: { updated: [], dependents: [], selfDeferred: false, note: '全都最新' } })
    expect(fakePnpm.calls.map((call) => call.args[0])).toEqual(['outdated'])
  })

  it('only 点了内核包或 cordis：直接抛错、指向 specs 写法，一次 pnpm 都不运行', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.0.0', [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9' })
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    await expect(pm.run('plugin-manager.update', { only: ['@x/gwb-foo', KERNEL_PKG] })).rejects.toThrow(`plugin-manager.update {"specs":{"${KERNEL_PKG}"`)
    await expect(pm.run('plugin-manager.update', { only: ['cordis'] })).rejects.toThrow('only 里的 cordis 由内核决定版本')
    expect(fakePnpm.calls).toEqual([])
  })

  it('参数：不给、空对象、三种给了两种、认不出的键、all 不是 true、specs 是空对象，都直接抛错带用法，一次 pnpm 都不运行', async () => {
    const pm = mount({ entries: {} })
    await expect(pm.run('plugin-manager.update')).rejects.toThrow('要升全部就给 {"all":true}')
    await expect(pm.run('plugin-manager.update', {})).rejects.toThrow('要升全部就给 {"all":true}')
    await expect(pm.run('plugin-manager.update', { all: true, only: ['@x/gwb-foo'] })).rejects.toThrow('all、only、specs 只能给一个，这次给了 all、only')
    await expect(pm.run('plugin-manager.update', { only: ['@x/gwb-foo'], specs: { '@x/gwb-foo': '1.0.0' } })).rejects.toThrow('这次给了 only、specs')
    await expect(pm.run('plugin-manager.update', { all: true, force: true })).rejects.toThrow('认不出参数 force')
    await expect(pm.run('plugin-manager.update', { all: false })).rejects.toThrow('all 只能是 true')
    await expect(pm.run('plugin-manager.update', { specs: {} })).rejects.toThrow('specs 要是个非空对象')
    await expect(pm.run('plugin-manager.update', { specs: { '@x/gwb-foo': '' } })).rejects.toThrow('specs 要是个非空对象')
    expect(fakePnpm.calls).toEqual([])
  })

  it('update-kernel 不再登记', () => {
    const pm = mount({ entries: {} })
    expect(() => pm.run('plugin-manager.update-kernel')).toThrow('没有登记 plugin-manager.update-kernel')
  })
})

describe('plugin-manager.update 的 specs', () => {
  it('按给定写法一次 pnpm add、不查 outdated；from / to 取装之前与装之后清单里的版本号（file: 写法不核对）；它的条目与真实目录变了的别的包重新加载，不整页重载', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0', '@x/gwb-bar': '1.0.0' })
    linkInstalled('@x/gwb-foo', '@x+gwb-foo@1.0.0')
    writeInstalledManifest('@x/gwb-foo', { version: '1.0.0' })
    linkInstalled('@x/gwb-bar', '@x+gwb-bar@1.0.0_@x+gwb-foo@1.0.0')
    fakePnpm.afterRun = () => {
      linkInstalled('@x/gwb-foo', '@x+gwb-foo@file+D+repo+foo.tgz')
      writeInstalledManifest('@x/gwb-foo', { version: '1.1.0-dev.2' })
      linkInstalled('@x/gwb-bar', '@x+gwb-bar@1.0.0_@x+gwb-foo@file+D+repo+foo.tgz')
    }
    const pm = mount({ entries: { foo: '@x/gwb-foo', bar: '@x/gwb-bar' }, shellReload: true })
    expect(await pm.run('plugin-manager.update', { specs: { '@x/gwb-foo': 'file:D:/repo/foo.tgz' } })).toEqual({
      ok: true,
      data: {
        updated: [{ pkg: '@x/gwb-foo', from: '1.0.0', to: '1.1.0-dev.2', entries: [{ id: 'foo', action: 'remounted', state: 'ACTIVE' }] }],
        dependents: [{ pkg: '@x/gwb-bar', entries: [{ id: 'bar', action: 'remounted', state: 'ACTIVE' }] }],
        selfDeferred: false,
      },
    })
    expect(fakePnpm.calls.map((call) => call.args)).toEqual([['add', '@x/gwb-foo@file:D:/repo/foo.tgz']])
    expect(pm.shellReloads).toBe(0)
  })

  it('specs 里有插件管理自己：别的在命令里做完，自己那条回执之后才重新加载，之后也不整页重载', async () => {
    writeHomeDependencies({ [OWN_PKG]: '0.11.0' })
    upgradesOnAdd(OWN_PKG, '0.11.0', '0.12.0-dev.1')
    const pm = mount({ entries: {}, shellReload: true })
    expect(await pm.run('plugin-manager.update', { specs: { [OWN_PKG]: '0.12.0-dev.1' } })).toEqual({
      ok: true,
      data: {
        updated: [{ pkg: OWN_PKG, from: '0.11.0', to: '0.12.0-dev.1', entries: [{ id: 'plugin-manager', action: 'deferred', state: 'ACTIVE' }] }],
        dependents: [],
        selfDeferred: true,
      },
    })
    await settle()
    expect(pm.logs.some((line) => line.includes('插件管理自己（plugin-manager）重新加载了'))).toBe(true)
    expect(pm.shellReloads).toBe(0)
  })

  it('装之前 node_modules 里读不到清单：回执里没有 from', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0' })
    fakePnpm.afterRun = () => writeInstalledManifest('@x/gwb-foo', { version: '1.0.1' })
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    const result = (await pm.run('plugin-manager.update', { specs: { '@x/gwb-foo': 'latest' } })) as GwbResult & { data: { updated: unknown[] } }
    expect(result.data.updated).toEqual([{ pkg: '@x/gwb-foo', to: '1.0.1', entries: [{ id: 'foo', action: 'remounted', state: 'ACTIVE' }] }])
  })

  it('包不在 home 的 dependencies 里：直接抛错、指向 install，一次 pnpm 都不运行', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0' })
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    await expect(pm.run('plugin-manager.update', { specs: { '@x/gwb-new': '1.0.0' } })).rejects.toThrow('首次安装用 plugin-manager.install')
    expect(fakePnpm.calls).toEqual([])
  })

  it('specs 里写了 cordis（不论带不带内核包）：直接抛错，说明 cordis 由插件管理照内核包对齐，一次 pnpm 都不运行', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.6.0', cordis: '4.0.0-rc.10' })
    const pm = mount({ entries: {} })
    await expect(pm.run('plugin-manager.update', { specs: { cordis: '4.0.0-rc.11' } })).rejects.toThrow('specs 里不写 cordis')
    await expect(pm.run('plugin-manager.update', { specs: { [KERNEL_PKG]: '0.6.1', cordis: '4.0.0-rc.11' } })).rejects.toThrow('specs 里不写 cordis')
    expect(fakePnpm.calls).toEqual([])
  })

  it('没有内核包、准确版本号对上了：照常重新加载，回执没有 restartRequired，pnpm add 不带 --save-exact', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0' })
    fakePnpm.afterRun = () => writeInstalledManifest('@x/gwb-foo', { version: '1.1.0' })
    const pm = mount({ entries: {}, shellReload: true })
    const result = (await pm.run('plugin-manager.update', { specs: { '@x/gwb-foo': '1.1.0' } })) as GwbResult & { data: Record<string, unknown> }
    expect(result.ok).toBe(true)
    expect(result.data['restartRequired']).toBeUndefined()
    expect(result.data['updated']).toEqual([{ pkg: '@x/gwb-foo', to: '1.1.0', entries: [] }])
    expect(pm.shellReloads).toBe(0)
    expect(fakePnpm.calls.map((call) => call.args)).toEqual([['add', '@x/gwb-foo@1.1.0']])
  })

  it('装的就是原来那一版、真实目录没变：回执照样列出这个包，它的条目不重新加载', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '1.0.0' })
    linkInstalled('@x/gwb-foo', '@x+gwb-foo@1.0.0')
    writeInstalledManifest('@x/gwb-foo', { version: '1.0.0' })
    const pm = mount({ entries: { foo: '@x/gwb-foo' } })
    const fiberBefore = pm.tree.store['foo']!.fiber
    expect(await pm.run('plugin-manager.update', { specs: { '@x/gwb-foo': '1.0.0' } })).toEqual({
      ok: true,
      data: { updated: [{ pkg: '@x/gwb-foo', from: '1.0.0', to: '1.0.0', entries: [] }], dependents: [], selfDeferred: false },
    })
    expect(pm.tree.store['foo']!.fiber).toBe(fiberBefore)
  })

  it('准确版本号对不上（清单里原来写的是 ^）：ok false，逐项说要的与装上的，一条条目都不重新加载', async () => {
    writeHomeDependencies({ '@x/gwb-foo': '^1.1.0-dev.1', '@x/gwb-bar': '1.0.0' })
    writeInstalledManifest('@x/gwb-foo', { version: '1.1.0-dev.1' })
    fakePnpm.afterRun = () => writeInstalledManifest('@x/gwb-foo', { version: '1.1.0-dev.3' })
    const pm = mount({ entries: { foo: '@x/gwb-foo' }, shellReload: true })
    const fiberBefore = pm.tree.store['foo']!.fiber
    const result = (await pm.run('plugin-manager.update', { specs: { '@x/gwb-foo': '1.1.0-dev.2' } })) as GwbResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('@x/gwb-foo 是 1.1.0-dev.3，要的是 1.1.0-dev.2')
    expect(result.error).toContain('一条条目都没动')
    expect(result.data).toBeUndefined()
    expect(pm.tree.store['foo']!.fiber).toBe(fiberBefore)
  })
})

describe('plugin-manager.update 的 specs 里有内核包', () => {
  function plugin(kernelRange: string): Record<string, unknown> {
    return { version: '1.0.0', keywords: ['gwb', 'gwb-plugin'], peerDependencies: { [KERNEL_PKG]: kernelRange } }
  }

  /** 假 pnpm：装内核包时写入 `kernelManifest` 与别的包的新清单，装 cordis 时写入对应版本的 cordis 清单 */
  function installsOnAdd(kernelManifest: Record<string, unknown>, others: Record<string, string> = {}): void {
    fakePnpm.afterRun = (args) => {
      const kernelSpec = args.find((arg) => arg.startsWith(`${KERNEL_PKG}@`))
      if (kernelSpec !== undefined) {
        writeInstalledManifest(KERNEL_PKG, kernelManifest)
        for (const [pkg, version] of Object.entries(others)) writeInstalledManifest(pkg, { version })
      }
      const cordisSpec = args.find((arg) => arg.startsWith('cordis@'))
      if (cordisSpec !== undefined) writeInstalledManifest('cordis', { name: 'cordis', version: cordisSpec.slice('cordis@'.length) })
    }
  }

  const NEW_KERNEL = { name: KERNEL_PKG, version: '0.4.0', peerDependencies: { cordis: '4.0.0' } }

  it('内核包与别的包一次 pnpm add，再照装上的内核包 peer 装 cordis（只有 cordis 带 --save-exact：它要正好等于内核包 peer 里那个版本）；不重新加载任何条目；回执带新旧版本、要不要重启、范围不含新内核的插件', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9', '@x/gwb-old': '1.0.0', '@x/gwb-new': '1.0.0', '@x/lib': '1.0.0' })
    writeInstalledManifest(KERNEL_PKG, { name: KERNEL_PKG, version: '0.3.0', peerDependencies: { cordis: '4.0.0-rc.9' } })
    writeInstalledManifest('cordis', { name: 'cordis', version: '4.0.0-rc.9' })
    writeInstalledManifest('@x/gwb-old', plugin('^0.3.0'))
    writeInstalledManifest('@x/gwb-new', plugin('^0.4.0'))
    writeInstalledManifest('@x/lib', { version: '1.0.0' })
    installsOnAdd(NEW_KERNEL)
    const pm = mount({ entries: { old: '@x/gwb-old' }, shellReload: true })
    const storeBefore = JSON.stringify(pm.tree.store)

    const result = (await pm.run('plugin-manager.update', { specs: { [KERNEL_PKG]: 'latest', '@x/gwb-new': '1.0.0' } })) as GwbResult & { data: Record<string, unknown> }
    expect(result).toEqual({
      ok: true,
      data: {
        updated: [
          { pkg: KERNEL_PKG, from: '0.3.0', to: '0.4.0', entries: [] },
          { pkg: '@x/gwb-new', from: '1.0.0', to: '1.0.0', entries: [] },
          { pkg: 'cordis', from: '4.0.0-rc.9', to: '4.0.0', entries: [] },
        ],
        dependents: [],
        selfDeferred: false,
        restartRequired: true,
        pluginsOutsideRange: ['@x/gwb-old'],
        note: result.data['note'],
      },
    })
    expect(result.data['note']).toContain('重启工作台')
    expect(fakePnpm.calls.map((call) => call.args)).toEqual([
      ['add', `${KERNEL_PKG}@latest`, '@x/gwb-new@1.0.0'],
      ['add', '--save-exact', 'cordis@4.0.0'],
    ])
    expect(JSON.stringify(pm.tree.store)).toBe(storeBefore)
    expect(pm.shellReloads).toBe(0)
  })

  it('装上的就是正在运行的内核版本：restartRequired 是 false', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.2.7', cordis: '4.0.0-rc.9' })
    installsOnAdd({ name: KERNEL_PKG, version: '0.2.7', peerDependencies: { cordis: '4.0.0-rc.9' } })
    const pm = mount({ entries: {} })
    const result = (await pm.run('plugin-manager.update', { specs: { [KERNEL_PKG]: '0.2.7' } })) as GwbResult & { data: Record<string, unknown> }
    expect(result.ok).toBe(true)
    expect(result.data['restartRequired']).toBe(false)
  })

  it('写法是准确版本号、装上的内核包不是它：ok false，不装 cordis、先别重启', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9' })
    installsOnAdd({ name: KERNEL_PKG, version: '0.3.4', peerDependencies: { cordis: '4.0.0-rc.9' } })
    const pm = mount({ entries: {} })
    const result = (await pm.run('plugin-manager.update', { specs: { [KERNEL_PKG]: '0.3.1' } })) as GwbResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain(`${KERNEL_PKG} 是 0.3.4，要的是 0.3.1`)
    expect(result.error).toContain('先别重启')
    expect(fakePnpm.calls).toHaveLength(1)
  })

  it('内核包 peer 里的 cordis 不是精确版本号：不装 cordis，ok false，data 带已装上的内核版本、说明先别重启', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9' })
    installsOnAdd({ name: KERNEL_PKG, version: '0.4.0', peerDependencies: { cordis: '^4.0.0' } })
    const pm = mount({ entries: {} })
    const result = (await pm.run('plugin-manager.update', { specs: { [KERNEL_PKG]: 'latest' } })) as GwbResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('精确版本号')
    expect(result.error).toContain('先别重启')
    expect(result.data).toEqual({ kernel: { to: '0.4.0' } })
    expect(fakePnpm.calls).toHaveLength(1)
  })

  it('装 cordis 时 pnpm 失败：ok false，data 带已装上的内核版本，error 带 pnpm 输出的最后几行、说明先别重启', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9' })
    writeInstalledManifest(KERNEL_PKG, { name: KERNEL_PKG, version: '0.3.0', peerDependencies: { cordis: '4.0.0-rc.9' } })
    fakePnpm.afterRun = (args) => {
      if (args.some((arg) => arg.startsWith(`${KERNEL_PKG}@`))) writeInstalledManifest(KERNEL_PKG, NEW_KERNEL)
      else fakePnpm.runExitCode = 1
    }
    const pm = mount({ entries: {} })
    const result = (await pm.run('plugin-manager.update', { specs: { [KERNEL_PKG]: '0.4.0' } })) as GwbResult
    expect(result.ok).toBe(false)
    expect(result.data).toEqual({ kernel: { from: '0.3.0', to: '0.4.0' } })
    expect(result.error).toContain('pnpm add --save-exact cordis@4.0.0 失败（退出码 1）')
    expect(result.error).toContain('先别重启')
    expect(result.error).toContain('pnpm 说的原因')
  })

  it('pnpm 退出码 0 但装上的 cordis 不是内核要的版本：ok false，data 带内核版本，说明先别重启', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9' })
    fakePnpm.afterRun = (args) => {
      if (args.some((arg) => arg.startsWith(`${KERNEL_PKG}@`))) writeInstalledManifest(KERNEL_PKG, { name: KERNEL_PKG, version: '0.3.1', peerDependencies: { cordis: '4.0.0-rc.9' } })
      if (args.some((arg) => arg.startsWith('cordis@'))) writeInstalledManifest('cordis', { name: 'cordis', version: '4.0.0-rc.10' })
    }
    const pm = mount({ entries: {} })
    const result = (await pm.run('plugin-manager.update', { specs: { [KERNEL_PKG]: '0.3.1' } })) as GwbResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('cordis 是 4.0.0-rc.10，要的是 4.0.0-rc.9')
    expect(result.error).toContain('先别重启')
    expect(result.data).toEqual({ kernel: { to: '0.3.1' } })
  })

  it('第一次 pnpm add 失败：不装 cordis，外层 error 带输出的最后几行，没有 data', async () => {
    writeHomeDependencies({ [KERNEL_PKG]: '0.3.0', cordis: '4.0.0-rc.9' })
    fakePnpm.runExitCode = 1
    const pm = mount({ entries: {} })
    expect(await pm.run('plugin-manager.update', { specs: { [KERNEL_PKG]: 'latest' } })).toEqual({
      ok: false,
      error: `pnpm add ${KERNEL_PKG}@latest 失败（退出码 1）。一条条目都没动\npnpm 说的原因`,
    })
    expect(fakePnpm.calls).toHaveLength(1)
  })
})
