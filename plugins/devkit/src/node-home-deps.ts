import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
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
 * 整目录删。**maxRetries 是给 Windows 的**:electron 刚停,子进程偶尔还握着目录几秒,
 * EBUSY 重试几次常能自愈;真被占死的让错误走出去——吞了它,「删掉了」就是句谎话。
 */
export const homeFs: HomeFs = {
  ...nodeFs,
  ensureDir(dir) {
    mkdirSync(dir, { recursive: true })
  },
  removeDir(dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}
