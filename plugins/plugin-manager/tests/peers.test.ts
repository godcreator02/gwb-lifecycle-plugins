import { describe, expect, it } from 'vitest'
import { KERNEL_PACKAGE, caretRangeCovers } from '../src/kernel-compat'
import { declaredPluginPeers, peerStatusOf } from '../src/peers'

const SHELL = '@x/gwb-shell'
const COMMANDS = '@x/gwb-commands'
const DATA = '@x/gwb-data'

function plugin(extra: Record<string, unknown>): Record<string, unknown> {
  return { version: '1.0.0', keywords: ['gwb', 'gwb-plugin'], ...extra }
}

describe('caretRangeCovers：^x.y.z 包不包含装着的版本', () => {
  it('0.x：次版本号相同且不低于下限', () => {
    expect(caretRangeCovers('^0.5.0', '0.5.0')).toBe(true)
    expect(caretRangeCovers('^0.5.0', '0.5.7')).toBe(true)
    expect(caretRangeCovers('^0.5.2', '0.5.1')).toBe(false)
    expect(caretRangeCovers('^0.5.0', '0.6.0')).toBe(false)
    expect(caretRangeCovers('^0.5.0', '0.4.9')).toBe(false)
  })

  it('≥1：主版本号相同且不低于下限', () => {
    expect(caretRangeCovers('^1.4.0', '1.9.4')).toBe(true)
    expect(caretRangeCovers('^1.4.0', '1.3.9')).toBe(false)
    expect(caretRangeCovers('^1.0.0', '2.0.0')).toBe(false)
  })

  it('预发布段与构建段不看，只比 x.y.z 三段', () => {
    expect(caretRangeCovers('^0.5.0', '0.5.0-dev.202609241500')).toBe(true)
    expect(caretRangeCovers('^0.5.1', '0.5.0-dev.1')).toBe(false)
    expect(caretRangeCovers('^1.0.0', '1.2.0+build.5')).toBe(true)
  })

  it('范围不是 ^x.y.z、装着的版本号不合法：不包含', () => {
    for (const range of ['0.5.0', '>=0.5.0', '~0.5.0', '^0.5', '^0.5.0-dev.1', '*', 'workspace:*', '']) {
      expect(caretRangeCovers(range, '0.5.0'), range).toBe(false)
    }
    for (const installed of ['latest', 'v0.5.0', '0.5', '']) {
      expect(caretRangeCovers('^0.5.0', installed), installed).toBe(false)
    }
  })
})

describe('declaredPluginPeers：插件 peer 里除了 cordis 的那些', () => {
  it('去掉 cordis，内核包与别的包原样照抄，按清单里的先后', () => {
    const manifest = plugin({ peerDependencies: { [KERNEL_PACKAGE]: '^0.5.0', cordis: '4.0.0-rc.10', [SHELL]: '^0.5.0', [COMMANDS]: '^0.5.0' } })
    expect(declaredPluginPeers(manifest)).toEqual([
      { pkg: KERNEL_PACKAGE, range: '^0.5.0', optional: false },
      { pkg: SHELL, range: '^0.5.0', optional: false },
      { pkg: COMMANDS, range: '^0.5.0', optional: false },
    ])
  })

  it('peerDependenciesMeta 里 optional: true 的标出来', () => {
    const manifest = plugin({ peerDependencies: { [SHELL]: '^0.5.0' }, peerDependenciesMeta: { [SHELL]: { optional: true } } })
    expect(declaredPluginPeers(manifest)).toEqual([{ pkg: SHELL, range: '^0.5.0', optional: true }])
  })

  it('不是插件（keywords 没有 gwb-plugin）、清单读不到、没写 peer：空数组', () => {
    expect(declaredPluginPeers({ version: '1.0.0', keywords: ['gwb'], peerDependencies: { [SHELL]: '^0.5.0' } })).toEqual([])
    expect(declaredPluginPeers(undefined)).toEqual([])
    expect(declaredPluginPeers(plugin({}))).toEqual([])
  })
})

describe('peerStatusOf：list 回执里的 unmetPeers', () => {
  const installed = new Map([
    [SHELL, '0.5.2'],
    [COMMANDS, '0.4.5'],
  ])
  const RUNNING_KERNEL = '0.7.1'

  it('全都满足：空数组', () => {
    expect(peerStatusOf(plugin({ peerDependencies: { [SHELL]: '^0.5.0', [KERNEL_PACKAGE]: '^0.7.0' } }), installed, RUNNING_KERNEL)).toEqual({ unmetPeers: [] })
  })

  it('没装的没有 installed 字段；装着但不在范围里的带上 installed；范围不是 ^x.y.z 的原样照抄、算没满足', () => {
    const status = peerStatusOf(plugin({ peerDependencies: { [SHELL]: '^0.6.0', [DATA]: '^0.1.0', [COMMANDS]: '>=0.4.0' } }), installed, RUNNING_KERNEL)
    expect(status.unmetPeers).toEqual([
      { pkg: SHELL, range: '^0.6.0', installed: '0.5.2' },
      { pkg: DATA, range: '^0.1.0' },
      { pkg: COMMANDS, range: '>=0.4.0', installed: '0.4.5' },
    ])
    expect('installed' in status.unmetPeers[1]!).toBe(false)
  })

  it('可选的 peer：没装不算，装着但不在范围里照样算', () => {
    const meta = { peerDependenciesMeta: { [DATA]: { optional: true }, [SHELL]: { optional: true } } }
    expect(peerStatusOf(plugin({ peerDependencies: { [DATA]: '^0.1.0', [SHELL]: '^0.6.0' }, ...meta }), installed, RUNNING_KERNEL)).toEqual({
      unmetPeers: [{ pkg: SHELL, range: '^0.6.0', installed: '0.5.2' }],
    })
  })

  it('内核包对照正在运行的内核：范围不包含就列一项，installed 是运行中的内核版本', () => {
    expect(peerStatusOf(plugin({ peerDependencies: { [KERNEL_PACKAGE]: '^0.6.0' } }), installed, RUNNING_KERNEL)).toEqual({
      unmetPeers: [{ pkg: KERNEL_PACKAGE, range: '^0.6.0', installed: RUNNING_KERNEL }],
    })
    expect(peerStatusOf(plugin({ peerDependencies: { [KERNEL_PACKAGE]: '^0.7.2' } }), installed, RUNNING_KERNEL).unmetPeers).toHaveLength(1)
  })

  it('内核包的范围不是 ^x.y.z 也列；home 的 node_modules 里装着的内核版本不参与判断', () => {
    expect(peerStatusOf(plugin({ peerDependencies: { [KERNEL_PACKAGE]: '>=0.7.0' } }), installed, RUNNING_KERNEL)).toEqual({
      unmetPeers: [{ pkg: KERNEL_PACKAGE, range: '>=0.7.0', installed: RUNNING_KERNEL }],
    })
    const kernelInNodeModules = new Map([[KERNEL_PACKAGE, '0.6.0']])
    expect(peerStatusOf(plugin({ peerDependencies: { [KERNEL_PACKAGE]: '^0.7.0' } }), kernelInNodeModules, RUNNING_KERNEL)).toEqual({ unmetPeers: [] })
  })

  it('peer 里没写内核包的插件不列内核这一项；cordis 不在这里报', () => {
    expect(peerStatusOf(plugin({ peerDependencies: { [SHELL]: '^0.5.0', cordis: '9.0.0' } }), installed, RUNNING_KERNEL)).toEqual({ unmetPeers: [] })
  })

  it('运行中的内核版本号不合法：直接抛错', () => {
    expect(() => peerStatusOf(plugin({ peerDependencies: { [KERNEL_PACKAGE]: '^0.7.0' } }), installed, 'dev')).toThrow('内核版本号不是合法的版本号')
  })

  it('不是插件的包、清单读不到的包：空数组', () => {
    expect(peerStatusOf({ keywords: ['gwb'], peerDependencies: { [DATA]: '^0.1.0', [KERNEL_PACKAGE]: '^0.1.0' } }, installed, RUNNING_KERNEL)).toEqual({ unmetPeers: [] })
    expect(peerStatusOf(undefined, installed, RUNNING_KERNEL)).toEqual({ unmetPeers: [] })
  })
})
