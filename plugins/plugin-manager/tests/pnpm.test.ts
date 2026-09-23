import { describe, expect, it } from 'vitest'
import { describeAddFailure, tailLines } from '../src/pnpm.js'

describe('pnpm 失败时的回执', () => {
  it('退出码与输出的最后几行', () => {
    expect(describeAddFailure('pnpm add x', { ok: false, exitCode: 1, tail: '404' })).toEqual({ error: 'pnpm add x 失败（退出码 1）', tail: '404' })
    expect(describeAddFailure('pnpm add x', { ok: false, exitCode: null })).toEqual({ error: 'pnpm add x 失败（退出码 null）' })
  })

  it('只留最后几行，去掉首尾空行', () => {
    expect(tailLines('\n\na\nb\nc\n\n', 2)).toBe('b\nc')
    expect(tailLines('a\r\nb\r\n')).toBe('a\nb')
  })
})
