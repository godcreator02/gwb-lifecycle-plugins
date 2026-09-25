import { describe, expect, it } from 'vitest'
import { isCaretRange, kernelRangeCovers } from '../src/kernel-compat'

describe('isCaretRange：只认 ^x.y.z', () => {
  it('三段数字的 ^ 范围才算', () => {
    expect(isCaretRange('^0.5.0')).toBe(true)
    expect(isCaretRange('^1.2.3')).toBe(true)
    for (const range of ['0.5.0', '>=0.5.0', '~0.5.0', '^0.5', '^0.5.0-rc.1', 'workspace:^']) expect(isCaretRange(range)).toBe(false)
  })
})

describe('kernelRangeCovers：list 的 unmetPeers 里内核包那一项用它比', () => {
  it('主版本号为 0 时次版本号相同、≥1 时主版本号相同，并且不低于下限', () => {
    expect(kernelRangeCovers('^0.5.0', '0.5.0')).toBe(true)
    expect(kernelRangeCovers('^0.5.0', '0.5.9')).toBe(true)
    expect(kernelRangeCovers('^0.5.2', '0.5.1')).toBe(false)
    expect(kernelRangeCovers('^0.5.0', '0.6.0')).toBe(false)
    expect(kernelRangeCovers('^0.5.0', '0.4.9')).toBe(false)
    expect(kernelRangeCovers('^1.2.0', '1.9.4')).toBe(true)
    expect(kernelRangeCovers('^1.2.0', '2.0.0')).toBe(false)
  })

  it('预发布段不看：开发版内核按它的 x.y.z 比', () => {
    expect(kernelRangeCovers('^0.5.0', '0.5.1-dev.202609241500')).toBe(true)
  })

  it('范围没写、不是 ^x.y.z：不包含；内核版本号不合法直接抛错', () => {
    expect(kernelRangeCovers(undefined, '0.5.0')).toBe(false)
    expect(kernelRangeCovers('>=0.5.0', '0.5.0')).toBe(false)
    expect(() => kernelRangeCovers('^0.5.0', 'dev')).toThrow('内核版本号不是合法的版本号')
  })
})
