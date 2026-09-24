import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPnpm, runPnpmCapture, TAIL_LINES } from '../src/pnpm.js'

/** 用 node 自己代替 pnpm 可执行文件：启动、收输出、读退出码的路径与真 pnpm 相同 */
const NODE = process.execPath
const cwd = os.tmpdir()
const MISSING = path.join(os.tmpdir(), 'gwb-no-such-pnpm-here.exe')

function script(body: string): string[] {
  return ['-e', body]
}

describe('runPnpm：只看退出码，失败时带输出的最后几行', () => {
  it('退出码 0：ok，不带 tail', async () => {
    const run = await runPnpm({ pnpm: NODE, cwd, args: script('console.log("Progress: resolved 900")') })
    expect(run).toEqual({ ok: true, exitCode: 0 })
  })

  it('退出码非 0：不 ok，tail 是 stdout 与 stderr 合起来的最后几行', async () => {
    const run = await runPnpm({ pnpm: NODE, cwd, args: script('console.error("ERR_PNPM_FETCH_404 没有这个包"); process.exit(3)') })
    expect(run.ok).toBe(false)
    expect(run.exitCode).toBe(3)
    expect(run.tail).toBe('ERR_PNPM_FETCH_404 没有这个包')
  })

  it(`输出很长时 tail 只留最后 ${String(TAIL_LINES)} 行`, async () => {
    const run = await runPnpm({ pnpm: NODE, cwd, args: script('for (let i = 1; i <= 30; i++) console.log("line " + i); process.exit(1)') })
    const lines = run.tail?.split('\n') ?? []
    expect(lines).toHaveLength(TAIL_LINES)
    expect(lines.at(-1)).toBe('line 30')
  })

  it('可执行文件不在：不抛，exitCode 为 null，原因在 tail 里', async () => {
    const run = await runPnpm({ pnpm: MISSING, cwd, args: [] })
    expect(run.ok).toBe(false)
    expect(run.exitCode).toBeNull()
    expect(run.tail).toContain('ENOENT')
  })
})

describe('runPnpmCapture：stdout 全文带回，退出码交给调用方解释', () => {
  it('退出码 1 照样回 stdout 全文与 stderr 的最后几行', async () => {
    const run = await runPnpmCapture({
      pnpm: NODE,
      cwd,
      args: script('process.stdout.write(JSON.stringify({ a: { current: "1.0.0", latest: "1.1.0" } })); console.error("有过期的包"); process.exit(1)'),
    })
    expect(run).toEqual({ exitCode: 1, stdout: '{"a":{"current":"1.0.0","latest":"1.1.0"}}', stderrTail: '有过期的包' })
  })

  it('可执行文件不在：exitCode 为 null，stdout 空，原因在 stderrTail 里', async () => {
    const run = await runPnpmCapture({ pnpm: MISSING, cwd, args: [] })
    expect(run.exitCode).toBeNull()
    expect(run.stdout).toBe('')
    expect(run.stderrTail).toContain('ENOENT')
  })
})
