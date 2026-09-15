import { describe, expect, it } from 'vitest'
import { auditManifest, compareVersions, countByKind } from '../src/audit'

/** 对账的判例。registry 现值全是喂的——这层不碰网，判定逻辑单测钉死 */
const reg = (versions: string[]) => ({ versions })

describe('compareVersions：逐段数字比', () => {
  it('0.10.0 大于 0.9.9——字符串比会翻车的那种', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.9.9', '0.10.0')).toBe(-1)
  })
  it('缺段补零，0.1 等于 0.1.0', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0)
  })
})

describe('auditManifest：dev 钉那一档', () => {
  it('钉了源上没有的版本是死钉（装必炸）', () => {
    const got = auditManifest('r', '.', { peers: {}, devs: { '@godcreator/gwb-shell': '0.5.0' } }, {
      '@godcreator/gwb-shell': reg(['0.7.0']),
    })
    expect(got.map((f) => f.kind)).toEqual(['dead-pin'])
    expect(got[0]?.detail).toContain('0.7.0')
  })

  it('源上没这个包也是死钉', () => {
    const got = auditManifest('r', '.', { peers: {}, devs: { '@godcreator/gwb-x': '1.0.0' } }, {
      '@godcreator/gwb-x': reg([]),
    })
    expect(got.map((f) => f.kind)).toEqual(['dead-pin'])
  })

  it('钉得比最新旧是火车债，钉到最新就干净', () => {
    const registry = { '@godcreator/gwb-shell': reg(['0.7.0', '0.8.0']) }
    const old = auditManifest('r', '.', { peers: {}, devs: { '@godcreator/gwb-shell': '0.7.0' } }, registry)
    const now = auditManifest('r', '.', { peers: {}, devs: { '@godcreator/gwb-shell': '0.8.0' } }, registry)
    expect(old.map((f) => f.kind)).toEqual(['behind'])
    expect(now).toEqual([])
  })

  it('workspace:* 是同仓包，跳过；非精确钉版记一笔 loose', () => {
    const got = auditManifest('r', '.', { peers: {}, devs: { '@godcreator/gwb-skills': 'workspace:*', '@godcreator/gwb-data': '^0.1.0' } }, {
      '@godcreator/gwb-skills': reg(['0.4.0']),
      '@godcreator/gwb-data': reg(['0.1.1']),
    })
    expect(got.map((f) => f.kind)).toEqual(['loose-dev-pin'])
  })
})

describe('auditManifest：peer 下限那一档', () => {
  it('下限指向源上没有的版本＝声明了无法验证的世界', () => {
    const got = auditManifest('r', '.', { peers: { '@godcreator/gwb-tokens': '>=0.1.1' }, devs: { '@godcreator/gwb-tokens': '0.1.2' } }, {
      '@godcreator/gwb-tokens': reg(['0.1.2']),
    })
    expect(got.map((f) => f.kind)).toEqual(['floor-unverifiable'])
  })

  it('下限 ≠ dev 钉＝声明不等于验证过的世界（两边方向都记）', () => {
    const registry = { '@godcreator/gwb-shell': reg(['0.1.0', '0.7.0']) }
    const low = auditManifest('r', '.', { peers: { '@godcreator/gwb-shell': '>=0.1.0' }, devs: { '@godcreator/gwb-shell': '0.7.0' } }, registry)
    const high = auditManifest('r', '.', { peers: { '@godcreator/gwb-shell': '>=0.7.0' }, devs: { '@godcreator/gwb-shell': '0.1.0' } }, registry)
    expect(low.map((f) => f.kind)).toEqual(['floor-mismatch'])
    expect(high.map((f) => f.kind).sort()).toEqual(['behind', 'floor-mismatch'])
  })

  it('floor = dev 钉且都在源上＝干净', () => {
    const got = auditManifest('r', '.', { peers: { '@godcreator/gwb-shell': '>=0.7.0' }, devs: { '@godcreator/gwb-shell': '0.7.0' } }, {
      '@godcreator/gwb-shell': reg(['0.7.0']),
    })
    expect(got).toEqual([])
  })

  it('peer 没有 dev 镜像＝这个面从没验证过', () => {
    const got = auditManifest('r', '.', { peers: { '@godcreator/gwb-settings': '>=0.2.0' }, devs: {} }, {
      '@godcreator/gwb-settings': reg(['0.2.0']),
    })
    expect(got.map((f) => f.kind)).toEqual(['floor-no-mirror'])
  })

  it('下限写法认不出也说一声（约好 >=x.y.z）', () => {
    const got = auditManifest('r', '.', { peers: { '@godcreator/gwb-shell': '^0.7.0' }, devs: {} }, {
      '@godcreator/gwb-shell': reg(['0.7.0']),
    })
    expect(got.map((f) => f.kind)).toEqual(['floor-unverifiable'])
  })
})

describe('countByKind', () => {
  it('各类计数，缺席的记零', () => {
    expect(countByKind(auditManifest('r', '.', { peers: {}, devs: { '@godcreator/gwb-x': '9.9.9' } }, { '@godcreator/gwb-x': reg(['1.0.0']) }))).toMatchObject({ 'dead-pin': 1, behind: 0 })
  })
})
