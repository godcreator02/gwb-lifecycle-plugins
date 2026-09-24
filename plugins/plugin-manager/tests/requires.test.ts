import { describe, expect, it } from 'vitest'
import { declaredRequires, installedVersionOf, isMinimumVersion, meetsMinimum, requiresStatusOf } from '../src/requires'

describe('isMinimumVersion：最低版本号只收 x.y.z', () => {
  it('x.y.z 合法，带 ^、预发布段、构建段、前导零、少一段都不合法', () => {
    expect(isMinimumVersion('0.5.0')).toBe(true)
    expect(isMinimumVersion('10.0.12')).toBe(true)
    for (const bad of ['^0.5.0', '0.5.0-rc.1', '0.5.0+b', '01.5.0', '0.5', 'latest', '']) {
      expect(isMinimumVersion(bad), bad).toBe(false)
    }
  })
})

describe('meetsMinimum：装的版本满不满足最低版本号', () => {
  it('装的版本不低于最低版本号就满足，逐段按数字比', () => {
    expect(meetsMinimum('0.5.0', '0.5.0')).toBe(true)
    expect(meetsMinimum('0.5.3', '0.5.0')).toBe(true)
    expect(meetsMinimum('0.10.0', '0.9.9')).toBe(true)
    expect(meetsMinimum('1.0.0', '0.9.0')).toBe(true)
    expect(meetsMinimum('0.4.9', '0.5.0')).toBe(false)
    expect(meetsMinimum('0.9.9', '0.10.0')).toBe(false)
  })

  it('三段相同时带预发布段的不满足，三段更高时带预发布段的满足', () => {
    expect(meetsMinimum('0.5.0-dev.1', '0.5.0')).toBe(false)
    expect(meetsMinimum('0.5.1-dev.1', '0.5.0')).toBe(true)
  })

  it('最低版本号不是合法的 x.y.z、装的版本号不合法，都不满足', () => {
    for (const bad of ['latest', '^0.5.0', '0.5', '0.5.0-rc.1', 'v0.5.0']) {
      expect(meetsMinimum('9.9.9', bad), bad).toBe(false)
    }
    expect(meetsMinimum('dev', '0.1.0')).toBe(false)
  })
})

describe('declaredRequires：读包清单里的声明', () => {
  it('清单读不到、没有 gwb 字段、gwb 里没有 requires 都是 absent', () => {
    expect(declaredRequires(undefined)).toEqual({ kind: 'absent' })
    expect(declaredRequires({ name: 'x' })).toEqual({ kind: 'absent' })
    expect(declaredRequires({ gwb: { testedKernel: '0.2.7' } })).toEqual({ kind: 'absent' })
  })

  it('包名 → 字符串的对象原样读出', () => {
    expect(declaredRequires({ gwb: { requires: { '@x/gwb-shell': '0.5.0' } } })).toEqual({
      kind: 'declared',
      requires: { '@x/gwb-shell': '0.5.0' },
    })
  })

  it('不是对象、或有值不是字符串：invalid，说明哪里不对', () => {
    const notObject = declaredRequires({ gwb: { requires: ['@x/gwb-shell'] } })
    expect(notObject.kind).toBe('invalid')
    expect(notObject.kind === 'invalid' && notObject.problem).toMatch(/要写成/)
    const notString = declaredRequires({ gwb: { requires: { '@x/gwb-shell': 5 } } })
    expect(notString.kind === 'invalid' && notString.problem).toMatch(/@x\/gwb-shell 的值不是字符串/)
  })
})

describe('installedVersionOf：装的版本号', () => {
  it('读清单的 version；读不到或不是字符串时是 undefined', () => {
    expect(installedVersionOf({ version: '0.5.0' })).toBe('0.5.0')
    expect(installedVersionOf(undefined)).toBeUndefined()
    expect(installedVersionOf({ version: 5 })).toBeUndefined()
  })
})

describe('requiresStatusOf：list 回执里的 requires、unmetRequires、requiresInvalid', () => {
  const installed = new Map([
    ['@x/gwb-shell', '0.5.2'],
    ['@x/gwb-commands', '0.4.5'],
  ])

  it('全都满足：照抄 requires，unmetRequires 是空数组', () => {
    expect(requiresStatusOf({ gwb: { requires: { '@x/gwb-shell': '0.5.0' } } }, installed)).toEqual({
      requires: { '@x/gwb-shell': '0.5.0' },
      unmetRequires: [],
    })
  })

  it('装的版本太旧、没装、要求的不是合法 x.y.z：各列一条，没装的没有 installed 字段', () => {
    const status = requiresStatusOf(
      { gwb: { requires: { '@x/gwb-shell': '0.6.0', '@x/gwb-data': '0.1.0', '@x/gwb-commands': 'latest' } } },
      installed,
    )
    expect(status.unmetRequires).toEqual([
      { pkg: '@x/gwb-shell', required: '0.6.0', installed: '0.5.2' },
      { pkg: '@x/gwb-data', required: '0.1.0' },
      { pkg: '@x/gwb-commands', required: 'latest', installed: '0.4.5' },
    ])
    expect('installed' in status.unmetRequires[1]!).toBe(false)
  })

  it('没写：没有 requires 字段，unmetRequires 是空数组', () => {
    const status = requiresStatusOf({ name: 'x' }, installed)
    expect(status).toEqual({ unmetRequires: [] })
    expect('requires' in status).toBe(false)
  })

  it('写坏了：没有 requires 字段，requiresInvalid 说明哪里不对，不比对', () => {
    const status = requiresStatusOf({ gwb: { requires: '0.5.0' } }, installed)
    expect(status.unmetRequires).toEqual([])
    expect('requires' in status).toBe(false)
    expect(status.requiresInvalid).toMatch(/gwb\.requires 要写成/)
  })
})
