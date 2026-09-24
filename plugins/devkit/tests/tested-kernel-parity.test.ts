import { describe, expect, it } from 'vitest'
import * as devkitRule from '../src/tested-kernel.js'
import * as pluginManagerRule from '../../plugin-manager/src/tested-kernel.js'

/**
 * testedKernel 的比对规则在 devkit 与插件管理各存一份（不跨包 import）。这里拿同一组输入跑两份，
 * 结果必须相同：改了一份没改另一份，这组测试就失败。
 */

const VERSIONS = [
  '0.2.7',
  '0.2.0',
  '0.3.0',
  '0.10.1',
  '1.0.0',
  '1.9.4',
  '2.0.0',
  '0.3.0-rc.1',
  '2.0.0+build.5',
  '',
  '0.2',
  '^0.2.7',
  'v0.2.7',
  '0.2.x',
  '01.2.3',
  'latest',
]

const MANIFESTS: unknown[] = [
  undefined,
  null,
  'x',
  [],
  { name: 'x' },
  { gwb: 'x' },
  { gwb: {} },
  { gwb: { testedKernel: '0.2.7' } },
  { gwb: { testedKernel: 27 } },
  { gwb: { testedKernel: 'latest' } },
]

/** 调一次，把「返回值」或「抛出的错误信息」都变成可比较的结果 */
function outcomeOf(run: () => unknown): { value: unknown } | { thrown: string } {
  try {
    return { value: run() }
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) }
  }
}

describe('devkit 与插件管理的 testedKernel 比对规则行为相同', () => {
  it('kernelVersionLine：同一组版本号得到同样的版本线', () => {
    for (const version of VERSIONS) {
      expect(devkitRule.kernelVersionLine(version), version).toBe(pluginManagerRule.kernelVersionLine(version))
    }
  })

  it('testedOnSameKernelLine：声明版本 × 运行中的内核版本，结果与抛错都相同', () => {
    for (const tested of [...VERSIONS, undefined]) {
      for (const running of VERSIONS) {
        expect(
          outcomeOf(() => devkitRule.testedOnSameKernelLine(tested, running)),
          `${String(tested)} 对 ${running}`,
        ).toEqual(outcomeOf(() => pluginManagerRule.testedOnSameKernelLine(tested, running)))
      }
    }
  })

  it('declaredTestedKernel：同一组包清单读出同样的声明', () => {
    for (const manifest of MANIFESTS) {
      expect(devkitRule.declaredTestedKernel(manifest), JSON.stringify(manifest)).toBe(
        pluginManagerRule.declaredTestedKernel(manifest),
      )
    }
  })
})
