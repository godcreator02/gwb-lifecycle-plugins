import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_SCOPE,
  DEFAULT_REGISTRY,
  isRegistryUrl,
  isScope,
  mergeSources,
  parseSources,
  registryFor,
  registryKeyOf,
  removeSource,
  upsertSource,
} from '../src/sources.js'

/**
 * npmrc 纯逻辑的测试。行的形状照这台机器上的实际文件写：
 * `@godcreator:registry=<gitea 源>`、`//<源路径>/:_authToken=<token>`、外加一行
 * npmjs 的 token 与注释——都不许被增删改弄丢。
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

describe('isScope / isRegistryUrl', () => {
  it('认 @ 开头、不带斜杠的 scope，大写也收（gitea 源上 @j 实际能用）', () => {
    expect(isScope('@j')).toBe(true)
    expect(isScope('@godcreator')).toBe(true)
    expect(isScope('@my-team.tools')).toBe(true)
  })

  it('拦住手滑：包名、忘了 @、带斜杠、空串', () => {
    expect(isScope('@a/b')).toBe(false)
    expect(isScope('godcreator')).toBe(false)
    expect(isScope('@')).toBe(false)
    expect(isScope('')).toBe(false)
    expect(isScope(undefined)).toBe(false)
  })

  it('源地址只要 http(s) 开头且没有空白', () => {
    expect(isRegistryUrl('https://x.example/npm/')).toBe(true)
    expect(isRegistryUrl('http://localhost:4873/')).toBe(true)
    expect(isRegistryUrl('git.example.com/npm/')).toBe(false)
    expect(isRegistryUrl('https://a b')).toBe(false)
  })
})

describe('registryKeyOf', () => {
  it('去掉协议、补上结尾斜杠——带不带结尾斜杠的同一条源得到同一个键', () => {
    expect(registryKeyOf('https://h.example/p/npm/')).toBe('//h.example/p/npm/')
    expect(registryKeyOf('https://h.example/p/npm')).toBe('//h.example/p/npm/')
    expect(registryKeyOf('http://h.example:4873')).toBe('//h.example:4873/')
  })
})

describe('parseSources / mergeSources', () => {
  it('两行一组读出来：token 按源地址配上', () => {
    expect(parseSources(machineNpmrc)).toEqual([
      { scope: '@godcreator', registry: GODCREATOR, token: 't-god' },
      { scope: '@j', registry: J, token: 't-god' },
    ])
  })

  it('npmjs 那条 token 没有 scope 指着它，不进表（但删改时也不许弄丢它）', () => {
    expect(parseSources('//registry.npmjs.org/:_authToken=t-npm')).toEqual([])
  })

  it('token 配不上就没有这一项；注释与空行不影响', () => {
    const got = parseSources(`# c\n\n@j:registry=${J}\n`)
    expect(got).toEqual([{ scope: '@j', registry: J }])
  })

  it('合并时带出处：同一 scope 在两层各出现一次，两条都列出来', () => {
    const got = mergeSources([
      { file: 'user', text: `@j:registry=${J}` },
      { file: 'home', text: `@j:registry=https://h2.example/npm/` },
    ])
    expect(got).toEqual([
      { scope: '@j', registry: J, file: 'user' },
      { scope: '@j', registry: 'https://h2.example/npm/', file: 'home' },
    ])
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

describe('upsertSource', () => {
  it('全新 scope：两行追加在末尾空行之前，原有行一个不动', () => {
    const { text, wrote, replaced } = upsertSource(machineNpmrc, {
      scope: '@z',
      registry: 'https://z.example/npm/',
      token: 't-z',
    })
    expect(replaced).toBe(false)
    expect(wrote).toEqual(['@z:registry=https://z.example/npm/', '//z.example/npm/:_authToken=t-z'])
    expect(text.split('\n')).toEqual([
      '# 注释也在',
      `@godcreator:registry=${GODCREATOR}`,
      '//git.example.com/api/packages/godcreator/npm/:_authToken=t-god',
      `@j:registry=${J}`,
      '//git.example.com/api/packages/J/npm/:_authToken=t-god',
      '//registry.npmjs.org/:_authToken=t-npm',
      '@z:registry=https://z.example/npm/',
      '//z.example/npm/:_authToken=t-z',
      '',
    ])
  })

  it('已有 scope：原地替换路由行；不给 token 时旧源那条 token 已经没人指向，一起删掉', () => {
    const { text, wrote, replaced } = upsertSource(machineNpmrc, { scope: '@j', registry: 'https://j2.example/npm/' })
    expect(replaced).toBe(true)
    expect(wrote).toEqual(['@j:registry=https://j2.example/npm/'])
    expect(text).toContain('@j:registry=https://j2.example/npm/')
    // 旧源没人指向了，它的凭据行一起删掉；godcreator 与 npmjs 的行不动
    expect(text).not.toContain('//git.example.com/api/packages/J/npm/:_authToken')
    expect(text).toContain('//git.example.com/api/packages/godcreator/npm/:_authToken=t-god')
    expect(text).toContain('//registry.npmjs.org/:_authToken=t-npm')
  })

  it('换源后旧 token 没人指向了，一起删掉；别的 scope 还指向的（@godcreator 同一个 token）不删', () => {
    const onlyJ = [`@j:registry=${J}`, '//git.example.com/api/packages/J/npm/:_authToken=t-god', ''].join('\n')
    const moved = upsertSource(onlyJ, { scope: '@j', registry: 'https://j2.example/npm/', token: 't-j2' })
    expect(moved.text).not.toContain('//git.example.com/api/packages/J/npm/:_authToken')
    expect(moved.text).toContain('//j2.example/npm/:_authToken=t-j2')

    // 同一个键换 token：原地替换，不多写一行
    const again = upsertSource(moved.text, { scope: '@j', registry: 'https://j2.example/npm/', token: 't-j3' })
    expect(again.text.match(/_authToken/g)).toHaveLength(1)
    expect(again.text).toContain('t-j3')
    expect(again.replaced).toBe(true)
  })

  it('照机器级现在的样子：@j 与 @godcreator 共用一个 token，重写 @j 时 godcreator 那行必须还在', () => {
    const { text } = upsertSource(machineNpmrc, { scope: '@j', registry: J, token: 't-new' })
    expect(text).toContain('//git.example.com/api/packages/J/npm/:_authToken=t-new')
    expect(text).toContain('//git.example.com/api/packages/godcreator/npm/:_authToken=t-god')
    expect(text.match(/@j:registry/g)).toHaveLength(1)
  })

  it('空文件、结尾没有换行的文件都能写出合法文本', () => {
    expect(upsertSource('', { scope: '@z', registry: 'https://z.example/npm/' }).text).toBe(
      '@z:registry=https://z.example/npm/\n',
    )
    const noNewline = '@a:registry=https://a.example/npm/'
    expect(upsertSource(noNewline, { scope: '@b', registry: 'https://b.example/npm/' }).text).toBe(
      `${noNewline}\n@b:registry=https://b.example/npm/`,
    )
  })
})

describe('removeSource', () => {
  it('整组删掉：路由行和没人指向的 token 行，别的行不动', () => {
    const { text, removed, registry } = removeSource(machineNpmrc, '@j')
    expect(removed).toBe(true)
    expect(registry).toBe(J)
    expect(text).not.toContain('@j:registry')
    expect(text).not.toContain('//git.example.com/api/packages/J/npm/:_authToken')
    expect(text).toContain(`@godcreator:registry=${GODCREATOR}`)
    expect(text).toContain('//registry.npmjs.org/:_authToken=t-npm')
    expect(text).toContain('# 注释也在')
  })

  it('还有别的 scope 指向同一条源时 token 行不删——删 @godcreator 只删它的路由行和它自己地址的凭据', () => {
    // 真正「共用一行凭据」的情形是两个 scope 指向同一条源：@a 与 @b 都走 J 那条源
    const shared = [
      `@a:registry=${J}`,
      `@b:registry=${J}`,
      `//git.example.com/api/packages/J/npm/:_authToken=t-god`,
      `@godcreator:registry=${GODCREATOR}`,
      '//git.example.com/api/packages/godcreator/npm/:_authToken=t-god',
      '',
    ].join('\n')
    const dropped = removeSource(shared, '@a')
    expect(dropped.text).not.toContain('@a:registry')
    // @b 还指向 J 那条源，它的凭据行留下
    expect(dropped.text).toContain('//git.example.com/api/packages/J/npm/:_authToken=t-god')

    // 删 @godcreator：它自己地址的凭据行没人指向了，一起删掉；
    // @j 那行值相同的凭据是**另一行**（按源地址各自配对），不受影响
    const solo = removeSource(machineNpmrc, '@godcreator')
    expect(solo.text).not.toContain('@godcreator:registry')
    expect(solo.text).not.toContain('//git.example.com/api/packages/godcreator/npm/:_authToken')
    expect(solo.text).toContain('//git.example.com/api/packages/J/npm/:_authToken=t-god')
  })

  it('没有这条 scope：一个字节都不动，removed 是 false', () => {
    const { text, removed } = removeSource(machineNpmrc, '@nope')
    expect(removed).toBe(false)
    expect(text).toBe(machineNpmrc)
  })

  it('BOOTSTRAP_SCOPE 就是 @godcreator——命令拒绝改、删它靠这个常量', () => {
    expect(BOOTSTRAP_SCOPE).toBe('@godcreator')
  })
})
