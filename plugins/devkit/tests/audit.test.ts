import { describe, expect, it } from 'vitest'
import { auditManifest, caretCeiling, caretFloor, compareVersions, countByKind, inCaret, unitRetired, unitTest, type ManifestDeps } from '../src/audit'

/** 对账的判例。registry 现值全是喂的——这层不碰网，判定逻辑单测钉死 */
const reg = (versions: string[], latest: string | undefined = versions.filter((v) => !v.includes('-')).at(-1)) => ({
  versions,
  ...(latest === undefined ? {} : { latest }),
})

/** 一份发布的插件清单（不是 private，keywords 含 gwb-plugin） */
const pub = (peers: Record<string, string>, devs: Record<string, string>): ManifestDeps => ({ peers, devs, private: false, plugin: true })

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

  it('范围内落后是 behind，钉到最新就干净', () => {
    const registry = { '@godcreator/gwb-shell': reg(['0.7.0', '0.7.2']) }
    const old = auditManifest('r', '.', pub({}, { '@godcreator/gwb-shell': '0.7.0' }), registry)
    const now = auditManifest('r', '.', pub({}, { '@godcreator/gwb-shell': '0.7.2' }), registry)
    expect(old.map((f) => f.kind)).toEqual(['behind'])
    expect(old[0]?.detail).toContain('^0.7.0 范围内')
    expect(now).toEqual([])
  })

  it('最新出了 ^<dev 钉> 范围是 out-of-range（必须追），不再算 behind', () => {
    const registry = { '@godcreator/gwb-shell': reg(['0.8.0', '0.9.0']) }
    const got = auditManifest('r', '.', pub({}, { '@godcreator/gwb-shell': '0.8.0' }), registry)
    expect(got.map((f) => f.kind)).toEqual(['out-of-range'])
    expect(got[0]?.detail).toContain('必须追')
  })

  it('0.0.x 的钉：下一个补丁号就出范围', () => {
    const registry = { '@godcreator/gwb-shared-react': reg(['0.0.4', '0.0.5']) }
    const got = auditManifest('r', '.', pub({}, { '@godcreator/gwb-shared-react': '0.0.4' }), registry)
    expect(got.map((f) => f.kind)).toEqual(['out-of-range'])
  })

  it('「最新」认 dist-tags.latest：源上号更大的开发版不算，钉到正式最新就干净', () => {
    const registry = { '@godcreator/gwb-repo-kit': reg(['0.1.0', '0.1.1', '0.1.2-dev.202609151533'], '0.1.1') }
    expect(auditManifest('r', '.', pub({}, { '@godcreator/gwb-repo-kit': '0.1.1' }), registry)).toEqual([])
    const old = auditManifest('r', '.', pub({}, { '@godcreator/gwb-repo-kit': '0.1.0' }), registry)
    expect(old.map((f) => f.kind)).toEqual(['behind'])
  })

  it('源上还没有正式版（没有 latest）：不判火车债', () => {
    const registry = { '@godcreator/gwb-paper-fetch': reg(['0.1.0', '0.1.1-dev.1'], undefined) }
    expect(auditManifest('r', '.', pub({}, { '@godcreator/gwb-paper-fetch': '0.1.0' }), registry)).toEqual([])
  })

  it('workspace:* 是同仓包，跳过；^ 现在合法（范围内静默），认不出的写法记一笔 loose', () => {
    const got = auditManifest('r', '.', pub({}, { '@godcreator/gwb-skills': 'workspace:*', '@godcreator/gwb-data': '~0.1.0' }), {
      '@godcreator/gwb-skills': reg(['0.4.0']),
      '@godcreator/gwb-data': reg(['0.1.1']),
    })
    expect(got.map((f) => f.kind)).toEqual(['loose-dev-pin'])
  })
})

describe('auditManifest：插件包的 peer 只许 cordis 与内核包', () => {
  it('peer 只有 cordis 与内核包：干净', () => {
    expect(auditManifest('r', '.', pub({ cordis: '^4.0.0-rc.9', '@godcreator/gwb-kernel-desktop': '^0.3.0' }, {}), {})).toEqual([])
  })

  it('cordis 与内核包以外的 peer 一条一笔 peer-not-cordis，不管写法、不问源', () => {
    const got = auditManifest(
      'r',
      '.',
      pub({ '@godcreator/gwb-shell': '^0.13.3', react: '>=19', cordis: '^4.0.0-rc.9', '@godcreator/gwb-kernel-desktop': '^0.3.0' }, {}),
      {},
    )
    expect(got.map((f) => `${f.kind} ${f.pkg}`)).toEqual(['peer-not-cordis @godcreator/gwb-shell', 'peer-not-cordis react'])
    expect(got[0]?.detail).toContain('按「运行时谁提供」改写')
    expect(got[0]?.detail).toContain('@godcreator/gwb-kernel-desktop')
  })

  it('不是插件包（库）：peer 不查', () => {
    const lib: ManifestDeps = { peers: { react: '^19.0.0' }, devs: {}, private: false, plugin: false }
    expect(auditManifest('r', 'packages/lib', lib, {})).toEqual([])
  })
})

describe('caret 语义', () => {
  it('上限：第一个非零段进一', () => {
    expect(caretCeiling('1.2.3')).toBe('2.0.0')
    expect(caretCeiling('0.8.3')).toBe('0.9.0')
    expect(caretCeiling('0.0.4')).toBe('0.0.5')
  })
  it('范围内外；预发布号一概不算在内', () => {
    expect(inCaret('0.8.0', '0.8.9')).toBe(true)
    expect(inCaret('0.8.0', '0.9.0')).toBe(false)
    expect(inCaret('0.8.0', '0.7.9')).toBe(false)
    expect(inCaret('0.8.0', '0.8.1-dev.202609181200')).toBe(false)
  })
  it('只认 ^x.y.z', () => {
    expect(caretFloor('^0.9.0')).toBe('0.9.0')
    expect(caretFloor('>=0.9.0')).toBeUndefined()
    expect(caretFloor('^0.9')).toBeUndefined()
  })
})

describe('auditManifest：private 清单', () => {
  const registry = {
    '@godcreator/gwb-shell': reg(['0.1.0', '0.7.0', '0.7.2']),
    '@godcreator/gwb-commands': reg(['0.4.1']),
    '@godcreator/docfirst-workflow': reg(['0.2.0', '0.2.1']),
  }

  it('peer 整个不查：没人装它，写什么都进不了 home', () => {
    const got = auditManifest(
      'r',
      'plugins/command-http',
      { peers: { '@godcreator/gwb-shell': '>=0.1.0', '@godcreator/gwb-commands': '^0.4.0' }, devs: {}, private: true, plugin: true },
      registry,
    )
    expect(got).toEqual([])
  })

  it('dev 钉照审：死钉、火车债、非精确钉一个不少', () => {
    const got = auditManifest(
      'r',
      'docs-site',
      { peers: {}, devs: { '@godcreator/gwb-shell': '0.7.1', '@godcreator/gwb-commands': '0.4.1', '@godcreator/docfirst-workflow': '~0.2.0' }, private: true, plugin: false },
      registry,
    )
    expect(got.map((f) => `${f.kind} ${f.pkg}`)).toEqual(['dead-pin @godcreator/gwb-shell', 'loose-dev-pin @godcreator/docfirst-workflow'])
    const behind = auditManifest('r', 'docs-site', { peers: {}, devs: { '@godcreator/gwb-shell': '0.7.0' }, private: true, plugin: false }, registry)
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

describe('unitTest：出生证 kind 是「测试件」的单元同样整个不扫', () => {
  it('kind 正好是「测试件」才算（retired 的走 retired 那一档）', () => {
    expect(unitTest(JSON.stringify({ kind: '测试件', status: 'active' }))).toBe(true)
    expect(unitTest(JSON.stringify({ kind: '插件仓', status: 'active' }))).toBe(false)
    expect(unitTest(JSON.stringify({ kind: '参考仓', status: 'retired' }))).toBe(false)
  })
  it('没有出生证、读不懂都当不是——宁可多扫', () => {
    expect(unitTest(undefined)).toBe(false)
    expect(unitTest('半截')).toBe(false)
    expect(unitTest('null')).toBe(false)
  })
})

describe('countByKind', () => {
  it('各类计数，缺席的记零', () => {
    expect(countByKind(auditManifest('r', '.', pub({}, { '@godcreator/gwb-x': '9.9.9' }), { '@godcreator/gwb-x': reg(['1.0.0']) }))).toMatchObject({ 'dead-pin': 1, behind: 0 })
  })
})
