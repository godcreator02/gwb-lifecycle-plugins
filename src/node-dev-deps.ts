import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tailLines } from './probes.js'
import { PUBLISH_TIMEOUT_MS, pnpmPlan, type DevDeps, type RunPlan } from './dev.js'
import type { ReleaseDeps } from './release.js'
import { runCaptured } from './node-home-deps.js'

/**
 * `DevDeps` 的真身:碰盘走 node:fs,开进程走系统,连 CDP 走包里那支驱动。
 *
 * 与另外两个 `node-*-deps` 同一个分工——这一层全是环境胶水、**不进单测**;守卫与时序的
 * 判断全在 `dev.ts` 的纯机里,假件测试在那儿跑。
 */

/**
 * 那支 CDP 驱动的身体。`../bin/` 两态都对:源码态本模块在 `src/`、产物态在 `dist/`,
 * 都是包根下一层。
 */
export const CDP_ENTRY = fileURLToPath(new URL('../bin/cdp.mjs', import.meta.url))

/** 回执尾巴留几行。全量没人读,报错住在尾巴上 */
const TAIL_LINES = 40

/**
 * 起一趟 CDP 动作,把它打出来的 JSON 收回来。
 *
 * **退出码与 JSON 两样都要**:那支驱动在「命令没跑成」时照样打一张完整的回执,只是把退出码
 * 置成非零。只看退出码会丢掉原因,只看 JSON 会把失败当成功。
 */
function runCdp(home: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; data: unknown; tail: string }> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(process.execPath, [CDP_ENTRY, home, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // 件跑在 Electron 主进程里,`process.execPath` 是 electron.exe:**不带
        // `ELECTRON_RUN_AS_NODE` 它会去开一扇窗,而不是跑那个 js**(node-cli 件同一个绕法)
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        // 这几个动作一个都不写盘(写盘的只有 shot 与 probe),所以给个中性的工作目录,
        // 别把内核的 cwd 带进去
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

/** 分发形态的清单。`[key: string]` 那格让「原样带过去」成立:包里别的字段一个都不该丢 */
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
 * 工作区里按包名找它当前的号(`workspace:` 依赖换范围时用)。
 *
 * **现扫,不认死 `packages/` 与 `plugins/` 这类目录名**:一仓一包与 monorepo 两种形状都要
 * 走得通,而目录怎么摆是各仓自己的事。只扫两层、跳过 `node_modules` 与点目录——再深就是
 * 在别人的依赖树里翻东西了。
 */
function workspaceVersions(repoDir: string, depth = 2): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string, left: number): void => {
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const doc = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
        if (typeof doc.name === 'string' && typeof doc.version === 'string') found.set(doc.name, doc.version)
      } catch {
        // 读不动就当没有:这儿只是在给 workspace: 找一个号,不是在校验别人的包
      }
    }
    if (left <= 0) return
    let kids: fs.Dirent[]
    try {
      kids = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const kid of kids) {
      if (!kid.isDirectory()) continue
      if (kid.name.startsWith('.') || kid.name === 'node_modules' || kid.name === 'dist') continue
      walk(path.join(dir, kid.name), left - 1)
    }
  }
  walk(repoDir, depth)
  return found
}

/**
 * 把一份清单改成能发出去的样子:
 *
 * - **号换成这一趟那个**
 * - **`scripts` 与 `devDependencies` 删掉**:分发包里没人跑它们,留着只会让装的那头去解析
 *   一堆开发期依赖
 * - **`workspace:` 换成真号**。临时目录不在工作区里,pnpm 不会替我们换,留着它装不上
 * - **这一趟同时发的那几个包,依赖一律钉成它们的 dev 号**。不钉的话 `>=x` 认不到 dev 版
 *   (semver 不拿预发布版满足不带预发布的范围),装出来就是「新件配旧库」,而且不报错
 */
export function distManifest(
  manifest: DistManifest,
  version: string,
  siblings: Record<string, string>,
  workspace: Map<string, string>,
): DistManifest {
  const out: DistManifest = { ...manifest, version }
  delete out.scripts
  delete out.devDependencies
  const fix = (table: Record<string, string> | undefined, pinSiblings: boolean): Record<string, string> | undefined => {
    if (table === undefined) return undefined
    const next: Record<string, string> = {}
    for (const [name, range] of Object.entries(table)) {
      const sibling = siblings[name]
      if (pinSiblings && sibling !== undefined) next[name] = sibling
      else if (range.startsWith('workspace:')) next[name] = `>=${workspace.get(name) ?? '0.0.0'}`
      else next[name] = range
    }
    return next
  }
  const deps = fix(out.dependencies, true)
  if (deps !== undefined) out.dependencies = deps
  // peer 那格不钉准确号:钉了就是逼着消费方也换版本,而 peer 说的本来就是「你自己带一个」
  const peers = fix(out.peerDependencies, false)
  if (peers !== undefined) out.peerDependencies = peers
  return out
}

/**
 * 发一个包的 staging 版。**在临时目录里摆一份分发形态再发,不改仓里的 package.json**:改仓里那份
 * 的话,中途摔了就留下一个号被动过的工作区,而那是最难认出来的现场。
 *
 * 开发版与正式版只差两处,都由调用方给:**打哪个 tag**(dev 不动 latest / latest)与
 * **同趟兄弟的依赖写什么**(开发版钉准确号,semver 的范围认不到预发布号;正式版给 `>=`
 * 范围,消费方跟得进后续 patch)。
 *
 * 带进分发包的东西**取自 `files` 白名单**,不在这儿另列一份——两份名单必然漂。
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
  // `files` 的三种写法分开对待。**带通配的那种当场拒**:这儿只会照字面复制,悄悄漏掉几个
  // 文件的代价是「发出去了、装上了、新写的东西没生效」,而那是这套里最难查的一种
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

  // 仓根按包目录往上找:`workspace:` 的号要在整个工作区里找,不是在这一个包里
  const repoDir = path.resolve(input.pkgDir, fs.existsSync(path.join(input.pkgDir, 'pnpm-workspace.yaml')) ? '.' : '..')
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-dev-'))
  try {
    for (const rel of positives) {
      const from = path.join(input.pkgDir, rel)
      if (!fs.existsSync(from)) return { ok: false, tail: `产物不在:${from}` }
      const to = path.join(stage, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      // cpSync 而不是 copyFileSync:`files` 里可以是目录(dist、skills、template 都是)
      fs.cpSync(from, to, { recursive: true, filter: (src) => !excludes.includes(path.basename(src)) })
    }
    const readme = [path.join(input.pkgDir, 'README.md'), path.join(repoDir, 'README.md')].find((one) => fs.existsSync(one))
    if (readme !== undefined) fs.copyFileSync(readme, path.join(stage, 'README.md'))
    fs.writeFileSync(
      path.join(stage, 'package.json'),
      JSON.stringify(distManifest(manifest, input.version, input.deps, workspaceVersions(repoDir)), null, 2) + '\n',
    )
    // **tag 由调用方给**:开发版标 dev 不动 latest(源上这些包同时被别的仓消费,开发版顶掉
    // latest 会让它们莫名其妙换了代码);正式版就是 latest
    return await runCaptured(
      pnpmPlan(['publish', '--no-git-checks', '--tag', input.tag, '--registry', input.registry], stage, process.platform),
      PUBLISH_TIMEOUT_MS,
    )
  } catch (err) {
    return { ok: false, tail: String(err) }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** 这台机器上的真身(「改一版看一版」那条链) */
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
  exists(target) {
    return fs.existsSync(target)
  },
  size(file) {
    try {
      return fs.statSync(file).size
    } catch {
      // 日志还没出生(刚开的 home)。基线当 0,于是整份都算增量,那正是实情
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
  platform: process.platform,
}

/** git 那一趟的上限。问一句状态而已,卡住说明 git 本身出了问题 */
const GIT_TIMEOUT_MS = 30_000

/**
 * 仓根的 git 树干不干净。git 是 exe(不像 pnpm 是 .cmd),不用借 cmd /c 一层。
 *
 * `runCaptured` 回的是 stdout 与 stderr 合流的尾巴,所以**按 porcelain 条目的长相认脏**
 * (两列状态加路径),合进来的别的行(git 的 safe.directory 警告之类)不拿来当脏——把它们
 * 算进去的话,一句无害的警告就能让这条链永远发不出版。
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

/** 这台机器上的真身(发正式版那条链)。publish 的真体与开发版共用同一套 staging,只差 tag 与依赖写法 */
export const releaseDeps: ReleaseDeps = {
  run: (plan: RunPlan, timeoutMs: number) => runCaptured(plan, timeoutMs),
  publish: (input) =>
    publishStaged({ pkgDir: input.pkgDir, version: input.version, registry: input.registry, tag: 'latest', deps: input.ranges }),
  published: async (spec, registry) => {
    const seen = await runCaptured(pnpmPlan(['view', spec, 'version', '--registry', registry], os.tmpdir(), process.platform), 60_000)
    return seen.ok
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
