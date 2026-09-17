import { describe, expect, it } from 'vitest'
import { auditManifest, compareVersions, countByKind, unitRetired, type ManifestDeps } from '../src/audit'

/** 对账的判例。registry 现值全是喂的——这层不碰网，判定逻辑单测钉死 */
const reg = (versions: string[], latest: string | undefined = versions.filter((v) => !v.includes('-')).at(-1)) => ({
  versions,
  ...(latest === undefined ? {} : { latest }),
})

/** 一份发布的清单（不是 private） */
const pub = (peers: Record<string, string>, devs: Record<string, string>): ManifestDeps => ({ peers, devs, private: false })

describe('compareVersions：逐段数字比', () => {
  it('0.10.0 大于 0.9.9——字符串比会翻车的那种', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.9.9', '0.10.0')).toBe(-1)
  })
  it('缺段补零，0.1 等于 0.1.0', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0)
  })
  it('同三段时带预发布段的小：0.2.1-dev.x < 0.2.1，但大于 0.2.0', () => {
    expect(compareVersions('0.2.1-dev.202609151533', '0.2.1')).toBe(-1)
    expect(compareVersions('0.2.1-dev.202609151533', '0.2.0')).toBe(1)
  })
  it('两个预发布号按数字段比', () => {
    expect(compareVersions('0.7.2-dev.202609171834', '0.7.2-dev.202609171837')).toBe(-1)
    expect(compareVersions('0.7.2-dev.10', '0.7.2-dev.9')).toBe(1)
  })
})

describe('auditManifest：dev 钉那一档', () => {
  it('钉了源上没有的版本是死钉（装必炸）', () => {
    const got = auditManifest('r', '.', pub({}, { '@godcreator/gwb-shell': '0.5.0' }), {
      '@godcreator/gwb-shell': reg(['0.7.0']),
    })
    expect(got.map((f) => f.kind)).toEqual(['dead-pin'])
    expect(got[0]?.detail).toContain('0.7.0')
  })

  it('源上没这个包也是死钉', () => {
    const got = auditManifest('r', '.', pub({}, { '@godcreator/gwb-x': '1.0.0' }), {
      '@godcreator/gwb-x': reg([]),
    })
    expect(got.map((f) => f.kind)).toEqual(['dead-pin'])
  })

  it('钉得比最新旧是火车债，钉到最新就干净', () => {
    const registry = { '@godcreator/gwb-shell': reg(['0.7.0', '0.8.0']) }
    const old = auditManifest('r', '.', pub({}, { '@godcreator/gwb-shell': '0.7.0' }), registry)
    const now = auditManifest('r', '.', pub({}, { '@godcreator/gwb-shell': '0.8.0' }), registry)
    expect(old.map((f) => f.kind)).toEqual(['behind'])
    expect(now).toEqual([])
  })

  it('「最新」认 dist-tags.latest：源上号更大的开发版不算，钉到正式最新就干净', () => {
    const registry = { '@godcreator/gwb-repo-kit': reg(['0.1.0', '0.2.0', '0.2.1-dev.202609151533'], '0.2.0') }
    expect(auditManifest('r', '.', pub({}, { '@godcreator/gwb-repo-kit': '0.2.0' }), registry)).toEqual([])
    const old = auditManifest('r', '.', pub({}, { '@godcreator/gwb-repo-kit': '0.1.0' }), registry)
    expect(old.map((f) => f.detail)).toEqual(['钉 0.1.0，源上最新 0.2.0——火车债'])
  })

  it('源上还没有正式版（没有 latest）：不判火车债', () => {
    const registry = { '@godcreator/gwb-paper-fetch': reg(['0.1.0', '0.1.1-dev.1'], undefined) }
    expect(auditManifest('r', '.', pub({}, { '@godcreator/gwb-paper-fetch': '0.1.0' }), registry)).toEqual([])
  })

  it('workspace:* 是同仓包，跳过；非精确钉版记一笔 loose', () => {
    const got = auditManifest('r', '.', pub({}, { '@godcreator/gwb-skills': 'workspace:*', '@godcreator/gwb-data': '^0.1.0' }), {
      '@godcreator/gwb-skills': reg(['0.4.0']),
      '@godcreator/gwb-data': reg(['0.1.1']),
    })
    expect(got.map((f) => f.kind)).toEqual(['loose-dev-pin'])
  })
})

describe('auditManifest：peer 下限那一档', () => {
  it('下限指向源上没有的版本＝声明了无法验证的世界', () => {
    const got = auditManifest('r', '.', pub({ '@godcreator/gwb-tokens': '>=0.1.1' }, { '@godcreator/gwb-tokens': '0.1.2' }), {
      '@godcreator/gwb-tokens': reg(['0.1.2']),
    })
    expect(got.map((f) => f.kind)).toEqual(['floor-unverifiable'])
  })

  it('下限 ≠ dev 钉＝声明不等于验证过的世界（两边方向都记）', () => {
    const registry = { '@godcreator/gwb-shell': reg(['0.1.0', '0.7.0']) }
    const low = auditManifest('r', '.', pub({ '@godcreator/gwb-shell': '>=0.1.0' }, { '@godcreator/gwb-shell': '0.7.0' }), registry)
    const high = auditManifest('r', '.', pub({ '@godcreator/gwb-shell': '>=0.7.0' }, { '@godcreator/gwb-shell': '0.1.0' }), registry)
    expect(low.map((f) => f.kind)).toEqual(['floor-mismatch'])
    expect(high.map((f) => f.kind).sort()).toEqual(['behind', 'floor-mismatch'])
  })

  it('floor = dev 钉且都在源上＝干净', () => {
    const got = auditManifest('r', '.', pub({ '@godcreator/gwb-shell': '>=0.7.0' }, { '@godcreator/gwb-shell': '0.7.0' }), {
      '@godcreator/gwb-shell': reg(['0.7.0']),
    })
    expect(got).toEqual([])
  })

  it('peer 没有 dev 镜像＝这个面从没验证过', () => {
    const got = auditManifest('r', '.', pub({ '@godcreator/gwb-settings': '>=0.2.0' }, {}), {
      '@godcreator/gwb-settings': reg(['0.2.0']),
    })
    expect(got.map((f) => f.kind)).toEqual(['floor-no-mirror'])
  })

  it('下限写法认不出也说一声（约好 >=x.y.z）', () => {
    const got = auditManifest('r', '.', pub({ '@godcreator/gwb-shell': '^0.7.0' }, {}), {
      '@godcreator/gwb-shell': reg(['0.7.0']),
    })
    expect(got.map((f) => f.kind)).toEqual(['floor-unverifiable'])
  })
})

describe('auditManifest：private 清单', () => {
  const registry = {
    '@godcreator/gwb-shell': reg(['0.1.0', '0.7.0', '0.7.2']),
    '@godcreator/gwb-commands': reg(['0.4.1']),
    '@godcreator/docfirst-workflow': reg(['0.2.0', '0.2.1']),
  }

  it('peer 下限一档整个不审：没人装它，下限写什么都进不了 home', () => {
    const got = auditManifest(
      'r',
      'plugins/command-http',
      { peers: { '@godcreator/gwb-shell': '>=0.1.0', '@godcreator/gwb-commands': '^0.4.0', '@godcreator/gwb-data': '>=9.9.9' }, devs: {}, private: true },
      { ...registry, '@godcreator/gwb-data': reg(['0.1.1']) },
    )
    expect(got).toEqual([])
  })

  it('dev 钉照审：死钉、火车债、非精确钉一个不少', () => {
    const got = auditManifest(
      'r',
      'docs-site',
      { peers: {}, devs: { '@godcreator/gwb-shell': '0.7.1', '@godcreator/gwb-commands': '0.4.1', '@godcreator/docfirst-workflow': '^0.2.0' }, private: true },
      registry,
    )
    expect(got.map((f) => `${f.kind} ${f.pkg}`)).toEqual(['dead-pin @godcreator/gwb-shell', 'loose-dev-pin @godcreator/docfirst-workflow'])
    const behind = auditManifest('r', 'docs-site', { peers: {}, devs: { '@godcreator/gwb-shell': '0.7.0' }, private: true }, registry)
    expect(behind.map((f) => f.kind)).toEqual(['behind'])
  })
})

describe('unitRetired：出生证说退役的单元整个不扫', () => {
  it('status 是 retired 才算', () => {
    expect(unitRetired(JSON.stringify({ kind: '参考仓', status: 'retired' }))).toBe(true)
    expect(unitRetired(JSON.stringify({ kind: '插件仓', status: 'active' }))).toBe(false)
  })
  it('没有出生证、读不懂都当没退役——宁可多扫', () => {
    expect(unitRetired(undefined)).toBe(false)
    expect(unitRetired('半截')).toBe(false)
    expect(unitRetired('null')).toBe(false)
  })
})

describe('countByKind', () => {
  it('各类计数，缺席的记零', () => {
    expect(countByKind(auditManifest('r', '.', pub({}, { '@godcreator/gwb-x': '9.9.9' }), { '@godcreator/gwb-x': reg(['1.0.0']) }))).toMatchObject({ 'dead-pin': 1, behind: 0 })
  })
})
