import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describePnpm, spawnPlan } from '../src/pnpm-path.js'
import { tailLines } from '../src/pnpm.js'

const EXE = 'C:\\Users\\u\\AppData\\Local\\pnpm\\bin\\pnpm.exe'

describe('不自带 pnpm', () => {
  it('包清单里没有 dependencies：pnpm 由用户装在固定位置', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies?: unknown }
    expect(manifest.dependencies).toBeUndefined()
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
