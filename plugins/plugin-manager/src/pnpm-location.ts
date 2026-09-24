import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// 插件管理与 devkit 各存一份、逐字相同，不跨包 import；devkit 的 tests/pnpm-location-parity.test.ts 对照两份，改一份同一个提交改另一份

/** 要求的 pnpm 版本：主版本号相同，并且不低于这个版本 */
export const REQUIRED_PNPM = '12.4.2'

/** `pnpm --version` 的上限。原生可执行文件报版本号是瞬间的事，卡住说明这个文件有问题 */
const VERSION_TIMEOUT_MS = 30_000

export type PnpmLookup = { ok: true; file: string; version: string } | { ok: false; error: string }

export interface PnpmLocateDeps {
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  exists(file: string): boolean
  versionOf(file: string): Promise<{ ok: true; version: string } | { ok: false; error: string }>
}

/**
 * 只认这两个位置，按这个顺序：pnpm 12 官方安装脚本的默认位置（`%LOCALAPPDATA%\pnpm\bin`），
 * npm 全局装的 pnpm 12 包里的原生可执行文件（PATH 上的 `pnpm.cmd` 转去调用的就是它）
 */
export function pnpmCandidatesOf(localAppData: string, appData: string): string[] {
  return [path.win32.join(localAppData, 'pnpm', 'bin', 'pnpm.exe'), path.win32.join(appData, 'npm', 'node_modules', 'pnpm', 'pnpm.exe')]
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** 版本不合要求时说明原因；合要求是 undefined */
export function pnpmVersionProblem(version: string): string | undefined {
  const seen = VERSION.exec(version)
  if (seen === null) return `报出的版本号认不出：${JSON.stringify(version)}`
  const required = VERSION.exec(REQUIRED_PNPM)!
  const [major, minor, patch] = [Number(seen[1]), Number(seen[2]), Number(seen[3])]
  const [requiredMajor, requiredMinor, requiredPatch] = [Number(required[1]), Number(required[2]), Number(required[3])]
  const notLower = major !== requiredMajor ? false : minor !== requiredMinor ? minor > requiredMinor : patch >= requiredPatch
  return notLower ? undefined : `要的是 pnpm ${String(requiredMajor)}.x 并且不低于 ${REQUIRED_PNPM}`
}

const INSTALL_HINT = `照 INSTALL.md 装 pnpm ${REQUIRED_PNPM}：官方脚本 $env:PNPM_VERSION='${REQUIRED_PNPM}'; iwr https://get.pnpm.io/install.ps1 -useb | iex，或 npm i -g pnpm@${REQUIRED_PNPM}`

/** 第一个存在的位置作数，再核对它的版本；不存在、版本不对都报错，不去试另一个位置 */
export async function locatePnpmWith(deps: PnpmLocateDeps): Promise<PnpmLookup> {
  if (deps.platform !== 'win32') return { ok: false, error: `只支持 Windows：pnpm 的两个固定位置都是 Windows 路径（本机是 ${deps.platform}）` }
  const localAppData = deps.env['LOCALAPPDATA']
  const appData = deps.env['APPDATA']
  if (localAppData === undefined || localAppData === '' || appData === undefined || appData === '') {
    return { ok: false, error: '环境变量 LOCALAPPDATA 或 APPDATA 不在，算不出 pnpm 的两个固定位置' }
  }
  const candidates = pnpmCandidatesOf(localAppData, appData)
  const file = candidates.find((candidate) => deps.exists(candidate))
  if (file === undefined) return { ok: false, error: `找不到 pnpm。只认这两个位置（按顺序）：${candidates.join('、')}。${INSTALL_HINT}` }
  const seen = await deps.versionOf(file)
  if (!seen.ok) return { ok: false, error: `${file} 运行 --version 失败：${seen.error}` }
  const problem = pnpmVersionProblem(seen.version)
  if (problem !== undefined) return { ok: false, error: `${file} 是 pnpm ${seen.version}，${problem}。${INSTALL_HINT}` }
  return { ok: true, file, version: seen.version }
}

function pnpmVersionOf(file: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error !== null) return resolve({ ok: false, error: String(error) })
      resolve({ ok: true, version: stdout.trim() })
    })
  })
}

export function locatePnpm(): Promise<PnpmLookup> {
  return locatePnpmWith({ platform: process.platform, env: process.env, exists: (file) => fs.existsSync(file), versionOf: pnpmVersionOf })
}
