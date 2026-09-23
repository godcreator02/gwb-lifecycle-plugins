import { spawn, type ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { parsePeerCheck, type PeerWarning } from './peer-warnings.js'
import { findPnpm, spawnPlan, type LookupResult } from './pnpm-path.js'

export { describePnpm } from './pnpm-path.js'

/** 实际运行 pnpm。查磁盘与启动进程都在这里，纯逻辑部分在 `pnpm-path.ts` */

/** 出错时把输出的最后几行返回给调用方——pnpm 把原因放在最后几行 */
export const TAIL_LINES = 12

/** 输出在内存里最多留这么多字节。装一个大包的日志能有几 MB，全留着没意义 */
const MAX_TAIL_BYTES = 64_000

export interface PnpmResult {
  /** 退出码 0 */
  ok: boolean
  exitCode: number | null
  /** 没成时才有：stdout 与 stderr 合起来的最后几行 */
  tail?: string
}

/** `runPnpmCapture` 的回执。不判 ok——退出码什么意思由调用方解释（`pnpm outdated` 用 1 当「有过期」） */
export interface PnpmCaptureResult {
  /** null 是进程没启动成功（pnpm 不存在之类），原因在 stderrTail 里 */
  exitCode: number | null
  /** stdout 全文。outdated 的 JSON 在这里 */
  stdout: string
  /** stderr 的最后几行——pnpm 把给人看的说明放在那里 */
  stderrTail: string
}

/** 取最后几行，去掉首尾空行。纯逻辑，单独测 */
export function tailLines(text: string, max = TAIL_LINES): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  return lines.slice(-max).join('\n')
}

/** 查这台机器上的 pnpm。`configured` 是设置项 `pnpm-path` 的值 */
export function locatePnpm(configured?: string): LookupResult {
  return findPnpm({
    configured,
    pathEnv: process.env['PATH'],
    delimiter: path.delimiter,
    sep: path.sep,
    platform: process.platform,
    arch: process.arch,
    stat: (file) => {
      const found = fs.statSync(file, { throwIfNoEntry: false })
      if (found === undefined) return undefined
      return found.isDirectory() ? 'dir' : 'file'
    },
    realpath: (file) => {
      try {
        return fs.realpathSync.native(file)
      } catch {
        return file
      }
    },
    pnpmVersion: (dir) => {
      try {
        const manifest: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
        if (typeof manifest !== 'object' || manifest === null) return undefined
        const { name, version } = manifest as { name?: unknown; version?: unknown }
        return name === 'pnpm' && typeof version === 'string' ? version : undefined
      } catch {
        return undefined
      }
    },
  })
}

/** 直接启动 pnpm 可执行文件，stdout / stderr 走管道 */
function spawnPnpm(file: string, cwd: string, args: readonly string[]): ChildProcessByStdio<null, Readable, Readable> {
  const plan = spawnPlan(file, args, process.env)
  return spawn(plan.command, plan.args, { cwd, env: plan.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 运行一次 pnpm。**不抛**——启动失败也整理成一份回执，调用方只看 ok。
 *
 * **启动的是查找得到的那个文件，不是 `spawn('pnpm')`**：Windows 上 PATH 里的 `pnpm.ps1` /
 * `pnpm.cmd` 不是可执行映像，spawn 认不出；`shell: true` 能绕过去但会带来引号转义的问题。
 * 环境怎么传见 `spawnPlan`。
 *
 * **不设超时**：装一个大包本来就可能几分钟，猜一个时限只会在慢网络上误杀一次正常的安装；
 * 网络层的超时 pnpm 自己有。真卡住了，由用户去结束进程。
 */
export function runPnpm(opts: { pnpm: string; cwd: string; args: readonly string[] }): Promise<PnpmResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const push = (chunk: Buffer): void => {
      chunks.push(chunk)
      size += chunk.length
      // 只保留末尾部分，按整块丢弃，所以只有最后那次 concat 才可能切在多字节字符中间
      while (size > MAX_TAIL_BYTES && chunks.length > 1) size -= chunks.shift()!.length
    }
    // 环境整份透传：用户级 ~/.npmrc 与 pnpm 配置（@godcreator 的 scope 路由、包龄豁免）照常读到
    const proc = spawnPnpm(opts.pnpm, opts.cwd, opts.args)

    let settled = false
    const done = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      // 成功就不保留输出：那几十行「Progress: resolved 900」没人看
      if (exitCode === 0) return resolve({ ok: true, exitCode })
      resolve({ ok: false, exitCode, tail: tailLines(Buffer.concat(chunks).toString('utf8')) })
    }

    proc.stdout?.on('data', (c: Buffer) => push(c))
    proc.stderr?.on('data', (c: Buffer) => push(c))
    // 启动失败（pnpm 可执行文件不存在之类）：整理成一份 exitCode 为 null 的回执，原因放进 tail
    proc.on('error', (err) => {
      push(Buffer.from(`${String(err)}\n`, 'utf8'))
      done(null)
    })
    // 用 close 而不是 exit：等两条管道都读完再返回，否则 tail 可能缺最后一段——而失败原因正在那里
    proc.on('close', (code) => done(code))
  })
}

/** 在 home 里运行一次 `pnpm add`。不带任何 peer 相关参数：peer 不匹配时 pnpm 照装、只打 WARN */
export function addToHome(opts: { pnpm: string; home: string; specs: readonly string[] }): Promise<PnpmResult> {
  return runPnpm({ pnpm: opts.pnpm, cwd: opts.home, args: ['add', ...opts.specs] })
}

/** 一次 add 失败 → 回执里的一句 `error` 与 `tail`。`what` 是给人看的那次操作的描述（`pnpm add a@1 b@2`） */
export function describeAddFailure(what: string, run: PnpmResult): { error: string; tail?: string } {
  const error = `${what} 没成（退出码 ${String(run.exitCode)}）`
  return run.tail === undefined ? { error } : { error, tail: run.tail }
}

/** `checkPeers` 的回执：读出来了是 `warnings`（空数组 = 没问题），没读出来是 `error` 一句话 */
export type PeerCheck = { warnings: PeerWarning[] } | { error: string }

/**
 * 运行 `pnpm peers check --json`，读出 home 里此刻所有 peer 不匹配的地方（`peer-warnings.ts`）。
 * 退出码 1 是「有问题」，是结果不是失败。不抛。
 */
export async function checkPeers(opts: { pnpm: string; home: string }): Promise<PeerCheck> {
  const run = await runPnpmCapture({ pnpm: opts.pnpm, cwd: opts.home, args: ['peers', 'check', '--json'] })
  const warnings = run.exitCode === 0 || run.exitCode === 1 ? parsePeerCheck(run.stdout) : undefined
  if (warnings !== undefined) return { warnings }
  const why = run.stderrTail === '' ? '' : `：${run.stderrTail}`
  return { error: `pnpm peers check 没读出来（退出码 ${String(run.exitCode)}），peer 对没对上不知道${why}` }
}

/**
 * 运行一次 pnpm，把 stdout **完整**带回来。给 `pnpm outdated --json` 用——它的 JSON 在
 * stdout 上，而且退出码 1 的意思是「存在过期包」，是结果不是失败，所以这里不判 ok，
 * 两样都原样返回，由调用方解释。
 *
 * spawn 的做法与 `runPnpm` 相同（直接启动查找得到的可执行文件，理由见那边）。**不合并进 `runPnpm`**：那个成功时不保留输出（装包日志几 MB 没人看），
 * 这个保留全文——两边的取舍相反，合成一个函数两边都得迁就。
 */
export function runPnpmCapture(opts: { pnpm: string; cwd: string; args: readonly string[] }): Promise<PnpmCaptureResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    // 防御性上限，正常的 outdated 输出远小于它
    const MAX_BYTES = 4_000_000
    let outBytes = 0
    let errBytes = 0

    const proc = spawnPnpm(opts.pnpm, opts.cwd, opts.args)

    let settled = false
    const done = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderrTail: tailLines(Buffer.concat(err).toString('utf8')),
      })
    }

    proc.stdout?.on('data', (c: Buffer) => {
      if (outBytes < MAX_BYTES) {
        outBytes += c.length
        out.push(c)
      }
    })
    proc.stderr?.on('data', (c: Buffer) => {
      errBytes += c.length
      err.push(c)
      // stderr 只保留末尾部分
      while (errBytes > MAX_TAIL_BYTES * 4 && err.length > 1) errBytes -= err.shift()!.length
    })
    proc.on('error', (error) => {
      err.push(Buffer.from(`${String(error)}\n`, 'utf8'))
      done(null)
    })
    proc.on('close', (code) => done(code))
  })
}
