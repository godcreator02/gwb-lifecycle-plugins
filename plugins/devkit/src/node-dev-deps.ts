import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tailLines } from './probes.js'
import { PUBLISH_TIMEOUT_MS, pnpmPlan, type DevDeps, type RunPlan } from './dev.js'
import type { ReleaseDeps } from './release.js'
import { removeTree, runCaptured } from './node-home-deps.js'

// DevDeps 与 ReleaseDeps 在这台机器上的实现：读写磁盘、启动进程、经 bin/cdp.mjs 连 CDP。
// 真机器操作的部分没有单元测试，判断都在 dev.ts 与 release.ts 里；distManifest 与找工作区的两个函数有测试

/** CDP 驱动脚本。从源码运行时本模块在 `src/`、从构建产物运行时在 `dist/`，都是包根下一层 */
export const CDP_ENTRY = fileURLToPath(new URL('../bin/cdp.mjs', import.meta.url))

/** 回执里输出留最后几行：报错在最后 */
const TAIL_LINES = 40

/** 退出码与 JSON 两样都要：命令没成功时驱动照样打印完整回执，只是退出码非零 */
function runCdp(home: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; data: unknown; tail: string }> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(process.execPath, [CDP_ENTRY, home, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // 插件运行在 Electron 主进程里，process.execPath 是 electron.exe：不带 ELECTRON_RUN_AS_NODE 它会开一个窗口，而不是运行脚本
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        // 驱动的路径一概不看工作目录；给一个无关的，别把内核的工作目录带进去
        cwd: os.tmpdir(),
      })
    } catch (error) {
      resolve({ ok: false, data: undefined, tail: String(error) })
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, data: undefined, tail: `等了 ${String(timeoutMs / 1000)} 秒没回,已杀。${tailLines(err, TAIL_LINES)}` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, data: undefined, tail: String(error) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      let data: unknown
      try {
        data = JSON.parse(out)
      } catch {
        data = undefined
      }
      resolve({ ok: code === 0, data, tail: tailLines(err === '' ? out : err, TAIL_LINES) })
    })
  })
}

/** 发布用的清单。`[key: string]` 让别的字段原样带过去，一个都不丢 */
interface DistManifest {
  name: string
  version: string
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

/**
 * 工作区里各包当前的版本号（`workspace:` 依赖换成范围时用）。扫目录、不写死 `packages/`、`plugins/` 这类目录名；
 * 只扫两层，跳过 `node_modules`、`dist` 与点开头的目录
 */
export function workspaceVersions(repoDir: string, depth = 2): Map<string, string> {
  const versionsByName = new Map<string, string>()
  const walk = (dir: string, levelsLeft: number): void => {
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const doc = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
        if (typeof doc.name === 'string' && typeof doc.version === 'string') versionsByName.set(doc.name, doc.version)
      } catch {
        // 读不了就当没有：这里只是给 workspace: 找一个版本号，不是在检查别人的包
      }
    }
    if (levelsLeft <= 0) return
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      if (child.name.startsWith('.') || child.name === 'node_modules' || child.name === 'dist') continue
      walk(path.join(dir, child.name), levelsLeft - 1)
    }
  }
  walk(repoDir, depth)
  return versionsByName
}

/** 从包目录往上第一个有 `pnpm-workspace.yaml` 的目录：包在 `plugins/<名>/` 时，它依赖的库可能在 `packages/` 下 */
export function workspaceRootOf(pkgDir: string): string {
  let dir = path.resolve(pkgDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = path.dirname(dir)
    if (up === dir) throw new Error(`从 ${pkgDir} 往上找到盘根都没有 pnpm-workspace.yaml——这个包不在 pnpm 工作区里`)
    dir = up
  }
}

/**
 * 版本号换成这次的；删掉 `scripts` 与 `devDependencies`；`workspace:` 换成 `^<工作区里的版本号>`（临时目录不在工作区里，
 * pnpm 不会替换）；同一次发的包（`siblings`）在 dependencies 里一律换成给的写法（开发版给准确版本号、正式版给 `^新版本号`）
 */
export function distManifest(
  manifest: DistManifest,
  version: string,
  siblings: Record<string, string>,
  workspace: Map<string, string>,
): DistManifest {
  const distributed: DistManifest = { ...manifest, version }
  delete distributed.scripts
  delete distributed.devDependencies
  const rewrittenRanges = (table: Record<string, string> | undefined, useSiblingRanges: boolean): Record<string, string> | undefined => {
    if (table === undefined) return undefined
    const rewritten: Record<string, string> = {}
    for (const [name, range] of Object.entries(table)) {
      const sibling = siblings[name]
      if (useSiblingRanges && sibling !== undefined) rewritten[name] = sibling
      else if (range.startsWith('workspace:')) rewritten[name] = `^${workspace.get(name) ?? '0.0.0'}`
      else rewritten[name] = range
    }
    return rewritten
  }
  const dependencies = rewrittenRanges(distributed.dependencies, true)
  if (dependencies !== undefined) distributed.dependencies = dependencies
  // peer 不写同一次发的准确版本号：写了就是逼消费方也换版本，peer 的意思本来是「你自己带一个」
  const peers = rewrittenRanges(distributed.peerDependencies, false)
  if (peers !== undefined) distributed.peerDependencies = peers
  return distributed
}

/**
 * 在临时目录组装发布内容再发，不改仓里的 package.json。开发版与正式版只差 tag 与同一次发的包的依赖写法，都由调用方给；
 * 带进去的东西取自 `files` 白名单
 */
async function publishStaged(input: {
  pkgDir: string
  version: string
  registry: string
  tag: 'dev' | 'latest'
  deps: Record<string, string>
}): Promise<{ ok: boolean; tail: string }> {
  let manifest: DistManifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(input.pkgDir, 'package.json'), 'utf8')) as DistManifest
  } catch (err) {
    return { ok: false, tail: `读不动 ${input.pkgDir} 的 package.json:${String(err)}` }
  }
  const files = manifest.files ?? []
  if (files.length === 0) return { ok: false, tail: `${manifest.name} 的 package.json 里 files 是空的,不知道该带什么进分发包` }
  // 带通配的当场拒：这里只按字面复制，悄悄漏掉文件的表现是「发出去了、装上了、新写的东西没生效」
  const positives = files.filter((one) => !one.startsWith('!'))
  const globbed = positives.filter((one) => /[*?]/.test(one))
  if (globbed.length > 0) {
    return {
      ok: false,
      tail: `${manifest.name} 的 files 里有通配(${globbed.join('、')}),这条链只认字面路径。把它写成实在的目录名,或者这一版走正路发(在仓里 pnpm publish)`,
    }
  }
  /** 否定式里那个末段名(`!py/**\/__pycache__` → `__pycache__`):复制完按名字剪掉 */
  const excludes = files
    .filter((one) => one.startsWith('!'))
    .map((one) => one.replace(/^!/, '').split(/[\\/]/).filter((seg) => seg !== '' && seg !== '**').pop())
    .filter((one): one is string => one !== undefined && !/[*?]/.test(one))

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-dev-'))
  try {
    const repoDir = workspaceRootOf(input.pkgDir)
    for (const rel of positives) {
      const from = path.join(input.pkgDir, rel)
      if (!fs.existsSync(from)) return { ok: false, tail: `产物不在:${from}` }
      const to = path.join(stage, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      // cpSync 不用 copyFileSync：files 里可以是目录（dist、skills、template 都是）
      fs.cpSync(from, to, { recursive: true, filter: (src) => !excludes.includes(path.basename(src)) })
    }
    const readme = [path.join(input.pkgDir, 'README.md'), path.join(repoDir, 'README.md')].find((one) => fs.existsSync(one))
    if (readme !== undefined) fs.copyFileSync(readme, path.join(stage, 'README.md'))
    fs.writeFileSync(
      path.join(stage, 'package.json'),
      JSON.stringify(distManifest(manifest, input.version, input.deps, workspaceVersions(repoDir)), null, 2) + '\n',
    )
    // 开发版标 dev、不动 latest：源上这些包同时被别的仓使用，开发版占了 latest 它们就不明不白地换了代码
    return await runCaptured(
      pnpmPlan(['publish', '--no-git-checks', '--tag', input.tag, '--registry', input.registry], stage, process.platform),
      PUBLISH_TIMEOUT_MS,
    )
  } catch (err) {
    return { ok: false, tail: String(err) }
  } finally {
    // 不用 fs.rmSync 递归删：宿主的 Node 会跟进 junction，见 removeTree
    try {
      removeTree(stage)
    } catch {
      // 临时目录删不掉不影响这次的结论，留在 tmp 里
    }
  }
}

/** 「改一版看一版」在这台机器上的实现 */
export const devDeps: DevDeps = {
  run: (plan: RunPlan, timeoutMs: number) => runCaptured(plan, timeoutMs),
  cdp: runCdp,
  publish: (input) =>
    publishStaged({ pkgDir: input.pkgDir, version: input.version, registry: input.registry, tag: 'dev', deps: input.siblings }),
  async published(spec, registry) {
    const seen = await runCaptured(pnpmPlan(['view', spec, 'version', '--registry', registry], os.tmpdir(), process.platform), 60_000)
    return seen.ok
  },
  readText(file) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  },
  writeText(file, text) {
    try {
      fs.writeFileSync(file, text, 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  },
  exists(target) {
    return fs.existsSync(target)
  },
  size(file) {
    try {
      return fs.statSync(file).size
    } catch {
      // 日志还不存在（刚开的 home）：基线当 0，整份都算新增，这正是实情
      return 0
    }
  },
  slice(file, from) {
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const end = fs.fstatSync(fd).size
        // 日志被轮转或清过,`from` 会大过现在的长度。那时从头读,别回一段空的
        const start = from > end ? 0 : from
        const buffer = Buffer.alloc(end - start)
        fs.readSync(fd, buffer, 0, buffer.length, start)
        return buffer.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return ''
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
}

/** git status 的上限。卡住说明 git 本身出了问题 */
const GIT_TIMEOUT_MS = 30_000

/**
 * git 是 exe（不像 pnpm 是 .cmd），不用经 cmd /c。runCaptured 回的是 stdout 与 stderr 合在一起的最后几行，
 * 所以按 porcelain 条目的样子认改动：safe.directory 警告之类不算，不然一句无害的警告就让发版永远不成
 */
async function gitStatusOf(repoDir: string): Promise<{ ok: true; dirty: string[] } | { ok: false; error: string }> {
  const out = await runCaptured({ command: 'git', args: ['status', '--porcelain=v1'], cwd: repoDir }, GIT_TIMEOUT_MS)
  if (!out.ok) return { ok: false, error: out.tail === '' ? 'git status 没成(git 不在?)' : out.tail }
  const dirty = out.tail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^[ MADRCU?!]{1,3}\s+\S/.test(line))
  return { ok: true, dirty }
}

/** 发正式版在这台机器上的实现。publish 与开发版共用 publishStaged，只差 tag 与依赖写法 */
export const releaseDeps: ReleaseDeps = {
  run: (plan: RunPlan, timeoutMs: number) => runCaptured(plan, timeoutMs),
  publish: (input) =>
    publishStaged({ pkgDir: input.pkgDir, version: input.version, registry: input.registry, tag: 'latest', deps: input.ranges }),
  published: async (spec, registry) => {
    const seen = await runCaptured(pnpmPlan(['view', spec, 'version', '--registry', registry], os.tmpdir(), process.platform), 60_000)
    return seen.ok
  },
  latest: async (pkg, registry) => {
    const seen = await runCaptured(pnpmPlan(['view', pkg, 'dist-tags.latest', '--registry', registry], os.tmpdir(), process.platform), 60_000)
    if (!seen.ok) return undefined
    const lines = seen.tail.split(/\r?\n/).map((line) => line.trim())
    return lines.reverse().find((line) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(line))
  },
  gitStatus: gitStatusOf,
  readText(file) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  },
  exists(target) {
    return fs.existsSync(target)
  },
  platform: process.platform,
}
