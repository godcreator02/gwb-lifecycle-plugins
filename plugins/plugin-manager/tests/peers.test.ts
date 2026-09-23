import { describe, expect, it } from 'vitest'
import { peerKindOf, planPeers, toPeerDependencies, type PeerKind } from '../src/peers.js'

/** 装机那条路的支点：装错一条 peer，工作台就装不了东西——判据全钉在这儿 */

const NONE: Record<string, string> = {}
const NO_KINDS: Record<string, PeerKind | undefined> = {}

describe('peerDependencies 收窄', () => {
  it('只收字符串格', () => {
    expect(toPeerDependencies({ peerDependencies: { a: '>=1.0.0', b: 2, c: '^0.1' } })).toEqual({
      a: '>=1.0.0',
      c: '^0.1',
    })
  })

  it('没有这个字段、清单坏了、清单读不出来，都是空表', () => {
    expect(toPeerDependencies({})).toEqual({})
    expect(toPeerDependencies({ peerDependencies: 'nope' })).toEqual({})
    expect(toPeerDependencies(undefined)).toEqual({})
    expect(toPeerDependencies(null)).toEqual({})
    expect(toPeerDependencies([{ a: '1' }])).toEqual({})
  })
})

describe('包是共享包还是件', () => {
  it('清单里有 gwb.shared 的是共享包——空对象也算（gwb-tokens 就是这种）', () => {
    expect(peerKindOf({ gwb: { shared: { react: './react' } } })).toBe('shared')
    expect(peerKindOf({ gwb: { shared: {} } })).toBe('shared')
  })

  it('没有这个字段的当件', () => {
    expect(peerKindOf({ name: '@godcreator/gwb-commands' })).toBe('plugin')
    expect(peerKindOf({ gwb: {} })).toBe('plugin')
  })

  it('清单根本读不出来时不猜', () => {
    expect(peerKindOf(undefined)).toBeUndefined()
  })
})

describe('peer 计划', () => {
  it('生态外的包一律装——那正是这次要接的形状', () => {
    expect(planPeers({ '@godcreator/docfirst-workflow': '>=0.4.0' }, NONE, NO_KINDS)).toEqual([
      { pkg: '@godcreator/docfirst-workflow', range: '>=0.4.0', decision: 'install' },
    ])
  })

  it('已经在 home 的 package.json 里的不动，也不降级', () => {
    const plan = planPeers({ 'some-lib': '>=1.0.0' }, { 'some-lib': '2.5.0' }, NO_KINDS)
    expect(plan[0]?.decision).toBe('present')
    expect(plan[0]?.note).toContain('2.5.0')
  })

  it('cordis 跳过：home 里再装一份就是第二张服务注册表', () => {
    const plan = planPeers({ cordis: '^4.0.0-rc.9' }, NONE, NO_KINDS)
    expect(plan[0]?.decision).toBe('skipped')
  })

  it('本生态的件跳过，共享包装', () => {
    const peers = {
      '@godcreator/gwb-commands': '>=0.2.0',
      '@godcreator/gwb-shared-react': '>=0.0.2',
      '@godcreator/gwb-tokens': '>=0.0.2',
    }
    const kinds: Record<string, PeerKind | undefined> = {
      '@godcreator/gwb-commands': 'plugin',
      '@godcreator/gwb-shared-react': 'shared',
      '@godcreator/gwb-tokens': 'shared',
    }
    expect(planPeers(peers, NONE, kinds).map((item) => [item.pkg, item.decision])).toEqual([
      ['@godcreator/gwb-commands', 'skipped'],
      ['@godcreator/gwb-shared-react', 'install'],
      ['@godcreator/gwb-tokens', 'install'],
    ])
  })

  it('本生态里认不出种类的保守跳过，并把「认不出」写进 note', () => {
    const plan = planPeers({ '@godcreator/gwb-mystery': '>=0.1.0' }, NONE, NO_KINDS)
    expect(plan[0]?.decision).toBe('skipped')
    expect(plan[0]?.note).toContain('认不出')
    expect(plan[0]?.note).toContain('optional')
  })

  it('生态外的包认不出种类照样装——那条判据只对 @godcreator/gwb-* 问', () => {
    expect(planPeers({ chokidar: '>=4' }, NONE, NO_KINDS)[0]?.decision).toBe('install')
  })

  it('已经在 home 里的优先于「该跳过」：装了就是装了，不去改它', () => {
    const plan = planPeers({ '@godcreator/gwb-commands': '>=0.2.0' }, { '@godcreator/gwb-commands': '0.2.0' }, {
      '@godcreator/gwb-commands': 'plugin',
    })
    expect(plan[0]?.decision).toBe('present')
  })

  it('按包名排；一条 peer 都没声明就是空计划', () => {
    const plan = planPeers({ zzz: '>=1', aaa: '>=1' }, NONE, NO_KINDS)
    expect(plan.map((item) => item.pkg)).toEqual(['aaa', 'zzz'])
    expect(planPeers({}, NONE, NO_KINDS)).toEqual([])
  })

  it('range 原样带进计划——装的是 latest，对不上时人得看得见', () => {
    expect(planPeers({ 'some-lib': '^1.2.3' }, NONE, NO_KINDS)[0]?.range).toBe('^1.2.3')
  })
})
