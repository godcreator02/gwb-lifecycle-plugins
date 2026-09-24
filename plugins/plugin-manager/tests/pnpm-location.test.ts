import { describe, expect, it } from 'vitest'
import { locatePnpmWith, pnpmCandidatesOf, pnpmVersionProblem, REQUIRED_PNPM, type PnpmLocateDeps } from '../src/pnpm-location.js'

const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const ROAMING = 'C:\\Users\\u\\AppData\\Roaming'
const OFFICIAL = `${LOCAL}\\pnpm\\bin\\pnpm.exe`
const NPM_GLOBAL = `${ROAMING}\\npm\\node_modules\\pnpm\\pnpm.exe`

function depsWith(present: string[], versions: Record<string, string> = {}): PnpmLocateDeps & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    platform: 'win32',
    env: { LOCALAPPDATA: LOCAL, APPDATA: ROAMING },
    exists: (file) => present.includes(file),
    versionOf: (file) => {
      asked.push(file)
      const version = versions[file]
      return Promise.resolve(version === undefined ? { ok: false, error: 'spawn EPERM' } : { ok: true, version })
    },
  }
}

describe('只认两个固定位置', () => {
  it('先是官方安装脚本的默认位置，再是 npm 全局装的 pnpm 包里的原生可执行文件', () => {
    expect(pnpmCandidatesOf(LOCAL, ROAMING)).toEqual([OFFICIAL, NPM_GLOBAL])
  })

  it('两个都在：用第一个', async () => {
    const found = await locatePnpmWith(depsWith([OFFICIAL, NPM_GLOBAL], { [OFFICIAL]: '12.4.2', [NPM_GLOBAL]: '12.5.0' }))
    expect(found).toEqual({ ok: true, file: OFFICIAL, version: '12.4.2' })
  })

  it('只有 npm 全局那份：用它', async () => {
    const found = await locatePnpmWith(depsWith([NPM_GLOBAL], { [NPM_GLOBAL]: '12.4.2' }))
    expect(found).toEqual({ ok: true, file: NPM_GLOBAL, version: '12.4.2' })
  })

  it('两个都不在：报错，列出两个位置与怎么装', async () => {
    const found = await locatePnpmWith(depsWith([]))
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.error).toContain(OFFICIAL)
    expect(found.error).toContain(NPM_GLOBAL)
    expect(found.error).toContain(`PNPM_VERSION='${REQUIRED_PNPM}'`)
  })

  it('第一个位置的版本不对：报错，不去试第二个', async () => {
    const deps = depsWith([OFFICIAL, NPM_GLOBAL], { [OFFICIAL]: '11.9.0', [NPM_GLOBAL]: '12.4.2' })
    const found = await locatePnpmWith(deps)
    expect(found.ok).toBe(false)
    expect(deps.asked).toEqual([OFFICIAL])
  })

  it('--version 运行失败：报错，带上原因', async () => {
    const found = await locatePnpmWith(depsWith([OFFICIAL]))
    expect(found).toEqual({ ok: false, error: `${OFFICIAL} 运行 --version 失败：spawn EPERM` })
  })

  it('不是 Windows：报错', async () => {
    const found = await locatePnpmWith({ ...depsWith([OFFICIAL], { [OFFICIAL]: '12.4.2' }), platform: 'linux' })
    expect(found.ok).toBe(false)
  })

  it('LOCALAPPDATA 或 APPDATA 不在：报错', async () => {
    const found = await locatePnpmWith({ ...depsWith([OFFICIAL], { [OFFICIAL]: '12.4.2' }), env: { APPDATA: ROAMING } })
    expect(found).toEqual({ ok: false, error: '环境变量 LOCALAPPDATA 或 APPDATA 不在，算不出 pnpm 的两个固定位置' })
  })
})

describe('版本核对', () => {
  it('同一个主版本并且不低于要求的版本才算合格', () => {
    expect(pnpmVersionProblem('12.4.2')).toBeUndefined()
    expect(pnpmVersionProblem('12.4.10')).toBeUndefined()
    expect(pnpmVersionProblem('12.9.0')).toBeUndefined()
    expect(pnpmVersionProblem('12.4.1')).toBeDefined()
    expect(pnpmVersionProblem('12.3.9')).toBeDefined()
    expect(pnpmVersionProblem('11.9.0')).toBeDefined()
    expect(pnpmVersionProblem('13.0.0')).toBeDefined()
  })

  it('认不出的版本号：不合格', () => {
    expect(pnpmVersionProblem('')).toBeDefined()
    expect(pnpmVersionProblem('v12.4.2')).toBeDefined()
    expect(pnpmVersionProblem('12.4.2-beta.1')).toBeDefined()
  })
})
