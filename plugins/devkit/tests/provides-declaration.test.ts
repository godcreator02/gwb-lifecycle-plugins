import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { providesDeclarationProblems, servicesProvidedBySource, sourceTextUnder } from '../src/provides-declaration.js'

const PKG = '@godcreator/gwb-fake'
const EXPORTS = {
  '.': { types: './dist/index.d.ts', default: './dist/index.js' },
  './client': { types: './dist/client.d.ts', default: './dist/client.js' },
  './package.json': './package.json',
}
const DECLARED = { summary: '一句话', usage: '怎么用' }

function manifestOf(provides: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: PKG, keywords: ['gwb', 'gwb-plugin'], exports: EXPORTS, gwb: { provides }, ...extra }
}

describe('servicesProvidedBySource：三种写法', () => {
  it('super(ctx, 名)、ctx.provide(名)、new X(ctx, 名) 都认，单双引号与反引号都认', () => {
    const source = [
      "class A extends Service { constructor(ctx) { super(ctx, 'gwbA') } }",
      'ctx.effect(() => ctx.provide("gwbB", api))',
      'new GwbLogger(ctx, `gwbC`)',
    ].join('\n')
    expect([...servicesProvidedBySource(source)].sort()).toEqual(['gwbA', 'gwbB', 'gwbC'])
  })

  it('不是标识符的名字不算：注释里的示意写法不会被当成服务', () => {
    expect([...servicesProvidedBySource("/** 名字写在 super(ctx, '<名>') 或 super(ctx, \"…\") 里 */")]).toEqual([])
  })
})

describe('providesDeclarationProblems', () => {
  it('服务名键：源码提供的服务都声明了、summary 与 usage 非空，放行', () => {
    expect(providesDeclarationProblems(manifestOf({ gwbA: DECLARED }), "super(ctx, 'gwbA')")).toEqual([])
  })

  it('说明符键：包名与 包名/子路径 对得上 exports 的入口，放行；./package.json 不算入口', () => {
    expect(providesDeclarationProblems(manifestOf({ [PKG]: DECLARED, [`${PKG}/client`]: DECLARED }), '')).toEqual([])
    const packageJson = providesDeclarationProblems(manifestOf({ [`${PKG}/package.json`]: DECLARED }), '')
    expect(packageJson).toEqual([expect.stringContaining(`"${PKG}/package.json" 既不是源码提供的服务`)])
  })

  it('没有 exports 的旧式包：main 就是主入口，键写包名放行', () => {
    const manifest = { name: PKG, keywords: ['gwb'], main: 'dist/index.js', gwb: { provides: { [PKG]: DECLARED } } }
    expect(providesDeclarationProblems(manifest, '')).toEqual([])
  })

  it('多声明：键既不是源码提供的服务、也不是入口说明符，拒，并列出两边各有什么', () => {
    const problems = providesDeclarationProblems(manifestOf({ gwbA: DECLARED, gwbGone: DECLARED }), "super(ctx, 'gwbA')")
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('"gwbGone" 既不是源码提供的服务（源码提供的：gwbA）')
    expect(problems[0]).toContain(`有：${PKG}、${PKG}/client`)
    expect(problems[0]).toContain('删掉这一条')
  })

  it('少声明：源码提供的服务不在 gwb.provides 里，拒，说加一条什么；没写 gwb.provides 也一样', () => {
    const problems = providesDeclarationProblems(manifestOf({ gwbA: DECLARED }), "super(ctx, 'gwbA')\nctx.provide('gwbB', api)")
    expect(problems).toEqual([expect.stringContaining('源码提供服务 gwbB，gwb.provides 里没有它：加一条 "gwbB": { "summary"')])
    const noProvides = { name: PKG, keywords: ['gwb', 'gwb-plugin'], exports: EXPORTS }
    expect(providesDeclarationProblems(noProvides, "super(ctx, 'gwbA')")).toEqual([expect.stringContaining('源码提供服务 gwbA')])
  })

  it('summary 或 usage 为空、不是字符串、只有空白：逐项拒；整条不是对象也拒', () => {
    const problems = providesDeclarationProblems(
      manifestOf({ gwbA: { summary: '', usage: 3 }, gwbB: { summary: '有', usage: '  ' }, gwbC: 'x' }),
      "super(ctx, 'gwbA')\nsuper(ctx, 'gwbB')\nsuper(ctx, 'gwbC')",
    )
    expect(problems).toEqual([
      expect.stringContaining('"gwbA" 的 summary 是 ""'),
      expect.stringContaining('"gwbA" 的 usage 是 3'),
      expect.stringContaining('"gwbB" 的 usage 是 "  "'),
      expect.stringContaining('"gwbC" 是 "x"：改成 { "summary"'),
    ])
  })

  it('gwb.provides 不是对象：拒，说要写成什么', () => {
    expect(providesDeclarationProblems(manifestOf(['gwbA']), '')).toEqual([expect.stringContaining('gwb.provides 是 ["gwbA"]：改成对象')])
  })

  it('keywords 里既没有 gwb 也没有 gwb-plugin：不查', () => {
    expect(providesDeclarationProblems({ name: PKG, gwb: { provides: { nope: {} } } }, "super(ctx, 'gwbA')")).toEqual([])
  })
})

describe('本仓两个插件过 provides 检查', () => {
  const pluginsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  for (const short of ['devkit', 'plugin-manager']) {
    it(short, () => {
      const pkgDir = path.join(pluginsDir, short)
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
      expect(providesDeclarationProblems(manifest, sourceTextUnder(pkgDir))).toEqual([])
    })
  }
})
