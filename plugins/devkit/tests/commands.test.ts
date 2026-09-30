import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import type { PnpmLookupForComponents } from '../src/node-shadcn-deps.js'
import { fakePnpm } from './fake-shadcn-pnpm.js'

/**
 * 命令这一层：在假 ctx 上运行 `apply`，按命令名调登记下来的处理函数。只测不碰真机器的路径——
 * 参数校验、建仓与加插件（写到临时目录）；启动 home、发版、CDP 不在这里测。
 * 建仓后添加 shadcn 组件要找 pnpm、联网：找 pnpm 的模块换成假的，交出照实测样子改清单的假 pnpm
 */

const pnpmLookup = vi.hoisted(() => ({ missing: undefined as string | undefined, calls: [] as { dir: string; args: string[] }[] }))
vi.mock('../src/node-shadcn-deps.js', () => ({
  pnpmForComponents: (): Promise<PnpmLookupForComponents> =>
    Promise.resolve(
      pnpmLookup.missing !== undefined
        ? { ok: false, error: pnpmLookup.missing }
        : {
            ok: true,
            inDir: (dir: string) => {
              const fake = fakePnpm(dir)
              return async (args: string[]) => {
                pnpmLookup.calls.push({ dir, args })
                return fake.pnpm(args)
              }
            },
          },
    ),
}))
afterEach(() => {
  pnpmLookup.missing = undefined
  pnpmLookup.calls.splice(0)
})

type Handler = (args?: unknown) => unknown
interface Receipt {
  ok: boolean
  error?: string
  data?: unknown
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

interface Mounted {
  run(name: string, args?: unknown): Promise<Receipt>
  busCalls: { name: string; args: unknown }[]
}

function mountDevkit(opts: { homeDir: string; busCommands?: Record<string, (args: unknown) => Receipt> }): Mounted {
  const handlers = new Map<string, Handler>()
  const busCalls: { name: string; args: unknown }[] = []
  const busCommands = opts.busCommands ?? {}
  const ctx: Record<string, unknown> = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    inject: () => () => {},
    gwbKernel: { dataDir: opts.homeDir, version: '0.2.7' },
    gwbCommands: {
      register: (def: { name: string; plugin: string }, handler: Handler) => {
        handlers.set(def.name, handler)
        return () => {}
      },
      list: () => [...[...handlers.keys()].map((name) => ({ name, plugin: '@godcreator/gwb-devkit' })), ...Object.keys(busCommands).map((name) => ({ name, plugin: '@x/other' }))],
      run: (name: string, args: unknown) => {
        busCalls.push({ name, args })
        const command = busCommands[name]
        return Promise.resolve(command === undefined ? { ok: false, error: `没有这条命令：${name}` } : command(args))
      },
    },
  }
  apply(ctx as never)
  return {
    busCalls,
    run: async (name, args) => {
      const handler = handlers.get(name)
      if (handler === undefined) throw new Error(`没有登记 ${name}`)
      return (await handler(args)) as Receipt
    },
  }
}

describe('加载', () => {
  it('命令总线不在就抛：插件加载失败，而不是命令表不声不响地空着', () => {
    const ctx = { logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }), inject: () => () => {} }
    expect(() => apply(ctx as never)).toThrow(/gwbCommands/)
  })
})

describe('参数不对：回 ok false，带上那条命令的用法', () => {
  it('参数不是对象', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    const expectations: [string, string][] = [
      ['devkit.home.new', 'home 命令的参数'],
      ['devkit.home.open', 'home 命令的参数'],
      ['devkit.home.rm', 'home 命令的参数'],
      ['devkit.dev', 'devkit.dev 的参数'],
      ['devkit.release', 'devkit.release 的参数'],
      ['devkit.scaffold', 'devkit.scaffold 的参数'],
      ['devkit.scaffold.plugin', 'devkit.scaffold.plugin 的参数'],
    ]
    for (const [name, usageHeader] of expectations) {
      const receipt = await devkit.run(name, 'not an object')
      expect(receipt.ok, name).toBe(false)
      expect(receipt.error, name).toContain('参数要是个对象')
      expect(receipt.error, name).toContain(usageHeader)
    }
  })

  it('home 名不合格', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.home.new', { short: 'Bad Name' })).error).toContain('short 缺了或不是 kebab-case')
    expect((await devkit.run('devkit.home.open', {})).error).toContain('name 缺了或不是 kebab-case')
    expect((await devkit.run('devkit.home.rm', { name: '' })).error).toContain('name 缺了或不是 kebab-case')
  })

  it('devkit.dev：home 名不合格就拒', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.dev', { home: 'Bad', packages: ['plugins/x'] })).error).toContain('home 缺了或不是个合格的 home 名')
  })

  it('每条命令都拒认不出的参数键，报出是哪几个键，连同那条命令的用法', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    const calls: [string, Record<string, unknown>, string][] = [
      ['devkit.home.new', { short: 'x', cdp: 9401 }, 'home 命令的参数'],
      ['devkit.home.open', { name: 'x', port: 1 }, 'home 命令的参数'],
      ['devkit.home.rm', { name: 'x', froce: true }, 'home 命令的参数'],
      ['devkit.home.list', { all: true }, '无参数'],
      ['devkit.dev', { home: 'x', dir: 'D:\\x', packages: ['plugins/x'], cdp: 9401 }, 'devkit.dev 的参数'],
      ['devkit.release', { dir: 'D:\\x', packages: ['plugins/x'], tag: 'next' }, 'devkit.release 的参数'],
      ['devkit.scaffold', { name: 'x', dir: 'D:\\x', port: 4321 }, 'devkit.scaffold 的参数'],
      ['devkit.scaffold', { name: 'x', dir: 'D:\\x', title: '打招呼' }, 'devkit.scaffold 的参数'],
      ['devkit.scaffold', { name: 'x', dir: 'D:\\x', docs: false }, 'devkit.scaffold 的参数'],
      ['devkit.scaffold.plugin', { name: 'x', repo: 'D:\\x', docs: false }, 'devkit.scaffold.plugin 的参数'],
      ['devkit.scaffold.plugin', { name: 'x', repo: 'D:\\x', title: '打招呼' }, 'devkit.scaffold.plugin 的参数'],
    ]
    for (const [name, args, usageHeader] of calls) {
      const unknownKey = Object.keys(args).at(-1) ?? ''
      const receipt = await devkit.run(name, args)
      expect(receipt.ok, name).toBe(false)
      expect(receipt.error, name).toContain(`不认识参数 ${unknownKey}`)
      expect(receipt.error, name).toContain(usageHeader)
    }
  })

  it('devkit.release：dir 不是绝对路径、不在，都拒', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.release', { dir: 'relative', packages: ['plugins/x'] })).error).toContain('dir 要是仓根的绝对路径')
    const missing = path.join(tempDir('dk-release-'), 'nope')
    expect((await devkit.run('devkit.release', { dir: missing, packages: ['plugins/x'] })).error).toBe(`${missing} 不在——dir 给的是仓根，不是包目录`)
  })

  it('devkit.dev 与 devkit.release：packages 必给，要是非空的字符串数组，不给或写错直接拒', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    const dir = tempDir('dk-repo-')
    const wrongPackages: unknown[] = [undefined, [], 'plugins/x', ['plugins/x', 1], ['']]
    for (const name of ['devkit.dev', 'devkit.release']) {
      for (const packages of wrongPackages) {
        const receipt = await devkit.run(name, { ...(name === 'devkit.dev' ? { home: 'x-2609250000' } : {}), dir, ...(packages === undefined ? {} : { packages }) })
        expect(receipt.ok, `${name} ${JSON.stringify(packages)}`).toBe(false)
        expect(receipt.error, `${name} ${JSON.stringify(packages)}`).toContain('packages 必给')
      }
    }
  })
})

function writeWorkspaceRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
  writeJson(path.join(repoDir, 'package.json'), { name: 'x-workspace', private: true, scripts: { build: 'pnpm -r build' } })
}

/** 装着命令总线与外壳的 home：建仓与加插件照它装着的版本写模板插件的 peer */
function homeWithCommandsAndShell(): string {
  const homeDir = tempDir('dk-home-')
  writeJson(path.join(homeDir, 'node_modules', '@godcreator', 'gwb-commands', 'package.json'), { name: '@godcreator/gwb-commands', version: '0.5.2' })
  writeJson(path.join(homeDir, 'node_modules', '@godcreator', 'gwb-shell', 'package.json'), { name: '@godcreator/gwb-shell', version: '0.14.1' })
  return homeDir
}

describe('devkit.scaffold 与 devkit.scaffold.plugin', () => {
  it('建仓：插件文件写到磁盘，回执只报仓与插件包；不建文档站，也不调别的插件的命令', async () => {
    const dir = path.join(tempDir('dk-scaffold-'), 'hello')
    const devkit = mountDevkit({
      homeDir: homeWithCommandsAndShell(),
      busCommands: { 'docs-site.create': () => ({ ok: true, data: { port: 4321 } }), 'docfirst.attach': () => ({ ok: true, data: {} }) },
    })
    const receipt = await devkit.run('devkit.scaffold', { name: 'hello', dir })
    expect(receipt.ok).toBe(true)
    const data = receipt.data as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['components', 'files', 'name', 'nextSteps', 'pkg', 'pluginDir', 'registry', 'repoDir'])
    expect(data).toMatchObject({ repoDir: dir, pluginDir: path.join(dir, 'plugins', 'hello'), pkg: '@godcreator/gwb-hello', name: 'hello', components: ['button'] })
    expect(data['files']).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(dir, 'plugins', 'hello', 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'docs-site'))).toBe(false)
    expect(devkit.busCalls).toEqual([])
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugins', 'hello', 'package.json'), 'utf8')) as { peerDependencies: Record<string, string> }
    expect(manifest.peerDependencies).toMatchObject({ '@godcreator/gwb-commands': '^0.5.2', '@godcreator/gwb-shell': '^0.14.1' })
  })

  it('建仓：写完文件后在插件包目录加 shadcn 的 button，组件依赖都在 devDependencies', async () => {
    const dir = path.join(tempDir('dk-scaffold-'), 'hello')
    const devkit = mountDevkit({ homeDir: homeWithCommandsAndShell() })
    expect((await devkit.run('devkit.scaffold', { name: 'hello', dir })).ok).toBe(true)
    const pluginDir = path.join(dir, 'plugins', 'hello')
    expect(pnpmLookup.calls.map((call) => call.dir)).toEqual([pluginDir, pluginDir])
    expect(pnpmLookup.calls[0]?.args).toEqual(['dlx', 'shadcn@latest', 'add', 'button', '--yes'])
    expect(fs.existsSync(path.join(pluginDir, 'components.json'))).toBe(true)
    expect(fs.existsSync(path.join(pluginDir, 'src', 'client', 'components', 'ui', 'button.tsx'))).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')) as { dependencies?: unknown; devDependencies: Record<string, string> }
    expect(manifest.dependencies).toBeUndefined()
    for (const name of ['cn', 'radix-ui', 'class-variance-authority']) expect(manifest.devDependencies[name], name).toBeDefined()
  })

  it('找不到 pnpm：建仓与加插件都拒，什么都不写', async () => {
    pnpmLookup.missing = '找不到 pnpm。只认这两个位置'
    const devkit = mountDevkit({ homeDir: homeWithCommandsAndShell() })
    const dir = path.join(tempDir('dk-scaffold-'), 'hello')
    const scaffold = await devkit.run('devkit.scaffold', { name: 'hello', dir })
    expect(scaffold.error).toBe('建仓没成，什么都没写：找不到 pnpm。只认这两个位置')
    expect(fs.existsSync(dir)).toBe(false)
    const repoDir = path.join(tempDir('dk-repo-'), 'repo')
    writeWorkspaceRepo(repoDir)
    const plugin = await devkit.run('devkit.scaffold.plugin', { repo: repoDir, name: 'world' })
    expect(plugin.error).toBe('加插件没成，什么都没写：找不到 pnpm。只认这两个位置')
    expect(fs.existsSync(path.join(repoDir, 'plugins'))).toBe(false)
  })

  it('home 里没装外壳：拒，不写任何文件，报错写出没装哪个包', async () => {
    const dir = path.join(tempDir('dk-scaffold-'), 'hello')
    const homeDir = tempDir('dk-home-')
    writeJson(path.join(homeDir, 'node_modules', '@godcreator', 'gwb-commands', 'package.json'), { name: '@godcreator/gwb-commands', version: '0.5.2' })
    const devkit = mountDevkit({ homeDir })
    const receipt = await devkit.run('devkit.scaffold', { name: 'hello', dir })
    expect(receipt.ok).toBe(false)
    expect(receipt.error).toContain('没装 @godcreator/gwb-shell')
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('目标目录已经存在：建仓没成，不覆盖', async () => {
    const dir = tempDir('dk-scaffold-')
    const devkit = mountDevkit({ homeDir: homeWithCommandsAndShell() })
    expect((await devkit.run('devkit.scaffold', { name: 'hello', dir })).error).toContain('建仓没成')
  })

  it('scaffold.plugin：往 workspace 仓的 plugins/ 加一个插件包；仓里有文档站也不往里写插件页', async () => {
    const repoDir = path.join(tempDir('dk-repo-'), 'repo')
    writeWorkspaceRepo(repoDir)
    fs.mkdirSync(path.join(repoDir, 'docs-site', 'content', 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'docs-site', 'docfirst.config.mjs'), 'export default {}\n')
    const devkit = mountDevkit({ homeDir: homeWithCommandsAndShell() })
    const receipt = await devkit.run('devkit.scaffold.plugin', { repo: repoDir, name: 'world' })
    expect(receipt.ok).toBe(true)
    const data = receipt.data as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['components', 'files', 'name', 'nextSteps', 'pkg', 'pluginDir', 'registry', 'repoDir'])
    expect(data).toMatchObject({ repoDir, pluginDir: path.join(repoDir, 'plugins', 'world'), pkg: '@godcreator/gwb-world', name: 'world', components: ['button'] })
    expect(fs.existsSync(path.join(repoDir, 'plugins', 'world', 'src', 'index.ts'))).toBe(true)
    expect(fs.existsSync(path.join(repoDir, 'plugins', 'world', 'src', 'client', 'components', 'ui', 'button.tsx'))).toBe(true)
    expect(pnpmLookup.calls.every((call) => call.dir === path.join(repoDir, 'plugins', 'world'))).toBe(true)
    expect(fs.existsSync(path.join(repoDir, 'docs-site', 'content', 'docs', 'plugins'))).toBe(false)
    expect((await devkit.run('devkit.scaffold.plugin', { repo: repoDir, name: 'world' })).error).toContain('加插件没成')
  })
})