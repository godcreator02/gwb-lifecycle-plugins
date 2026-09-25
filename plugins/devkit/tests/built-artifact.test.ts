import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactProblems } from '../src/artifact-check.js'

/**
 * 本包自己的构建产物（`pnpm build` 之后的 dist/）。没有 dist/index.js 时整组跳过——`pnpm check` 不构建。
 * 别的测试都从 src import，这一组查打包之后的那一份：发版前检查过不过，包内相对路径（bin/cdp.mjs、skills/、template/）
 * 在产物里还指不指得到
 */
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = path.join(pkgDir, 'dist', 'index.js')
const built = fs.existsSync(bundle)

if (!built) console.warn('[devkit] dist/index.js 还没生成，产物检查整组跳过（pnpm build 之后再运行）')

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const diskIo = { readText: (file: string) => (fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : undefined) }

type Handler = (args?: unknown) => unknown
interface Receipt {
  ok: boolean
  error?: string
  data?: unknown
}

interface MountedBundle {
  run(name: string, args?: unknown): Promise<Receipt>
  cdpEntry: string | undefined
  skillsDir: URL | undefined
}

/** 在假 ctx 上运行产物的 apply；局部注入里只有 node 命令行与说明书两处当场回调，记下产物交出去的路径，别的服务当作没装 */
async function mountBundle(homeDir: string): Promise<MountedBundle> {
  const { apply } = (await import(pathToFileURL(bundle).href)) as { apply: (ctx: unknown) => void }
  const handlers = new Map<string, Handler>()
  const mounted: MountedBundle = {
    cdpEntry: undefined,
    skillsDir: undefined,
    run: async (name, args) => {
      const handler = handlers.get(name)
      if (handler === undefined) throw new Error(`没有登记 ${name}`)
      return (await handler(args)) as Receipt
    },
  }
  const effect = (fn: () => unknown) => {
    fn()
    return () => {}
  }
  const services: Record<string, unknown> = {
    gwbNodeCli: { register: (def: { entry: string }) => (mounted.cdpEntry = def.entry) },
    gwbSkills: { register: (dir: URL) => (mounted.skillsDir = dir) },
  }
  const ctx: Record<string, unknown> = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect,
    inject: (names: string[], callback: (scoped: unknown) => void) => {
      if (names.every((name) => name in services)) callback({ effect, ...Object.fromEntries(names.map((name) => [name, services[name]])) })
      return () => {}
    },
    gwbKernel: { dataDir: homeDir, version: '0.6.0' },
    gwbCommands: {
      register: (def: { name: string }, handler: Handler) => {
        handlers.set(def.name, handler)
        return () => {}
      },
      list: () => [...handlers.keys()].map((name) => ({ name, plugin: '@godcreator/gwb-devkit' })),
      run: (name: string) => Promise.resolve({ ok: false, error: `没有这条命令：${name}` }),
    },
  }
  apply(ctx)
  return mounted
}

describe.skipIf(!built)('构建产物', () => {
  it('过得了发版前检查：包名 import 只剩 node 内置模块、electron 与 peer 里的包，相对 import 指的文件都在', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(artifactProblems(pkgDir, manifest, true, diskIo)).toEqual([])
  })

  it('node 侧打成一个文件：dist/ 里只有 index.js 一个 .js，唯一的相对 import 是随包发布的 bin/cdp.mjs', () => {
    expect(fs.readdirSync(path.join(pkgDir, 'dist')).filter((file) => file.endsWith('.js'))).toEqual(['index.js'])
    const relative = [...fs.readFileSync(bundle, 'utf8').matchAll(/^import\s[^'"]*from\s*"(\.[^"]+)"/gm)].map((m) => m[1])
    expect(relative).toEqual(['../bin/cdp.mjs'])
  })

  it('另起一个 node 进程直接 import 得起来：打包进来的 CommonJS 依赖 require 的 node 内置模块，在 ESM 产物里也找得到', () => {
    // vitest 给被测模块提供了 require，在它里面加载测不出这一条
    const script = `await import(${JSON.stringify(pathToFileURL(bundle).href)})`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: pkgDir, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })

  it('加载得起来，交出去的包内路径都指向包根下的真文件：cdp 脚本、说明书目录', async () => {
    const devkit = await mountBundle(tempDir('dk-bundle-home-'))
    expect(devkit.cdpEntry).toBe(path.join(pkgDir, 'bin', 'cdp.mjs'))
    expect(fs.existsSync(devkit.cdpEntry!)).toBe(true)
    expect(devkit.skillsDir === undefined ? undefined : fileURLToPath(devkit.skillsDir)).toBe(path.join(pkgDir, 'skills') + path.sep)
    expect(fs.existsSync(path.join(pkgDir, 'skills', 'gwb-devkit', 'SKILL.md'))).toBe(true)
  })

  it('找得到包内 template/：scaffold.plugin 往临时仓里写出插件包', async () => {
    const repoDir = path.join(tempDir('dk-bundle-repo-'), 'repo')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'x-workspace', private: true }))
    const devkit = await mountBundle(tempDir('dk-bundle-home-'))
    const receipt = await devkit.run('devkit.scaffold.plugin', { repo: repoDir, name: 'world' })
    expect(receipt.ok, receipt.error).toBe(true)
    expect(fs.existsSync(path.join(repoDir, 'plugins', 'world', 'src', 'index.ts'))).toBe(true)
  })

  it('参数不对照常回 ok false：命令处理函数在产物里是通的', async () => {
    const devkit = await mountBundle(tempDir('dk-bundle-home-'))
    expect((await devkit.run('devkit.home.new', { short: 'Bad Name' })).error).toContain('short 缺了或不是 kebab-case')
  })
})
