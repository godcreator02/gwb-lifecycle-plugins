import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

/**
 * 命令这一层：在假 ctx 上运行 `apply`，按命令名调登记下来的处理函数。只测不碰真机器的路径——
 * 参数校验、按容器根扫仓、服务表、import 面、建仓与加插件（写到临时目录）；启动 home、发版、CDP 不在这里测
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

function mountDevkit(opts: { homeDir: string; busCommands?: Record<string, (args: unknown) => Receipt>; fiber?: unknown }): Mounted {
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
    ...(opts.fiber === undefined ? {} : { fiber: opts.fiber }),
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
      ['devkit.audit-structure', 'devkit.audit-structure 的参数'],
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

describe('devkit.audit-structure', () => {
  it('给 dir：体检这一个仓', async () => {
    const repoDir = path.join(tempDir('dk-repo-'), 'repo')
    writeWorkspaceRepo(repoDir)
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    const receipt = await devkit.run('devkit.audit-structure', { dir: repoDir })
    expect(receipt).toEqual({ ok: true, data: { repoDir, shape: 'workspace', findings: [], byKind: {} } })
    expect((await devkit.run('devkit.audit-structure', { dir: path.join(repoDir, 'nope') })).error).toContain('不在——dir 给的是仓根的绝对路径')
  })

  it('不给 dir 与 root：问 unit-folder.list 要容器根，扫下面的仓', async () => {
    const container = tempDir('dk-container-')
    const repoDir = path.join(container, 'abcde-x', 'repo')
    writeWorkspaceRepo(repoDir)
    fs.mkdirSync(path.join(repoDir, '.git'))
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-'), busCommands: { 'unit-folder.list': () => ({ ok: true, data: { container } }) } })
    const receipt = await devkit.run('devkit.audit-structure', {})
    expect(receipt.ok).toBe(true)
    expect(receipt.data).toMatchObject({ root: container, repos: 1, shape: { workspace: 1 }, findings: [], retired: [], testUnits: [] })
    expect(devkit.busCalls).toEqual([{ name: 'unit-folder.list', args: {} }])
  })

  it('没有 unit-folder.list 也没给 root：说清扫哪', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.audit-structure', {})).error).toContain('扫哪没说清')
  })
})

describe('devkit.audit-deps', () => {
  it('没有 unit-folder.list 也没给 root：说清扫哪', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.audit-deps')).error).toContain('扫哪没说清')
  })

  it('容器根下一份带 @godcreator 依赖的清单都没有：拒，不联网', async () => {
    const container = tempDir('dk-container-')
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    expect((await devkit.run('devkit.audit-deps', { root: container })).error).toContain('一份带 @godcreator 依赖的 package.json 都没扫到')
    expect((await devkit.run('devkit.audit-deps', { root: path.join(container, 'nope') })).error).toContain('不在——root 给的是容器根')
  })
})

describe('devkit.services 与 devkit.capabilities', () => {
  it('services：服务表来自 ctx 的 fiber，用法从 home 里那个包的 gwb.provides 贴上', async () => {
    const homeDir = tempDir('dk-home-')
    writeJson(path.join(homeDir, 'node_modules', '@x', 'gwb-foo', 'package.json'), { name: '@x/gwb-foo', gwb: { provides: { gwbFoo: { summary: '一句话', usage: '怎么用' } } } })
    const fiber: Record<string, unknown> = { entry: { id: 'home:foo', options: { name: '@x/gwb-foo' } } }
    fiber['store'] = { one: { name: 'gwbFoo', fiber } }
    const devkit = mountDevkit({ homeDir, fiber })
    expect(await devkit.run('devkit.services')).toEqual({
      ok: true,
      data: { services: [{ service: 'gwbFoo', entryId: 'home:foo', pkg: '@x/gwb-foo', provides: { summary: '一句话', usage: '怎么用' } }] },
    })
  })

  it('services：没有 fiber 时回空表，带 note 与 saw', async () => {
    const devkit = mountDevkit({ homeDir: tempDir('dk-home-') })
    const receipt = await devkit.run('devkit.services')
    expect(receipt.ok).toBe(true)
    expect(receipt.data).toMatchObject({ services: [], saw: { chainDepth: 0, runtimes: 0, fibers: 0, stores: 0 } })
    expect((receipt.data as { note: string }).note).toContain('运行时没给出服务表')
  })

  it('capabilities：import 段按 home 的 dependencies 列，home 清单读不到时是空表', async () => {
    const homeDir = tempDir('dk-home-')
    const devkit = mountDevkit({ homeDir })
    expect(await devkit.run('devkit.capabilities')).toEqual({
      ok: true,
      data: { inject: [], import: [], commands: '件暴露的命令面不在这儿重复——search {"plugin":"<包名>"} 按件查，那是命令的家' },
    })
    writeJson(path.join(homeDir, 'package.json'), { dependencies: { '@x/lib': '^1.0.0' } })
    writeJson(path.join(homeDir, 'node_modules', '@x', 'lib', 'package.json'), {
      name: '@x/lib',
      version: '1.0.0',
      keywords: ['gwb'],
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    })
    const receipt = await devkit.run('devkit.capabilities')
    expect((receipt.data as { import: unknown }).import).toEqual([
      { pkg: '@x/lib', version: '1.0.0', kind: '库', entries: [{ specifier: '@x/lib', dts: 'node_modules/@x/lib/dist/index.d.ts' }] },
    ])
  })
})

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
