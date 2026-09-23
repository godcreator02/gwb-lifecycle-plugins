import { describe, expect, it } from 'vitest'
import {
  assertId,
  assertIdUsable,
  assertPkgName,
  assertSpec,
  bareId,
  defaultIdFor,
  installSpec,
  isValidId,
  pickId,
  uniqueId,
} from '../src/ids.js'

describe('条目 id 的字符集', () => {
  it('kebab-case 才认', () => {
    for (const good of ['commands', 'py-cli', 'a1-b2', 'x']) {
      expect(isValidId(good), good).toBe(true)
    }
  })

  it('大写、下划线、空串、点段、冒号一律不认', () => {
    for (const bad of ['Commands', 'a_b', '', 'a--b', '-a', 'a-', '.', '..', 'a.b', 'home:x', 'a/b']) {
      expect(isValidId(bad), bad).toBe(false)
    }
  })

  it('不合规当场抛，错话里带出规矩', () => {
    expect(() => assertId('Commands')).toThrow(/kebab-case/)
  })

  it('和 gwb-data、gwb-settings 的校验是同一套——生成的 id 在那边要存得下数据', () => {
    // 那两个件按 id 的末段分区，字符集松了就等于发了一条谁也存不下东西的条目
    expect(isValidId('py-cli')).toBe(true)
    expect(isValidId('py_cli')).toBe(false)
  })
})

describe('完整 entryId → 裸 id', () => {
  it('只取末段——前缀 home: 是 loader 拼的，树上认的是末段', () => {
    expect(bareId('home:commands')).toBe('commands')
    expect(bareId('home:py-cli')).toBe('py-cli')
  })

  it('本来就是裸的照收', () => {
    expect(bareId('commands')).toBe('commands')
  })

  it('末段是空的当场抛', () => {
    expect(() => bareId('')).toThrow()
    expect(() => bareId('home:')).toThrow()
  })
})

describe('包名 → 默认 id', () => {
  it('去掉 scope 与 gwb- 前缀', () => {
    expect(defaultIdFor('@godcreator/gwb-py-cli')).toBe('py-cli')
    expect(defaultIdFor('@godcreator/gwb-commands')).toBe('commands')
    expect(defaultIdFor('@godcreator/gwb-plugin-manager')).toBe('plugin-manager')
  })

  it('没 scope 没前缀的原样', () => {
    expect(defaultIdFor('koishi-plugin-echo')).toBe('koishi-plugin-echo')
  })

  it('只去掉最外那层 gwb-，包名里第二个 gwb 留着', () => {
    expect(defaultIdFor('@x/gwb-gwb-tools')).toBe('gwb-tools')
  })

  it('大写与点号收进 kebab-case——它要当目录名和分区名用', () => {
    expect(defaultIdFor('@x/Foo.Bar')).toBe('foo-bar')
    expect(defaultIdFor('@x/a_b')).toBe('a-b')
  })

  it('一个字符都剩不下时给个兜底名，后面还有撞名那一层兜着', () => {
    expect(defaultIdFor('@x/gwb-')).toBe('plugin')
  })

  it('编出来的默认 id 自己必须过校验', () => {
    for (const pkg of ['@godcreator/gwb-py-cli', '@x/Foo.Bar', '@x/gwb-', 'a_b_c']) {
      expect(isValidId(defaultIdFor(pkg)), pkg).toBe(true)
    }
  })
})

describe('撞名加数字后缀', () => {
  it('没占就用本名', () => {
    expect(uniqueId('py-cli', new Set())).toBe('py-cli')
  })

  it('占了就 -2、-3 往下数', () => {
    expect(uniqueId('py-cli', new Set(['py-cli']))).toBe('py-cli-2')
    expect(uniqueId('py-cli', new Set(['py-cli', 'py-cli-2']))).toBe('py-cli-3')
  })

  it('中间空着的那个号补回去', () => {
    expect(uniqueId('py-cli', new Set(['py-cli', 'py-cli-3']))).toBe('py-cli-2')
  })

  it('编出来的照样过校验', () => {
    expect(isValidId(uniqueId('py-cli', new Set(['py-cli'])))).toBe(true)
  })
})

describe('选 id：连磁盘上的归属记录一起看', () => {
  const none = new Set<string>()

  it('盘上什么都没有：跟默认 id 一样', () => {
    expect(pickId('@a/gwb-foo', none, {})).toBe('foo')
  })

  it('scope 不同、默认 id 相同：前一个包卸载后数据留在磁盘上，后来的包不拿这个 id', () => {
    expect(pickId('@b/foo', none, { foo: ['@a/gwb-foo', '@a/gwb-foo'] })).toBe('foo-2')
  })

  it('数据与设置只要有一本归别人就算占着', () => {
    expect(pickId('@b/foo', none, { foo: ['@b/foo', '@a/gwb-foo'] })).toBe('foo-2')
  })

  it('本包装过又卸了：沿用自己的旧 id，数据与设置原样接上', () => {
    // @a 卸了之后 @b 占了 foo-2；@a 装回来还是 foo，不会被挤成 foo-3
    expect(pickId('@a/gwb-foo', new Set(['foo-2']), { foo: ['@a/gwb-foo'], 'foo-2': ['@b/foo'] })).toBe('foo')
  })

  it('本包留下的旧 id 不是默认那个也接回——比如当初手给的', () => {
    expect(pickId('@a/gwb-py-cli', none, { 'py-311': ['@a/gwb-py-cli'] })).toBe('py-311')
  })

  it('本包留下好几个：默认那个优先，其余按字典序', () => {
    expect(pickId('@a/gwb-foo', none, { 'foo-3': ['@a/gwb-foo'], foo: ['@a/gwb-foo'] })).toBe('foo')
    expect(pickId('@a/gwb-foo', new Set(['foo']), { 'foo-3': ['@a/gwb-foo'], 'foo-2': ['@a/gwb-foo'] })).toBe('foo-2')
  })

  it('条目树上正被占着的不沿用——那是同一个包正在用的另一条条目', () => {
    expect(pickId('@a/gwb-foo', new Set(['foo']), { foo: ['@a/gwb-foo'] })).toBe('foo-2')
  })

  it('编出来的照样过校验', () => {
    expect(isValidId(pickId('@b/foo', none, { foo: ['@a/foo'] }))).toBe(true)
  })
})

describe('手动给的 id', () => {
  it('条目树上已被占用：拒绝', () => {
    expect(() => assertIdUsable('foo', '@a/foo', new Set(['foo']), {})).toThrow(/被占/)
  })

  it('磁盘上属于别的包：拒绝，错误里写明属于谁与 transfer-owner', () => {
    expect(() => assertIdUsable('foo', '@b/foo', new Set(), { foo: ['@a/foo'] })).toThrow(/@a\/foo[\s\S]*transfer-owner/)
  })

  it('盘上归自己：放行', () => {
    expect(() => assertIdUsable('foo', '@a/foo', new Set(), { foo: ['@a/foo'] })).not.toThrow()
  })

  it('不合规：拒', () => {
    expect(() => assertIdUsable('Foo', '@a/foo', new Set(), {})).toThrow(/kebab-case/)
  })
})

describe('包名与版本范围', () => {
  it('裸名与 scope 名都认', () => {
    expect(() => assertPkgName('cordis')).not.toThrow()
    expect(() => assertPkgName('@godcreator/gwb-commands')).not.toThrow()
    expect(() => assertPkgName('a.b_c-d~e')).not.toThrow()
  })

  it('以 - 开头的包名不认——pnpm 会把它当成命令行选项', () => {
    expect(() => assertPkgName('--force')).toThrow()
    expect(() => assertPkgName('-r')).toThrow()
  })

  it('带空白、带路径、空串、大写一律不认', () => {
    for (const bad of ['a b', 'a/b/c', '', '../evil', 'Foo', '@scope']) {
      expect(() => assertPkgName(bad), bad).toThrow()
    }
  })

  it('版本范围松着收', () => {
    for (const good of ['^1.2.3', '0.0.3', 'latest', '>=0.0.1', 'workspace:*']) {
      expect(() => assertSpec(good), good).not.toThrow()
    }
  })

  it('空串、带空白、以 - 开头的范围不认', () => {
    // 带空格的复合范围（`>=1 <2`）也被这条挡了——认了这个代价：空白是开关注入的口子
    for (const bad of ['', ' ', '>=0.0.1 <1', '^1 --force', '-r']) {
      expect(() => assertSpec(bad), bad).toThrow()
    }
  })

  it('拼出 pnpm add 的参数', () => {
    expect(installSpec('@godcreator/gwb-commands')).toBe('@godcreator/gwb-commands')
    expect(installSpec('@godcreator/gwb-commands', '0.0.3')).toBe('@godcreator/gwb-commands@0.0.3')
  })

  it('坏名字拼不出参数', () => {
    expect(() => installSpec('--force')).toThrow()
    expect(() => installSpec('cordis', '-r')).toThrow()
  })
})
