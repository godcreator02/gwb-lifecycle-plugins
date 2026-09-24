import { describe, expect, it } from 'vitest'
import * as devkitRule from '../src/kernel-compat.js'
import * as pluginManagerRule from '../../plugin-manager/src/kernel-compat.js'

/**
 * 插件 peer 里内核包范围的比对规则在 devkit 与插件管理各存一份（不跨包 import）。这里拿同一组输入跑两份，
 * 结果必须相同：改了一份没改另一份，这组测试就失败。
 */

const KERNEL_VERSIONS = ['0.3.0', '0.3.4', '0.2.7', '0.4.0', '0.3.0-dev.202609241500', '1.0.0', '1.9.4', '2.0.0', '2.0.0+build.5', '', '0.3', 'v0.3.0', 'latest']

const RANGES = [
  '^0.3.0',
  '^0.3.2',
  '^0.2.7',
  '^1.0.0',
  '^1.4.0',
  '0.3.0',
  '>=0.3.0',
  '~0.3.0',
  '^0.3',
  '^0.3.0-dev.1',
  '*',
  '',
  undefined,
]

const MANIFESTS: unknown[] = [
  undefined,
  null,
  'x',
  [],
  { name: 'x' },
  { peerDependencies: 'x' },
  { peerDependencies: {} },
  { peerDependencies: { cordis: '^4.0.0-rc.9' } },
  { peerDependencies: { '@godcreator/gwb-kernel-desktop': '^0.3.0' } },
  { peerDependencies: { '@godcreator/gwb-kernel-desktop': 3 } },
  { gwb: { testedKernel: '0.3.0' } },
]

/** 调一次，把「返回值」或「抛出的错误信息」都变成可比较的结果 */
function outcomeOf(run: () => unknown): { value: unknown } | { thrown: string } {
  try {
    return { value: run() }
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) }
  }
}

describe('devkit 与插件管理的内核范围比对规则行为相同', () => {
  it('KERNEL_PACKAGE 相同', () => {
    expect(devkitRule.KERNEL_PACKAGE).toBe(pluginManagerRule.KERNEL_PACKAGE)
  })

  it('kernelRangeCovers：范围 × 内核版本，结果与抛错都相同', () => {
    for (const range of RANGES) {
      for (const kernelVersion of KERNEL_VERSIONS) {
        expect(
          outcomeOf(() => devkitRule.kernelRangeCovers(range, kernelVersion)),
          `${String(range)} 对 ${kernelVersion}`,
        ).toEqual(outcomeOf(() => pluginManagerRule.kernelRangeCovers(range, kernelVersion)))
      }
    }
  })

  it('isCaretRange：同一组写法得到同样的判断', () => {
    for (const range of RANGES) {
      if (range === undefined) continue
      expect(devkitRule.isCaretRange(range), range).toBe(pluginManagerRule.isCaretRange(range))
    }
  })

  it('declaredKernelRange：同一组包清单读出同样的范围', () => {
    for (const manifest of MANIFESTS) {
      expect(devkitRule.declaredKernelRange(manifest), JSON.stringify(manifest)).toBe(pluginManagerRule.declaredKernelRange(manifest))
    }
  })
})

describe('kernelRangeCovers 的规则', () => {
  it('0.x：次版本号相同且不低于下限；开发版按 x.y.z 三段比', () => {
    expect(devkitRule.kernelRangeCovers('^0.3.0', '0.3.0')).toBe(true)
    expect(devkitRule.kernelRangeCovers('^0.3.0', '0.3.4')).toBe(true)
    expect(devkitRule.kernelRangeCovers('^0.3.2', '0.3.0')).toBe(false)
    expect(devkitRule.kernelRangeCovers('^0.3.0', '0.4.0')).toBe(false)
    expect(devkitRule.kernelRangeCovers('^0.3.0', '0.2.7')).toBe(false)
    expect(devkitRule.kernelRangeCovers('^0.3.0', '0.3.0-dev.202609241500')).toBe(true)
  })

  it('≥1：主版本号相同且不低于下限', () => {
    expect(devkitRule.kernelRangeCovers('^1.4.0', '1.9.4')).toBe(true)
    expect(devkitRule.kernelRangeCovers('^1.4.0', '1.0.0')).toBe(false)
    expect(devkitRule.kernelRangeCovers('^1.0.0', '2.0.0')).toBe(false)
  })

  it('没写、或不是 ^x.y.z：一律不包含', () => {
    for (const range of [undefined, '0.3.0', '>=0.3.0', '~0.3.0', '^0.3', '*']) {
      expect(devkitRule.kernelRangeCovers(range, '0.3.0'), String(range)).toBe(false)
    }
  })

  it('内核版本号不合法：抛错', () => {
    expect(() => devkitRule.kernelRangeCovers('^0.3.0', 'latest')).toThrow('内核版本号不是合法的版本号')
  })
})
