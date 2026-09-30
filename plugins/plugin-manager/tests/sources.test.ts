import { describe, expect, it } from 'vitest'
import { authTokenKeyOf, marketSourceOf, marketsOf } from '../src/sources.js'

/**
 * 市场名单与 pnpm 配置的纯逻辑。配置照这台机器上 `pnpm config list --json` 的实际输出写：
 * 凭据被遮成 `(protected)`，pnpm 自带一条 `@jsr:registry`，全局源 `registry` 总在
 */

const GODCREATOR = 'https://git.example.com/api/packages/godcreator/npm/'

const pnpmConfig = {
  '//git.example.com/api/packages/godcreator/npm/:_authToken': '(protected)',
  '@godcreator:registry': GODCREATOR,
  '@k:registry': 'https://k.example/npm',
  '@jsr:registry': 'https://npm.jsr.io/',
  registry: 'https://registry.npmjs.org/',
}

describe('marketsOf：设置项的值', () => {
  it('字符串数组原样用，顺序不变', () => {
    expect(marketsOf(['@godcreator', '@j'])).toEqual(['@godcreator', '@j'])
  })

  it('不是字符串数组、有重复：直接报错，不替它修正', () => {
    expect(() => marketsOf('@godcreator')).toThrow('要是字符串数组')
    expect(() => marketsOf(['@godcreator', 1])).toThrow('要是字符串数组')
    expect(() => marketsOf(['@j', '@j'])).toThrow('@j 写了不止一次')
  })
})

describe('marketSourceOf：一个市场去哪查', () => {
  it('用 pnpm 配置里这个 scope 自己的路由，地址补上结尾斜杠', () => {
    expect(marketSourceOf('@godcreator', pnpmConfig)).toEqual({ ok: true, scope: '@godcreator', registry: GODCREATOR })
    expect(marketSourceOf('@k', pnpmConfig)).toEqual({ ok: true, scope: '@k', registry: 'https://k.example/npm/' })
  })

  it('这个 scope 没有路由：报没配源，不去全局源 registry 查', () => {
    const got = marketSourceOf('@j', pnpmConfig)
    expect(got).toEqual({ ok: false, scope: '@j', error: expect.stringContaining('pnpm 里没配这个市场的源') as unknown })
    expect(got.ok ? '' : got.error).toContain('@j:registry=<源地址>')
  })

  it('不是 scope 的写法：报错，不拿去查', () => {
    for (const scope of ['godcreator', '@', '@God', 'x@y']) {
      expect(marketSourceOf(scope, pnpmConfig), scope).toEqual({ ok: false, scope, error: expect.stringContaining('不是 scope 的写法') as unknown })
    }
  })
})

describe('authTokenKeyOf', () => {
  it('去掉协议、补上结尾斜杠——带不带结尾斜杠的同一条源得到同一个凭据键', () => {
    expect(authTokenKeyOf('https://h.example/p/npm/')).toBe('//h.example/p/npm/:_authToken')
    expect(authTokenKeyOf('https://h.example/p/npm')).toBe('//h.example/p/npm/:_authToken')
    expect(authTokenKeyOf('http://h.example:4873')).toBe('//h.example:4873/:_authToken')
  })
})
