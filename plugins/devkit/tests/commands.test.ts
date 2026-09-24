import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

/**
 * 命令这一层：在假 ctx 上运行 `apply`，按命令名调登记下来的处理函数。只测不碰真机器的路径——
 * 参数校验、建仓与加插件（写到临时目录）；启动 home、发版、CDP 不在这里测
 */

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

  it('devkit.dev：给端口当场拒，home 名不合格也拒', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.dev', { cdp: 9401, dir: 'D:\\x' })).error).toContain('这儿不收端口了，只收 home 名')
    expect((await devkit.run('devkit.dev', { home: 'Bad' })).error).toContain('home 缺了或不是个合格的 home 名')
  })

  it('devkit.release：dir 不是绝对路径、不在，都拒', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.release', { dir: 'relative' })).error).toContain('dir 要是仓根的绝对路径')
    const missing = path.join(tempDir('dk-release-'), 'nope')
    expect((await devkit.run('devkit.release', { dir: missing })).error).toBe(`${missing} 不在——dir 给的是仓根，不是包目录`)
  })
})

function writeWorkspaceRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
  writeJson(path.join(repoDir, 'package.json'), { name: 'x-workspace', private: true, scripts: { build: 'pnpm -r build' } })
}

describe('devkit.scaffold 与 devkit.scaffold.plugin', () => {
  it('docs false、没装站点插件：插件文件照写，回执说没建站', async () => {
    const dir = path.join(tempDir('dk-scaffold-'), 'hello')
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    const receipt = await devkit.run('devkit.scaffold', { name: 'hello', dir, docs: false })
    expect(receipt.ok).toBe(true)
    const data = receipt.data as { repoDir: string; pluginDir: string; pkg: string; files: number; docs: { built: boolean; attached: boolean; note: string }; pluginPage: string | null }
    expect(data.repoDir).toBe(dir)
    expect(data.pluginDir).toBe(path.join(dir, 'plugins', 'hello'))
    expect(data.pkg).toBe('@godcreator/gwb-hello')
    expect(data.files).toBeGreaterThan(0)
    expect(data.docs).toMatchObject({ built: false, attached: false })
    expect(data.docs.note).toContain('没装站件')
    expect(data.pluginPage).toBeNull()
    expect(fs.existsSync(path.join(dir, 'plugins', 'hello', 'package.json'))).toBe(true)
  })

  it('有 docs-site.create、没有 docfirst.attach：骨架生成了、六区没装，回执说要立刻补', async () => {
    const dir = path.join(tempDir('dk-scaffold-'), 'hello')
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-'), busCommands: { 'docs-site.create': () => ({ ok: true, data: { port: 4321 } }) } })
    const receipt = await devkit.run('devkit.scaffold', { name: 'hello', dir })
    const data = receipt.data as { docs: { built: boolean; attached: boolean; port?: number; note: string }; nextSteps: string[] }
    expect(data.docs).toMatchObject({ built: true, attached: false, port: 4321 })
    expect(data.docs.note).toContain('六区没装')
    expect(devkit.busCalls).toEqual([{ name: 'docs-site.create', args: { dir: path.join(dir, 'docs-site'), title: 'hello' } }])
    expect(data.nextSteps.join('\n')).toContain('docfirst.attach')
  })

  it('目标目录已经存在：建仓没成，不覆盖', async () => {
    const dir = tempDir('dk-scaffold-')
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.scaffold', { name: 'hello', dir, docs: false })).error).toContain('建仓没成')
  })

  it('scaffold.plugin：往 workspace 仓的 plugins/ 加一个插件包', async () => {
    const repoDir = path.join(tempDir('dk-repo-'), 'repo')
    writeWorkspaceRepo(repoDir)
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    const receipt = await devkit.run('devkit.scaffold.plugin', { repo: repoDir, name: 'world' })
    expect(receipt.ok).toBe(true)
    expect(receipt.data).toMatchObject({ repoDir, pluginDir: path.join(repoDir, 'plugins', 'world'), pkg: '@godcreator/gwb-world', name: 'world', pluginPage: null })
    expect(fs.existsSync(path.join(repoDir, 'plugins', 'world', 'src', 'index.ts'))).toBe(true)
    expect((await devkit.run('devkit.scaffold.plugin', { repo: repoDir, name: 'world' })).error).toContain('加件没成')
  })
})
