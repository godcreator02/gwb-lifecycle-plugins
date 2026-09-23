import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describePnpm, pnpmExecutableOf, spawnPlan } from '../src/pnpm-path.js'
import { locatePnpm, tailLines } from '../src/pnpm.js'

const EXE = 'C:\\home\\node_modules\\.pnpm\\@pnpm+exe.win32-x64@12.4.2\\node_modules\\@pnpm\\exe.win32-x64\\pnpm.exe'

describe('用自己依赖里的那份 pnpm', () => {
  it('Windows 上是 @pnpm/exe.win32-x64 包里的 pnpm.exe', () => {
    expect(pnpmExecutableOf('win32', 'x64')).toEqual({ pkg: '@pnpm/exe.win32-x64', bin: 'pnpm.exe' })
  })

  it('别的平台可执行文件不带 .exe', () => {
    expect(pnpmExecutableOf('linux', 'arm64')).toEqual({ pkg: '@pnpm/exe.linux-arm64', bin: 'pnpm' })
  })

  it('从本插件的位置解析到依赖里那个可执行文件，版本与 package.json 写的相同', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    const found = locatePnpm()
    expect(found).toMatchObject({ ok: true, version: manifest.dependencies['@pnpm/exe.win32-x64'] })
    expect(found.ok && fs.existsSync(found.file)).toBe(true)
  })

  it('依赖里只有 pnpm 的可执行文件包，没有带安装脚本的 pnpm 包', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(manifest.dependencies)).toEqual(['@pnpm/exe.win32-x64'])
  })
})

describe('怎么启动', () => {
  const env = { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' }

  it('直接启动可执行文件，环境原样传下去，只去掉 ELECTRON_RUN_AS_NODE', () => {
    expect(spawnPlan(EXE, ['outdated', '--json'], env)).toEqual({
      command: EXE,
      args: ['outdated', '--json'],
      env: { PATH: 'x', HOME: 'h' },
    })
  })

  it('不改调用方给的环境', () => {
    spawnPlan(EXE, [], env)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('日志那句带版本与路径', () => {
    expect(describePnpm({ file: EXE, version: '12.4.2' })).toBe(`pnpm 12.4.2（${EXE}）`)
  })
})

describe('pnpm 输出留尾巴', () => {
  it('只留最后几行——pnpm 把原因放在最后', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(tailLines(text, 3)).toBe('line 37\nline 38\nline 39')
  })

  it('两头的空行削掉', () => {
    expect(tailLines('\n\na\nb\n\n\n', 10)).toBe('a\nb')
  })

  it('CRLF 归一', () => {
    expect(tailLines('a\r\nb\r\n', 10)).toBe('a\nb')
  })

  it('短的原样', () => {
    expect(tailLines('boom', 12)).toBe('boom')
  })

  it('全是空白时回空串', () => {
    expect(tailLines('\n \n', 12)).toBe('')
  })
})
