import { describe, expect, it } from 'vitest'
import { DEFAULT_REGISTRY, parseSources, registryFor, registryKeyOf } from '../src/sources.js'

/**
 * 读 npmrc 的纯逻辑。行的形状照这台机器上的实际文件写：
 * `@godcreator:registry=<gitea 源>`、`//<源路径>/:_authToken=<token>`、外加一行 npmjs 的 token 与注释。
 */

const GODCREATOR = 'https://git.example.com/api/packages/godcreator/npm/'
const J = 'https://git.example.com/api/packages/J/npm/'

const machineNpmrc = [
  '# 注释也在',
  `@godcreator:registry=${GODCREATOR}`,
  `//git.example.com/api/packages/godcreator/npm/:_authToken=t-god`,
  `@j:registry=${J}`,
  `//git.example.com/api/packages/J/npm/:_authToken=t-god`,
  '//registry.npmjs.org/:_authToken=t-npm',
  '',
].join('\n')

describe('registryKeyOf', () => {
  it('去掉协议、补上结尾斜杠——带不带结尾斜杠的同一条源得到同一个键', () => {
    expect(registryKeyOf('https://h.example/p/npm/')).toBe('//h.example/p/npm/')
    expect(registryKeyOf('https://h.example/p/npm')).toBe('//h.example/p/npm/')
    expect(registryKeyOf('http://h.example:4873')).toBe('//h.example:4873/')
  })
})

describe('parseSources', () => {
  it('两行一组读出来：token 按源地址配上', () => {
    expect(parseSources(machineNpmrc)).toEqual([
      { scope: '@godcreator', registry: GODCREATOR, token: 't-god' },
      { scope: '@j', registry: J, token: 't-god' },
    ])
  })

  it('npmjs 那条 token 没有 scope 指着它，不进表', () => {
    expect(parseSources('//registry.npmjs.org/:_authToken=t-npm')).toEqual([])
  })

  it('token 配不上就没有这一项；注释与空行不影响', () => {
    const got = parseSources(`# c\n\n@j:registry=${J}\n`)
    expect(got).toEqual([{ scope: '@j', registry: J }])
  })
})

describe('registryFor：某个 scope 从哪个源装，照 pnpm 读两份 npmrc 的优先级', () => {
  it('scope 路由优先：机器级写了就用它', () => {
    expect(registryFor('@j', { home: '', user: machineNpmrc })).toBe(J)
  })

  it('home 级同名 scope 优先于机器级', () => {
    expect(registryFor('@j', { home: '@j:registry=https://h2.example/npm/', user: machineNpmrc })).toBe(
      'https://h2.example/npm/',
    )
  })

  it('没有 scope 路由时用 registry= 那一行，同样 home 级优先', () => {
    const user = 'registry=https://mirror.example/npm/'
    expect(registryFor('@z', { home: '', user })).toBe('https://mirror.example/npm/')
    expect(registryFor('@z', { home: 'registry=https://home.example/', user })).toBe('https://home.example/')
  })

  it('都没写就是 npm 官方源', () => {
    expect(registryFor('@z', { home: '', user: '' })).toBe(DEFAULT_REGISTRY)
  })

  it('返回的地址总以斜杠结尾，检索地址才拼得对', () => {
    expect(registryFor('@k', { home: '@k:registry=https://k.example/npm', user: '' })).toBe('https://k.example/npm/')
    expect(registryFor('@z', { home: '', user: 'registry=https://mirror.example' })).toBe('https://mirror.example/')
  })
})
