import { describe, expect, it } from 'vitest'
import { KERNEL_PACKAGE, declaredKernelRange, isCaretRange, kernelCompatStatusOf, kernelRangeCovers } from '../src/kernel-compat'

function manifestWithKernelRange(range: unknown): Record<string, unknown> {
  return { name: '@x/gwb-a', peerDependencies: { [KERNEL_PACKAGE]: range } }
}

describe('declaredKernelRange：读包清单 peer 里内核包的范围', () => {
  it('读出 peerDependencies 里内核包的范围字符串', () => {
    expect(declaredKernelRange(manifestWithKernelRange('^0.3.0'))).toBe('^0.3.0')
  })

  it('清单读不到、没有 peerDependencies、peer 里没有内核包、值不是字符串时是 undefined', () => {
    expect(declaredKernelRange(undefined)).toBeUndefined()
    expect(declaredKernelRange({ name: 'x' })).toBeUndefined()
    expect(declaredKernelRange({ peerDependencies: { cordis: '4.0.0-rc.9' } })).toBeUndefined()
    expect(declaredKernelRange(manifestWithKernelRange(3))).toBeUndefined()
  })
})

describe('kernelCompatStatusOf：list 回执的两个字段', () => {
  it('写了且包含运行中的内核：带 kernelRange，kernelUntested 是 false', () => {
    expect(kernelCompatStatusOf(manifestWithKernelRange('^0.3.0'), '0.3.4')).toEqual({ kernelRange: '^0.3.0', kernelUntested: false })
  })

  it('写了但不包含运行中的内核：带 kernelRange，kernelUntested 是 true', () => {
    expect(kernelCompatStatusOf(manifestWithKernelRange('^0.2.7'), '0.3.0')).toEqual({ kernelRange: '^0.2.7', kernelUntested: true })
    expect(kernelCompatStatusOf(manifestWithKernelRange('^0.3.2'), '0.3.0')).toEqual({ kernelRange: '^0.3.2', kernelUntested: true })
  })

  it('写的不是 ^x.y.z：原样带出，kernelUntested 是 true', () => {
    expect(kernelCompatStatusOf(manifestWithKernelRange('>=0.3.0'), '0.3.0')).toEqual({ kernelRange: '>=0.3.0', kernelUntested: true })
  })

  it('没写：没有 kernelRange 字段，kernelUntested 是 true', () => {
    const status = kernelCompatStatusOf({ name: 'x' }, '0.3.0')
    expect(status).toEqual({ kernelUntested: true })
    expect('kernelRange' in status).toBe(false)
  })

  it('运行中的内核版本号不合法直接抛错', () => {
    expect(() => kernelCompatStatusOf(manifestWithKernelRange('^0.3.0'), 'dev')).toThrow('内核版本号不是合法的版本号')
  })
})

describe('isCaretRange：只认 ^x.y.z', () => {
  it('三段数字的 ^ 范围才算', () => {
    expect(isCaretRange('^0.5.0')).toBe(true)
    expect(isCaretRange('^1.2.3')).toBe(true)
    for (const range of ['0.5.0', '>=0.5.0', '~0.5.0', '^0.5', '^0.5.0-rc.1', 'workspace:^']) expect(isCaretRange(range)).toBe(false)
  })
})

describe('kernelRangeCovers：devkit 发版检查与 list 的 kernelUntested 共用这一条', () => {
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
})
