import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { spawnPlan } from './pnpm-path.js'

export { describePnpm } from './pnpm-path.js'
export { locatePnpm } from './pnpm-location.js'

/** 失败时回执带输出的最后几行：pnpm 把原因放在最后 */
export const TAIL_LINES = 12

/** 失败时要的输出在内存里最多留这么多字节；装一个大包的日志能有几 MB */
const MAX_TAIL_BYTES = 64_000

/** `runPnpmCapture` 的 stdout 上限，正常的 outdated 输出远小于它 */
const MAX_CAPTURED_STDOUT_BYTES = 4_000_000

export interface PnpmResult {
  /** 退出码 0 */
  ok: boolean
  exitCode: number | null
  /** 失败时才有：stdout 与 stderr 合起来的最后几行 */
  tail?: string
}

/** `runPnpmCapture` 的回执。不判 ok：退出码什么意思由调用方解释（`pnpm outdated` 用 1 表示「有过期」） */
export interface PnpmCaptureResult {
  /** null 是进程没启动成功，原因在 stderrTail 里 */
  exitCode: number | null
  stdout: string
  /** stderr 的最后几行：pnpm 把给人看的说明放在那里 */
  stderrTail: string
}

/** 取最后几行，去掉首尾空行 */
export function tailLines(text: string, max = TAIL_LINES): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  return lines.slice(-max).join('\n')
}

function spawnPnpm(file: string, cwd: string, args: readonly string[]): ChildProcessByStdio<null, Readable, Readable> {
  const plan = spawnPlan(file, args, process.env)
  return spawn(plan.command, plan.args, { cwd, env: plan.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 不抛：启动失败也整理成回执。不设超时：装大包本来可能要几分钟，网络层的超时 pnpm 自己有。
 * 本插件卸载时不结束正在运行的 pnpm（「插件卸载时清理自己启动的子进程」的例外）：中途结束会留下装了一半的 home
 */
export function runPnpm(opts: { pnpm: string; cwd: string; args: readonly string[] }): Promise<PnpmResult> {
  return new Promise((resolve) => {
    const tailChunks: Buffer[] = []
    let tailBytes = 0
    const keepTail = (chunk: Buffer): void => {
      tailChunks.push(chunk)
      tailBytes += chunk.length
      // 按整块丢弃，所以只有最后那次 concat 才可能切在多字节字符中间
      while (tailBytes > MAX_TAIL_BYTES && tailChunks.length > 1) tailBytes -= tailChunks.shift()!.length
    }
    const proc = spawnPnpm(opts.pnpm, opts.cwd, opts.args)

    let settled = false
    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      if (exitCode === 0) return resolve({ ok: true, exitCode })
      resolve({ ok: false, exitCode, tail: tailLines(Buffer.concat(tailChunks).toString('utf8')) })
    }

    proc.stdout?.on('data', (chunk: Buffer) => keepTail(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => keepTail(chunk))
    proc.on('error', (err) => {
      keepTail(Buffer.from(`${String(err)}\n`, 'utf8'))
      settle(null)
    })
    // 用 close 不用 exit：等两条管道都读完，否则 tail 可能缺最后一段，而失败原因正在那里
    proc.on('close', (code) => settle(code))
  })
}

/** 一次 add 失败 → 回执里的一句 `error` 与 `tail`。`what` 是给人看的那次操作的描述（`pnpm add a@1 b@2`） */
export function describeAddFailure(what: string, run: PnpmResult): { error: string; tail?: string } {
  const error = `${what} 失败（退出码 ${String(run.exitCode)}）`
  return run.tail === undefined ? { error } : { error, tail: run.tail }
}

/** stdout 全文带回、不判 ok：给 `pnpm outdated --json` 用，它的退出码 1 是结果不是失败 */
export function runPnpmCapture(opts: { pnpm: string; cwd: string; args: readonly string[] }): Promise<PnpmCaptureResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0

    const proc = spawnPnpm(opts.pnpm, opts.cwd, opts.args)

    let settled = false
    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderrTail: tailLines(Buffer.concat(stderrChunks).toString('utf8')),
      })
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_CAPTURED_STDOUT_BYTES) {
        stdoutBytes += chunk.length
        stdoutChunks.push(chunk)
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      stderrChunks.push(chunk)
      while (stderrBytes > MAX_TAIL_BYTES * 4 && stderrChunks.length > 1) stderrBytes -= stderrChunks.shift()!.length
    })
    proc.on('error', (error) => {
      stderrChunks.push(Buffer.from(`${String(error)}\n`, 'utf8'))
      settle(null)
    })
    proc.on('close', (code) => settle(code))
  })
}
