import { describe, expect, it } from 'vitest'
import { distManifest } from '../src/node-dev-deps.js'

/**
 * `node-dev-deps.ts` 整层是环境胶水、不进单测，唯独 `distManifest` 不是胶水：它决定
 * 分发形态里每一条依赖写什么号。写错的那句话是「新件配旧库」——装得上、跑得欢、
 * 不报错，正是这套里最难查的一种。所以单独把它钉在这儿。
 */

/** 一份典型的工作区清单：同仓兄弟用 workspace:，外来包用普通范围 */
const MANIFEST = {
  name: '@godcreator/gwb-fake',
  version: '0.3.1',
  files: ['dist'],
  scripts: { build: 'tsc', test: 'vitest run' },
  dependencies: {
    '@godcreator/gwb-sibling': 'workspace:^',
    'yaml': '^2.8.0',
  },
  peerDependencies: {
    '@godcreator/gwb-plugin-api': 'workspace:^',
  },
  devDependencies: { typescript: '^7.0.2' },
  gwb: { title: '假的' },
} as const

const SIBLINGS = { '@godcreator/gwb-sibling': '0.4.0-dev.202609131200' }
const WORKSPACE = new Map([
  ['@godcreator/gwb-sibling', '0.3.9'],
  ['@godcreator/gwb-plugin-api', '0.1.0'],
])

describe('分发清单', () => {
  it('号换成这一趟那个，scripts 与 devDependencies 删掉，别的字段原样带过去', () => {
    const out = distManifest(MANIFEST, '0.4.0-dev.202609131200', SIBLINGS, WORKSPACE)
    expect(out.version).toBe('0.4.0-dev.202609131200')
    expect(out.scripts).toBeUndefined()
    expect(out.devDependencies).toBeUndefined()
    expect(out.gwb).toEqual({ title: '假的' })
    expect(out.name).toBe('@godcreator/gwb-fake')
  })

  it('不改入参那份清单——仓里的 package.json 一个字都不动', () => {
    distManifest(MANIFEST, '0.4.0-dev.202609131200', SIBLINGS, WORKSPACE)
    expect(MANIFEST.version).toBe('0.3.1')
    expect(MANIFEST.scripts).toEqual({ build: 'tsc', test: 'vitest run' })
    expect(MANIFEST.devDependencies).toEqual({ typescript: '^7.0.2' })
  })

  it('同趟发的兄弟钉成它的准确号——范围认不到 dev 版，不钉就是新件配旧库', () => {
    const out = distManifest(MANIFEST, '0.4.0-dev.202609131200', SIBLINGS, WORKSPACE)
    expect(out.dependencies?.['@godcreator/gwb-sibling']).toBe('0.4.0-dev.202609131200')
  })

  it('正式版那趟给的是 ^ 范围，原样写进去——消费方跟得进破坏边界以内的后续版本', () => {
    const out = distManifest(MANIFEST, '0.4.0', { '@godcreator/gwb-sibling': '^0.4.0' }, WORKSPACE)
    expect(out.dependencies?.['@godcreator/gwb-sibling']).toBe('^0.4.0')
  })

  it('不是兄弟的 workspace: 换成 ^<工作区里那个号>；工作区里没有就 ^0.0.0', () => {
    const out = distManifest(
      { ...MANIFEST, dependencies: { '@godcreator/gwb-sibling': 'workspace:^', '@godcreator/gwb-stranger': 'workspace:*' } },
      '0.4.0-dev.202609131200',
      {},
      WORKSPACE,
    )
    expect(out.dependencies?.['@godcreator/gwb-sibling']).toBe('^0.3.9')
    expect(out.dependencies?.['@godcreator/gwb-stranger']).toBe('^0.0.0')
  })

  it('普通范围原样过，外来包不掺和', () => {
    const out = distManifest(MANIFEST, '0.4.0-dev.202609131200', SIBLINGS, WORKSPACE)
    expect(out.dependencies?.['yaml']).toBe('^2.8.0')
  })

  it('peer 不钉兄弟的准确号——钉了就是逼消费方也换版本；workspace: 照样换成真号', () => {
    const out = distManifest(
      { ...MANIFEST, peerDependencies: { '@godcreator/gwb-sibling': 'workspace:^', '@godcreator/gwb-plugin-api': '>=0.1.0' } },
      '0.4.0-dev.202609131200',
      SIBLINGS,
      WORKSPACE,
    )
    expect(out.peerDependencies?.['@godcreator/gwb-sibling']).toBe('^0.3.9')
    expect(out.peerDependencies?.['@godcreator/gwb-plugin-api']).toBe('>=0.1.0')
  })
})
