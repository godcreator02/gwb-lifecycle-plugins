import { spawn } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import type { HomeDeps, HomeFs } from './home.js'
import { hostAppFacts, hostAppSpawnPlan, RUN_TAIL_LINES } from './home.js'
import { tailLines } from './probes.js'
import { kill, nodeFs, portOwner, processName } from './node-probe-deps.js'

// HomeDeps 在这台机器上的实现：读写磁盘、启动进程，没有单元测试；判断在 home.ts 里。查进程、结束进程用 node-probe-deps 的

/**
 * detached + unref 让测试 home 在宿主退出后还在运行；不 `windowsHide`：这个窗口就是给人看的。
 * `error` 事件必须监听：不监听，启动失败会变成未捕获的异常让宿主进程崩掉
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

/** 从宿主进程的 execPath / argv 拼命令行，不 import `electron`：产物里不许有没列进依赖的包名 import */
export function makeAppSpawnPlan(): HomeDeps['appSpawnPlan'] {
  return async (cdp) => {
    const facts = hostAppFacts(process.execPath, process.argv)
    // argv[1] 可能是 `.` 这种相对写法，子进程的工作目录不是内核的工作目录时会指错地方，先转成绝对路径
    const appPath = facts.appPath === undefined ? undefined : path.resolve(facts.appPath)
    return hostAppSpawnPlan({ execPath: process.execPath, packaged: facts.packaged, appPath }, cdp)
  }
}

/** 前台运行一条命令到结束：stdout 与 stderr 合在一起收，超时就结束进程；只回最后几行，报错在最后 */
export function runCaptured(
  plan: { command: string; args: string[]; cwd: string; env?: Record<string, string> },
  timeoutMs: number,
): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    let out = ''
    const keep = (chunk: Buffer): void => {
      out += chunk.toString()
      // 输出可能很大，只留后面一段：报错在最后
      if (out.length > 200_000) out = out.slice(-100_000)
    }
    let child
    try {
      const env = plan.env === undefined ? process.env : { ...process.env, ...plan.env }
      child = spawn(plan.command, plan.args, { cwd: plan.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
 * 自底向上删：文件 unlink、目录清空后 rmdir、链接（pnpm 在 Windows 上的 junction）只删链接本身，错误原样抛出。
 * 不用 `fs.rmSync({ recursive: true })`：宿主 electron 带的 Node（24.19）在 Windows 上会跟进 junction 删掉它指向的内容，
 * 遇到悬空的 junction 又不报错地停下
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
    // 只读文件在 Windows 上 unlink 回 EPERM：去掉只读再删一次，还不行就是真被占着，抛出
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
    chmodSync(target, 0o666)
    unlinkSync(target)
  }
}

/** removeDir 的错误原样带回：EBUSY/EPERM 是「还有进程握着里面的文件」的线索。重试与删完再核对在 home.ts 的 `removeHome` 里 */
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
