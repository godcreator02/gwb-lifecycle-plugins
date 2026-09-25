import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCaptured } from '../src/node-home-deps.js'
import { pidsInTaskkillOutput, timeoutNote } from '../src/node-process-tree.js'

/**
 * 超时要终止的是整棵进程树：pnpm 会再启动 node 去跑脚本，只结束最上面那个进程的话，下面的还在改 home、发包，
 * 调用方却已经开始恢复清单、删临时目录。这里用真的子进程演一遍：父进程再派生一个不接管道的孙进程，超时之后孙进程也必须没了
 */

/** 父进程：派生一个 stdio 全部 ignore 的孙进程（只靠管道关闭认不出它），把孙进程的 pid 写进文件，然后一直不退 */
const PARENT_SCRIPT = `
import { spawn } from 'node:child_process'
import fs from 'node:fs'
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
fs.writeFileSync(process.argv[2], String(grandchild.pid))
console.log('孙进程已启动')
setInterval(() => {}, 1000)
`

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

describe('超时终止整棵进程树（真子进程）', () => {
  const made: string[] = []
  const leftovers: number[] = []
  afterEach(async () => {
    // 修好之前孙进程会活下来，而它的工作目录在临时目录里：先结束、等它真退，目录才删得掉
    for (const pid of leftovers.splice(0)) {
      if (isAlive(pid)) process.kill(pid)
      for (let i = 0; i < 50 && isAlive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('父进程派生的孙进程也被终止，回执标明「已终止整棵树」', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-tree-'))
    made.push(dir)
    const script = path.join(dir, 'parent.mjs')
    const pidFile = path.join(dir, 'grandchild.pid')
    fs.writeFileSync(script, PARENT_SCRIPT)

    const result = await runCaptured({ command: process.execPath, args: [script, pidFile], cwd: dir, env: { ELECTRON_RUN_AS_NODE: '1' } }, 3_000)

    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
    leftovers.push(grandchild)
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe('tree-killed')
    expect(result.tail).toContain('孙进程已启动')
    expect(result.tail).toContain('已终止整棵进程树')
    expect(isAlive(grandchild)).toBe(false)
  }, 30_000)

  it('没超时的命令照常回退出码与输出，没有 timedOut', async () => {
    const result = await runCaptured({ command: process.execPath, args: ['-e', 'console.log("好了")'], cwd: os.tmpdir(), env: { ELECTRON_RUN_AS_NODE: '1' } }, 10_000)
    expect(result).toEqual({ ok: true, tail: '好了' })
  })
})

describe('taskkill 输出里的 pid', () => {
  it('每行只取第一个数（被终止的 pid），不取括号里的父 pid——树根的父进程就是 devkit 自己', () => {
    const english = [
      'SUCCESS: The process with PID 5120 (child process of PID 4100) has been terminated.',
      'SUCCESS: The process with PID 4100 (child process of PID 900) has been terminated.',
    ].join('\r\n')
    expect(pidsInTaskkillOutput(english)).toEqual([5120, 4100])
    const chinese = '成功: 已终止 PID 5120 (属于 PID 4100 子进程)的进程。\r\n成功: 已终止 PID 4100 (属于 PID 900 子进程)的进程。\r\n'
    expect(pidsInTaskkillOutput(chinese)).toEqual([5120, 4100])
  })
})

describe('超时的那句话', () => {
  it('终止成功与终止失败说法不同：失败时要说子进程可能还在运行', () => {
    expect(timeoutNote(300_000, { ok: true, detail: 'pid 1、2' })).toBe('超 300 秒,已终止整棵进程树并确认都已退出(pid 1、2)')
    expect(timeoutNote(300_000, { ok: false, error: 'taskkill 退出码 1' })).toBe(
      '超 300 秒,终止进程树没成:taskkill 退出码 1——它派生的子进程可能还在运行',
    )
  })
})
