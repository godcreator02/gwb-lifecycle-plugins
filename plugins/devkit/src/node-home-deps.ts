import { spawn } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import type { HomeDeps, HomeFs } from './home.js'
import { hostAppFacts, hostAppSpawnPlan, RUN_TAIL_LINES } from './home.js'
import { tailLines } from './probes.js'
import { kill, nodeFs, portOwner, processName } from './node-probe-deps.js'

/**
 * `HomeDeps` 的真身:碰盘走 node:fs,开进程走系统。
 *
 * 与 node-probe-deps 同一个分工——这一层全是环境胶水,**不进单测**;时序与守卫的
 * 判断全在 home.ts 的纯机里,假件测试在那儿跑。能复用的判据(processName / kill /
 * portOwner)直接从 registry 那半拿:同一台机器,查 pid 与停 pid 的坑是同一批。
 */

/**
 * 起 electron 本体:**detached + unref,但不 `windowsHide`**。detached 是要让测试 home
 * 活过宿主退出;不 hide 是因为恰恰相反——这一扇窗就是要给人看的(registry 那半 hide,
 * 是它不该有脸)。electron 是 GUI 子系统的二进制,不会像控制台程序那样顶出一扇黑窗。
 * `error` 事件必须接:不接,spawn 失败会以未捕获异常的形式炸掉宿主进程。
 */
export function makeGuiSpawn(log: (message: string) => void): HomeDeps['spawn'] {
  return (plan, env) => {
    try {
      const child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env,
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', (err) => log(`测试 home 子进程起不来:${String(err)}`))
      child.unref()
      return child.pid
    } catch (err) {
      log(`测试 home 子进程起不来:${String(err)}`)
      return undefined
    }
  }
}

/**
 * `HomeDeps.appSpawnPlan` 的真身:从宿主进程自报的事实拼命令行。
 * 事实全在 process 上(execPath / argv),不 import `electron`——产物里不许有
 * 没有依赖兜底的裸名 import,而 electron 不该出现在任何包的依赖表里。
 */
export function makeAppSpawnPlan(): HomeDeps['appSpawnPlan'] {
  return async (cdp) => {
    const facts = hostAppFacts(process.execPath, process.argv)
    // argv[1] 可能是 `.` 这种相对写法——起子进程的 cwd 若不是内核自己的 cwd，它就指错地方；先钉成绝对
    const appPath = facts.appPath === undefined ? undefined : path.resolve(facts.appPath)
    return hostAppSpawnPlan({ execPath: process.execPath, packaged: facts.packaged, appPath }, cdp)
  }
}

/**
 * 前台跑一条命令到结束(底座安装是唯一的使用处):capture 合流输出,到上限杀掉。
 * **回尾巴不回全量**——全量没人读,build 失败时人要的是最后那段报错。
 */
export function runCaptured(
  plan: { command: string; args: string[]; cwd: string },
  timeoutMs: number,
): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    let out = ''
    const keep = (chunk: Buffer): void => {
      out += chunk.toString()
      // 长跑命令的输出可能很大,掐头留尾:尾巴才是报错住的地方
      if (out.length > 200_000) out = out.slice(-100_000)
    }
    let child
    try {
      child = spawn(plan.command, plan.args, { cwd: plan.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ ok: false, tail: String(err) })
      return
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, tail: `${tailLines(out, RUN_TAIL_LINES)}\n…(超 ${timeoutMs / 1000} 秒,已杀)` })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, tail: String(err) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, tail: tailLines(out, RUN_TAIL_LINES) })
    })
  })
}

/**
 * 一棵目录树自底向上删:文件 unlink、目录清空后 rmdir、**链接(pnpm 在 Windows 上的 junction)只删
 * 链接本身、不进去**。任何一步的错误原样抛出。
 *
 * **不用 `fs.rmSync({ recursive: true })`**:宿主 electron 带的 Node(24.19)在 Windows 上会**跟进
 * junction 删掉它指向的内容**(指向树外的也删),删到悬空的 junction 又静默停手、不抛错。pnpm 装过包
 * 的 home 里全是 junction:轻则删一半回成功,重则 link 进来的仓被删穿。自己走一遍树,链接不跟、
 * 错误不吞。
 */
export function removeTree(target: string): void {
  let stat
  try {
    stat = lstatSync(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(target)
    return
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(target)) removeTree(path.join(target, name))
    rmdirSync(target)
    return
  }
  try {
    unlinkSync(target)
  } catch (err) {
    // 只读文件在 Windows 上 unlink 回 EPERM:去掉只读再删一次,还不行就是真被占着,抛
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
    chmodSync(target, 0o666)
    unlinkSync(target)
  }
}

/**
 * 整目录删。错误原样带回:EBUSY/EPERM 是「还有进程握着里面的文件」的线索,吞了它「删掉了」
 * 就是句谎话。重试与「删完目录真不在」的核对在 home.ts 的 `removeHome` 里。
 */
export const homeFs: HomeFs = {
  ...nodeFs,
  ensureDir(dir) {
    mkdirSync(dir, { recursive: true })
  },
  removeDir(dir) {
    try {
      removeTree(dir)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}
