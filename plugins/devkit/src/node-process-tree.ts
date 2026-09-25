import { execFile, spawn, type ChildProcess } from 'node:child_process'

// 前台运行一条命令、超时终止整棵进程树并确认退出。真机器的那半；拼回执的两个纯函数有单元测试，整条链有真子进程的测试

/** 终止之后等整棵树退干净的上限。taskkill /F 是强制结束，正常几百毫秒内全部退出 */
export const TREE_EXIT_TIMEOUT_MS = 10_000
const TREE_EXIT_POLL_MS = 100

export interface TreePlan {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface OutputSink {
  stdout(chunk: Buffer): void
  stderr(chunk: Buffer): void
}

/** 整棵树都确认退出了才是 ok；`detail` 写终止了哪些进程 */
export type TreeKill = { ok: true; detail: string } | { ok: false; error: string }

export type RunEnd =
  | { kind: 'exited'; code: number | null }
  | { kind: 'failed-to-start'; error: string }
  | { kind: 'timed-out'; kill: TreeKill }

/** 超时那句话：终止成功与终止失败分开说，失败时调用方不该当作「子进程都停了」去恢复清单、删临时目录 */
export function timeoutNote(timeoutMs: number, kill: TreeKill): string {
  const seconds = String(timeoutMs / 1000)
  return kill.ok
    ? `超 ${seconds} 秒,已终止整棵进程树并确认都已退出(${kill.detail})`
    : `超 ${seconds} 秒,终止进程树没成:${kill.error}——它派生的子进程可能还在运行`
}

/** `taskkill /T` 每终止一个进程打一行，行里第一个数是它的 pid，括号里第二个是父 pid（树根的父进程是本进程，不能算进去） */
export function pidsInTaskkillOutput(output: string): number[] {
  const pids: number[] = []
  for (const line of output.split(/\r?\n/)) {
    const first = /\d+/.exec(line)
    if (first !== null && !pids.includes(Number(first[0]))) pids.push(Number(first[0]))
  }
  return pids
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 进程组里还有没有进程：`kill(-pgid, 0)` 回 ESRCH 就是组里一个都不剩 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, TREE_EXIT_POLL_MS))
  }
  return true
}

/** taskkill 的输出用控制台的代码页（中文系统是 GBK）；ASCII 是 GBK 的子集，英文系统的输出照样解得对 */
function decodeConsoleOutput(bytes: Buffer): string {
  return new TextDecoder('gbk').decode(bytes)
}

function runTaskkill(pid: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      const output = decodeConsoleOutput(Buffer.concat([stdout, stderr])).trim()
      resolve({ code, output: error !== null && output === '' ? error.message : output })
    })
  })
}

/** Windows：`taskkill /T /F` 按父子关系终止整棵树，再逐个确认它报出的每个 pid 都已退出 */
async function killTreeOnWindows(pid: number, rootExited: () => boolean): Promise<TreeKill> {
  const { code, output } = await runTaskkill(pid)
  if (code !== 0) {
    return { ok: false, error: `taskkill /T /F /PID ${String(pid)} 退出码 ${String(code)}:${output}` }
  }
  const pids = pidsInTaskkillOutput(output)
  const exited = await waitUntil(() => rootExited() && pids.every((one) => !isAlive(one)), TREE_EXIT_TIMEOUT_MS)
  if (!exited) {
    const alive = pids.filter(isAlive)
    return { ok: false, error: `taskkill 报了终止,可 ${String(TREE_EXIT_TIMEOUT_MS / 1000)} 秒后 pid ${alive.join('、')} 还没退` }
  }
  return { ok: true, detail: `pid ${pids.join('、')}` }
}

/** 别的平台：子进程启动时自成一个进程组（detached），对整组发 SIGKILL，等组里一个都不剩 */
async function killGroup(pid: number, rootExited: () => boolean): Promise<TreeKill> {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return { ok: false, error: `给进程组 ${String(pid)} 发 SIGKILL 没成:${String(err)}` }
  }
  const exited = await waitUntil(() => rootExited() && !groupAlive(pid), TREE_EXIT_TIMEOUT_MS)
  if (!exited) return { ok: false, error: `发了 SIGKILL,${String(TREE_EXIT_TIMEOUT_MS / 1000)} 秒后进程组 ${String(pid)} 里还有进程` }
  return { ok: true, detail: `进程组 ${String(pid)}` }
}

/**
 * 前台运行到结束；超时就终止整棵进程树，确认都退出了（或确认终止失败）才回。
 * 只结束最上面那个进程不够：pnpm 再启动的 node 还会接着改 home、发包，而调用方已经在恢复清单、删临时目录
 */
export function runWithTreeTimeout(plan: TreePlan, timeoutMs: number, sink: OutputSink): Promise<RunEnd> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // 别的平台靠进程组终止整棵树；Windows 上 taskkill /T 按父子关系找，detached 在那里只会多开一个控制台
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      resolve({ kind: 'failed-to-start', error: String(err) })
      return
    }
    child.stdout?.on('data', sink.stdout)
    child.stderr?.on('data', sink.stderr)
    let rootExited = false
    let settled = false
    child.once('exit', () => {
      rootExited = true
    })
    const timer = setTimeout(() => {
      settled = true
      const pid = child.pid
      if (pid === undefined) {
        resolve({ kind: 'timed-out', kill: { ok: false, error: '子进程没有 pid,无从终止' } })
        return
      }
      const kill = process.platform === 'win32' ? killTreeOnWindows(pid, () => rootExited) : killGroup(pid, () => rootExited)
      void kill.then((outcome) => resolve({ kind: 'timed-out', kill: outcome }))
    }, timeoutMs)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ kind: 'failed-to-start', error: String(err) })
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ kind: 'exited', code })
    })
  })
}
