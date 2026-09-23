import { describe, expect, it } from 'vitest'
import { declaredTestedKernel, kernelVersionLine, testedOnSameKernelLine } from '../src/tested-kernel.js'

describe('kernelVersionLine：内核版本线', () => {
  it('主版本号为 0 时取前两位', () => {
    expect(kernelVersionLine('0.2.7')).toBe('0.2')
    expect(kernelVersionLine('0.10.0')).toBe('0.10')
  })

  it('主版本号 ≥1 时只取主版本号', () => {
    expect(kernelVersionLine('1.4.0')).toBe('1')
    expect(kernelVersionLine('12.0.3')).toBe('12')
  })

  it('带预发布与构建后缀的版本号照样合法', () => {
    expect(kernelVersionLine('0.3.0-rc.1')).toBe('0.3')
    expect(kernelVersionLine('2.0.0+build.5')).toBe('2')
  })

  it('不是合法版本号时是 undefined', () => {
    for (const bad of ['', '0.2', '^0.2.7', 'v0.2.7', '0.2.x', '01.2.3', 'latest']) {
      expect(kernelVersionLine(bad), bad).toBeUndefined()
    }
  })
})

describe('testedOnSameKernelLine：比对规则', () => {
  it('0.x 同一个次版本号算测过，次版本号不同不算', () => {
    expect(testedOnSameKernelLine('0.2.3', '0.2.7')).toBe(true)
    expect(testedOnSameKernelLine('0.2.7', '0.2.7')).toBe(true)
    expect(testedOnSameKernelLine('0.2.7', '0.3.0')).toBe(false)
    expect(testedOnSameKernelLine('0.3.0', '0.2.7')).toBe(false)
  })

  it('≥1 时只看主版本号', () => {
    expect(testedOnSameKernelLine('1.0.0', '1.9.4')).toBe(true)
    expect(testedOnSameKernelLine('1.9.4', '2.0.0')).toBe(false)
    expect(testedOnSameKernelLine('0.9.0', '1.0.0')).toBe(false)
  })

  it('没声明、声明的不是合法版本号，一律算没测过', () => {
    expect(testedOnSameKernelLine(undefined, '0.2.7')).toBe(false)
    expect(testedOnSameKernelLine('0.2', '0.2.7')).toBe(false)
    expect(testedOnSameKernelLine('^0.2.0', '0.2.7')).toBe(false)
  })

  it('运行中的内核版本号不合法直接抛错', () => {
    expect(() => testedOnSameKernelLine('0.2.7', 'dev')).toThrow(/运行中的内核版本号/)
  })
})

describe('declaredTestedKernel：读包清单里的声明', () => {
  it('读出 gwb.testedKernel 字符串', () => {
    expect(declaredTestedKernel({ gwb: { testedKernel: '0.2.7' } })).toBe('0.2.7')
  })

  it('清单读不到、没有 gwb 字段、没写或不是字符串时是 undefined', () => {
    expect(declaredTestedKernel(undefined)).toBeUndefined()
    expect(declaredTestedKernel({ name: 'x' })).toBeUndefined()
    expect(declaredTestedKernel({ gwb: {} })).toBeUndefined()
    expect(declaredTestedKernel({ gwb: { testedKernel: 27 } })).toBeUndefined()
  })
})
