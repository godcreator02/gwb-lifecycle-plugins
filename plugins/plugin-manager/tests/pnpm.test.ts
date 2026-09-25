import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeAddFailure, describePnpm, homePnpmEnv, spawnPlan, tailLines } from '../src/pnpm.js'

const EXE = 'C:\\Users\\u\\AppData\\Local\\pnpm\\bin\\pnpm.exe'

describe('不自带 pnpm', () => {
  it('包清单里没有 dependencies：pnpm 由用户装在固定位置', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies?: unknown }
    expect(manifest.dependencies).toBeUndefined()
  })
})

describe('在 home 里启动 pnpm 用的环境', () => {
  const env = { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' }

  it('原样传下去，去掉 ELECTRON_RUN_AS_NODE、关掉自动补装 peer', () => {
    expect(homePnpmEnv(env)).toEqual({ PATH: 'x', HOME: 'h', pnpm_config_auto_install_peers: 'false' })
  })

  it('调用方环境里自动补装 peer 是开着的也照样关掉', () => {
    expect(homePnpmEnv({ pnpm_config_auto_install_peers: 'true' })).toEqual({ pnpm_config_auto_install_peers: 'false' })
  })

  it('不改调用方给的环境', () => {
    homePnpmEnv(env)
    expect(env).toEqual({ PATH: 'x', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' })
  })
})

describe('怎么启动', () => {
  it('直接启动可执行文件，环境用 homePnpmEnv 算出的那份', () => {
    const env = { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' }
    expect(spawnPlan(EXE, ['outdated', '--json'], env)).toEqual({ command: EXE, args: ['outdated', '--json'], env: homePnpmEnv(env) })
  })

  it('日志那句带版本与路径', () => {
    expect(describePnpm({ file: EXE, version: '12.4.2' })).toBe(`pnpm 12.4.2（${EXE}）`)
  })
})

describe('pnpm 失败时的回执', () => {
  it('退出码与输出的最后几行', () => {
    expect(describeAddFailure('pnpm add x', { ok: false, exitCode: 1, tail: '404' })).toEqual({ error: 'pnpm add x 失败（退出码 1）', tail: '404' })
    expect(describeAddFailure('pnpm add x', { ok: false, exitCode: null })).toEqual({ error: 'pnpm add x 失败（退出码 null）' })
  })
})

describe('pnpm 输出留尾巴', () => {
  it('只留最后几行——pnpm 把原因放在最后', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(tailLines(text, 3)).toBe('line 37\nline 38\nline 39')
  })

  it('两头的空行削掉', () => {
    expect(tailLines('\n\na\nb\n\n\n', 10)).toBe('a\nb')
    expect(tailLines('\n\na\nb\nc\n\n', 2)).toBe('b\nc')
  })

  it('CRLF 归一', () => {
    expect(tailLines('a\r\nb\r\n')).toBe('a\nb')
  })

  it('短的原样', () => {
    expect(tailLines('boom', 12)).toBe('boom')
  })

  it('全是空白时回空串', () => {
    expect(tailLines('\n \n', 12)).toBe('')
  })
})
