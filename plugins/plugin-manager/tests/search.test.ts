import { describe, expect, it } from 'vitest'
import { isPluginRow, mergeScoped, parseSearch, type ScopedSearch } from '../src/search.js'

/**
 * 检索的解析与过滤。响应形状是实测确定的（2026-09-08，`/-/v1/search?text=@godcreator`）：
 * 顶层 `{ objects, total, time }`，每条 `object.package` 带 name/version/description/keywords；
 * 2026-09-15 起 name 有两种形状——npmjs、verdaccio 把 scope 写在 name 里，gitea 分开放，见下面的用例。
 * 这组测试同时检查两条约定：**这里不认识任何具体的 registry**（只认协议）；
 * 「是不是插件」自 2026-09-18 起只看包自己写的 keywords（`gwb-plugin`）——名字不参与，也没有兜底。
 */

const response = (objects: unknown[]): string => JSON.stringify({ objects, total: objects.length, time: 0 })

const entry = (name: string, patch: Record<string, unknown> = {}): unknown => ({
  downloads: { monthly: 0, weekly: 0 },
  searchScore: 0,
  package: { name, version: '0.0.1', description: `${name} 的一句话`, ...patch },
})

describe('parseSearch', () => {
  it('一份正经的响应原样收下，用不着的字段（downloads/score/publisher）不看', () => {
    const got = parseSearch(
      response([
        entry('@godcreator/gwb-plugin-manager', { version: '0.0.8', description: '管 home 里的包与条目' }),
        entry('@godcreator/gwb-shell'),
      ]),
    )
    expect(got).toEqual([
      { pkg: '@godcreator/gwb-plugin-manager', version: '0.0.8', description: '管 home 里的包与条目', keywords: [] },
      { pkg: '@godcreator/gwb-shell', version: '0.0.1', description: '@godcreator/gwb-shell 的一句话', keywords: [] },
    ])
  })

  it('keywords 原样收进来（判断是不是插件就看这一项）', () => {
    const got = parseSearch(response([entry('@godcreator/gwb-shell', { keywords: ['gwb', 'gwb-plugin'] })]))
    expect(got?.[0]?.keywords).toEqual(['gwb', 'gwb-plugin'])
  })

  it('keywords 缺了 / 不是数组 / 元素不是字符串都当没有——不挡这一行，也不猜', () => {
    const got = parseSearch(
      response([
        entry('a', { version: '1.0.0' }),
        entry('b', { version: '1.0.0', keywords: 'gwb-plugin' }),
        entry('c', { version: '1.0.0', keywords: ['gwb-plugin', 7, null] }),
      ]),
    )
    expect(got?.map((row) => row.keywords)).toEqual([[], [], ['gwb-plugin']])
  })

  it('不是 JSON、不是对象、没有 objects——整份返回 undefined，让调用方给一句能看懂的话', () => {
    expect(parseSearch('Internal Error')).toBeUndefined()
    expect(parseSearch('[]')).toBeUndefined()
    expect(parseSearch('{"total": 0}')).toBeUndefined()
  })

  it('空 objects 是空结果，不是失败', () => {
    expect(parseSearch(response([]))).toEqual([])
  })

  it('**坏条目只跳过那一条**：缺 name、package 不是对象、整个条目是标量', () => {
    const got = parseSearch(
      response([entry(''), { package: { version: '1.0.0' } }, 'not-an-object', entry('@godcreator/gwb-data')]),
    )
    expect(got).toEqual([
      { pkg: '@godcreator/gwb-data', version: '0.0.1', description: '@godcreator/gwb-data 的一句话', keywords: [] },
    ])
  })

  it('version / description 缺了或不是字符串就当没有，不挡这一行', () => {
    const got = parseSearch(response([{ package: { name: '@godcreator/gwb-x', version: 7, description: '' } }]))
    expect(got).toEqual([{ pkg: '@godcreator/gwb-x', keywords: [] }])
  })

  it('**响应不统一**：没有 version 的条目改用 dist-tags.latest（实测同一份响应里两种并存）', () => {
    const got = parseSearch(
      response([{ package: { name: '@godcreator/gwb-y', description: '旧索引的一条', 'dist-tags': { latest: '0.1.4' } } }]),
    )
    expect(got).toEqual([{ pkg: '@godcreator/gwb-y', version: '0.1.4', description: '旧索引的一条', keywords: [] }])
  })

  it('gitea 形状：scope 分开放（name 只有 gwb-x），拼回全名', () => {
    const got = parseSearch(
      response([
        entry('gwb-plugin-manager', { scope: '@godcreator', version: '0.3.0' }),
        entry('gwb-bn-comment', { scope: '@godcreator', version: '0.3.1-dev.1' }),
      ]),
    )
    expect(got).toEqual([
      { pkg: '@godcreator/gwb-plugin-manager', version: '0.3.0', description: 'gwb-plugin-manager 的一句话', keywords: [] },
      { pkg: '@godcreator/gwb-bn-comment', version: '0.3.1-dev.1', description: 'gwb-bn-comment 的一句话', keywords: [] },
    ])
  })

  it('name 已带 @ 前缀时即使另有 scope 字段也不重复拼（混形状的源两边都对）', () => {
    const got = parseSearch(response([entry('@godcreator/gwb-z', { scope: '@godcreator' })]))
    expect(got).toEqual([
      { pkg: '@godcreator/gwb-z', version: '0.0.1', description: '@godcreator/gwb-z 的一句话', keywords: [] },
    ])
  })

  it('scope 不是字符串就当没有，name 原样用（不猜）', () => {
    const got = parseSearch(response([entry('gwb-thing', { scope: 7 })]))
    expect(got).toEqual([{ pkg: 'gwb-thing', version: '0.0.1', description: 'gwb-thing 的一句话', keywords: [] }])
  })
})

describe('isPluginRow：是不是插件只看包自己写的 keywords，没有兜底', () => {
  const row = (pkg: string, keywords: string[]) => ({ pkg, keywords })

  it('写了 gwb-plugin 就是插件（不管名字长什么样）', () => {
    expect(isPluginRow(row('@godcreator/gwb-shell', ['gwb', 'gwb-plugin']))).toBe(true)
    expect(isPluginRow(row('@someone/whatever', ['gwb-plugin']))).toBe(true)
  })

  it('**名字不参与判断**：gwb- 前缀 / @godcreator scope 都不是判据', () => {
    expect(isPluginRow(row('@godcreator/gwb-shell', []))).toBe(false)
    expect(isPluginRow(row('@godcreator/gwb-shell', ['gwb']))).toBe(false)
  })

  it('只写 gwb（表示属于这个生态，如库、共享包）不算插件；没写 keywords 也不算', () => {
    expect(isPluginRow(row('@godcreator/block-note', ['gwb']))).toBe(false)
    expect(isPluginRow(row('@godcreator/gwb-tokens', []))).toBe(false)
  })
})

describe('mergeScoped：合并多条源，一条失败不影响别的', () => {
  const row = (pkg: string) => ({ pkg, keywords: ['gwb-plugin'] })

  it('查成的源按传入顺序并起来（顺序由调用方定），包名带 scope 不用去重', () => {
    const merged = mergeScoped([
      { scope: '@godcreator', ok: true, packages: [row('@godcreator/gwb-shell'), row('@godcreator/gwb-theme')] },
      { scope: '@j', ok: true, packages: [row('@j/gwb-daily-planner')] },
    ])
    expect(merged.packages.map((one) => one.pkg)).toEqual([
      '@godcreator/gwb-shell',
      '@godcreator/gwb-theme',
      '@j/gwb-daily-planner',
    ])
    expect(merged.failed).toEqual([])
  })

  it('没查成的源列进 failed、不进包列表；没说原因时给一句默认的', () => {
    const merged = mergeScoped([
      { scope: '@godcreator', ok: true, packages: [row('@godcreator/gwb-shell')] },
      { scope: '@dead', ok: false, error: '连不上源' },
      { scope: '@mute', ok: false },
    ])
    expect(merged.packages.map((one) => one.pkg)).toEqual(['@godcreator/gwb-shell'])
    expect(merged.failed).toEqual([
      { scope: '@dead', error: '连不上源' },
      { scope: '@mute', error: '没说原因' },
    ])
  })

  it('ok: true 但没有 packages 的当没查成算——不当成「查成了、零个插件」', () => {
    const merged = mergeScoped([{ scope: '@odd', ok: true } satisfies ScopedSearch])
    expect(merged.packages).toEqual([])
    expect(merged.failed).toEqual([{ scope: '@odd', error: '没说原因' }])
  })
})
