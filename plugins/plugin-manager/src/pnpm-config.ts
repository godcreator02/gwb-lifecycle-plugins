/**
 * 在 home 里问 pnpm 要配置（pnpm 12.4 实测）：`pnpm config list --json` 回合并好的全部配置，是一个 JSON 对象，
 * 凭据的值被遮成 `(protected)`；`pnpm config get <键>` 回真值，没配时输出 `undefined`、退出码 0
 */

import type { Outcome } from './receipts.js'
import { runPnpmCapture, type PnpmCaptureResult } from './pnpm.js'
import { isRecord } from './vocab.js'

/** 整份不是 JSON 对象回 undefined */
export function parseConfigList(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

/** 没配是 undefined */
export function parseConfigValue(stdout: string): string | undefined {
  const value = stdout.trim()
  return value === '' || value === 'undefined' ? undefined : value
}

function failureOf(what: string, run: PnpmCaptureResult): string {
  const message = run.exitCode === null ? `${what} 没启动起来` : `${what} 失败（退出码 ${String(run.exitCode)}）`
  return run.stderrTail === '' ? message : `${message}\n${run.stderrTail}`
}

export async function readPnpmConfig(pnpm: string, homeDir: string): Promise<Outcome<Record<string, unknown>>> {
  const run = await runPnpmCapture({ pnpm, cwd: homeDir, args: ['config', 'list', '--json'] })
  if (run.exitCode !== 0) return { ok: false, error: failureOf('pnpm config list --json', run) }
  const config = parseConfigList(run.stdout)
  if (config === undefined) return { ok: false, error: 'pnpm config list --json 的输出不是 JSON 对象——pnpm 升大版本时输出格式可能变了' }
  return { ok: true, data: config }
}

/** pnpm 失败就抛：凭据取不到时去查一个私有源，报出来的会是 401，原因反而看不见 */
export async function readPnpmConfigValue(pnpm: string, homeDir: string, key: string): Promise<string | undefined> {
  const run = await runPnpmCapture({ pnpm, cwd: homeDir, args: ['config', 'get', key] })
  if (run.exitCode !== 0) throw new Error(failureOf(`pnpm config get ${key}`, run))
  return parseConfigValue(run.stdout)
}
