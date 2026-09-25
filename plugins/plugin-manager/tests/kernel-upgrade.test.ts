import { describe, expect, it } from 'vitest'
import { KERNEL_PACKAGE } from '../src/kernel-compat'
import { CORDIS_PACKAGE, installedVersionMismatch, KERNEL_MANAGED_PACKAGES, kernelUpgradeTargetOf, versionChangeOf } from '../src/kernel-upgrade'

describe('installedVersionMismatch：装上的版本对不对', () => {
  it('对上了回 undefined', () => {
    expect(installedVersionMismatch('cordis', '4.0.0-rc.9', '4.0.0-rc.9')).toBeUndefined()
  })

  it('对不上：说出装上的与要的，指出把清单改成精确版本号', () => {
    const message = installedVersionMismatch('cordis', '4.0.0-rc.9', '4.0.0-rc.10')!
    expect(message).toContain('4.0.0-rc.10')
    expect(message).toContain('4.0.0-rc.9')
    expect(message).toContain('精确版本号')
  })

  it('读不到装上的版本也算对不上', () => {
    expect(installedVersionMismatch('cordis', '4.0.0-rc.9', undefined)).toContain('读不到')
  })
})

describe('KERNEL_MANAGED_PACKAGES：版本由内核决定的包', () => {
  it('就是内核包与 cordis 两个', () => {
    expect([...KERNEL_MANAGED_PACKAGES].sort()).toEqual([KERNEL_PACKAGE, CORDIS_PACKAGE].sort())
  })
})

describe('kernelUpgradeTargetOf：装上的内核包清单 → 内核版本与它要的 cordis 版本', () => {
  it('peer 里的 cordis 是精确版本号：取出内核版本与 cordis 版本', () => {
    expect(kernelUpgradeTargetOf({ name: KERNEL_PACKAGE, version: '0.3.1', peerDependencies: { cordis: '4.0.0-rc.9' } })).toEqual({
      ok: true,
      kernelVersion: '0.3.1',
      cordisVersion: '4.0.0-rc.9',
    })
  })

  it('peer 里的 cordis 是范围不是精确版本号：报错并说出实际写的', () => {
    const target = kernelUpgradeTargetOf({ version: '0.3.1', peerDependencies: { cordis: '^4.0.0-rc.9' } })
    expect(target.ok).toBe(false)
    expect(target.ok ? '' : target.error).toContain('"^4.0.0-rc.9"')
    expect(target.ok ? '' : target.error).toContain('精确版本号')
  })

  it('peer 里没写 cordis、没有 peerDependencies：报错', () => {
    for (const manifest of [{ version: '0.3.1', peerDependencies: {} }, { version: '0.3.1' }]) {
      const target = kernelUpgradeTargetOf(manifest)
      expect(target.ok, JSON.stringify(manifest)).toBe(false)
      expect(target.ok ? '' : target.error).toContain('peerDependencies.cordis')
    }
  })

  it('内核包清单读不到：报错说内核包不在 home 里', () => {
    const target = kernelUpgradeTargetOf(undefined)
    expect(target.ok).toBe(false)
    expect(target.ok ? '' : target.error).toContain('读不到')
  })

  it('内核包的 version 不是合法版本号：报错', () => {
    const target = kernelUpgradeTargetOf({ version: 'dev', peerDependencies: { cordis: '4.0.0-rc.9' } })
    expect(target.ok).toBe(false)
    expect(target.ok ? '' : target.error).toContain('"dev"')
  })
})

describe('versionChangeOf：回执里的 { from, to }', () => {
  it('装之前没有这个包就没有 from', () => {
    expect(versionChangeOf(undefined, '0.3.1')).toEqual({ to: '0.3.1' })
    expect('from' in versionChangeOf(undefined, '0.3.1')).toBe(false)
  })

  it('装之前有就带上 from', () => {
    expect(versionChangeOf('0.3.0', '0.3.1')).toEqual({ from: '0.3.0', to: '0.3.1' })
  })
})
