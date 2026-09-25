import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'
import { contextServicesOf, maskSource, sourceWiringOf, typesEntryOf, WIRING_PAGE, wiringProblems, type WiringCheckIo } from '../src/wiring-check.js'

const REPO = path.resolve('D:/fake-repo')
const PKG = path.join(REPO, 'plugins', 'hello')
const SELF = '@godcreator/gwb-hello'
const COMMANDS = '@godcreator/gwb-commands'
const SHELL = '@godcreator/gwb-shell'
const SKILLS = '@godcreator/gwb-skills'
const TYPES_EXPORTS = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }

const augment = (...members: string[]): string => `declare module 'cordis' {\n  interface Context {\n${members.map((one) => `    ${one}\n`).join('')}  }\n}\n`

/** 包目录 node_modules 里装着的一个包：清单、类型入口、运行时入口（`provides` 是它 super(ctx, '<名>') 提供的服务） */
function installed(name: string, options: { plugin?: boolean; declares?: string[]; provides?: string[] } = {}): Record<string, string> {
  const dir = path.join(PKG, 'node_modules', ...name.split('/'))
  return {
    [path.join(dir, 'package.json')]: JSON.stringify({ name, keywords: options.plugin === false ? [] : ['gwb-plugin'], exports: TYPES_EXPORTS }),
    [path.join(dir, 'dist', 'index.d.ts')]: augment(...(options.declares ?? []).map((one) => `${one}: unknown`)),
    [path.join(dir, 'dist', 'index.js')]: (options.provides ?? []).map((one) => `class S extends Service { constructor(ctx) { super(ctx, '${one}') } }\n`).join(''),
  }
}

function ioOf(files: Record<string, string>, workspace: string[] = []): WiringCheckIo {
  return {
    readText: (file) => files[path.resolve(file)],
    filesUnder: (dir) =>
      Object.keys(files).filter((file) => file.startsWith(path.resolve(dir) + path.sep) && !path.relative(dir, file).split(path.sep).includes('node_modules')),
    workspacePackageDirs: () => workspace,
  }
}

function manifestOf(extra: Record<string, unknown>): Record<string, unknown> & { name: string } {
  return { name: SELF, version: '0.1.0', keywords: ['gwb-plugin'], ...extra }
}

const page = (text: string): Record<string, string> => ({ [path.join(REPO, ...WIRING_PAGE.split('/'))]: text })
const source = (text: string, rel = 'src/index.ts'): Record<string, string> => ({ [path.join(PKG, ...rel.split('/'))]: text })

describe('maskSource：注释、字符串、模板、正则里的内容不算代码', () => {
  it('注释与字符串里的 inject 被遮掉，字符串的值按左引号的位置记下', () => {
    const text = "// inject\nconst a = 'inject' /* inject */ + \"b\"\n"
    const masked = maskSource(text)
    expect(masked.code).not.toContain('inject')
    expect(masked.code.length).toBe(text.length)
    expect(masked.literals.get(text.indexOf("'"))?.value).toBe('inject')
    expect(masked.literals.get(text.indexOf('"'))?.value).toBe('b')
  })

  it('模板字面量的文本遮掉、${…} 里照代码扫；正则字面量遮掉，除号不当正则', () => {
    const masked = maskSource('const t = `inject ${ctx.inject(["x"], f)} inject`\nconst r = /inject/g\nconst d = a / b / c\n')
    expect(masked.code.match(/inject/g)).toHaveLength(1)
    expect(masked.code).toContain('a / b / c')
  })

  it('字符串到换行就截断：JSX 文本里的撇号只影响那一行', () => {
    const masked = maskSource("const v = <p>don't</p>\nctx.inject(['gwbShell'], fn)\n")
    expect(masked.code).toContain('ctx.inject(')
  })
})

describe('sourceWiringOf：三种注入写法与提供', () => {
  it('export const inject、static inject 是必需，.inject([...], fn) 是局部注入，行号从 1 数', () => {
    const got = sourceWiringOf(
      [
        "export const inject = ['gwbCommands', \"gwbShell\",]",
        'class X extends Service {',
        "  static inject = ['gwbData']",
        "  constructor(ctx: Context) { super(ctx, 'gwbExample') }",
        '}',
        "this.ctx.inject(['gwbSkills'], (scoped) => {})",
        "ctx.effect(() => ctx.provide('gwbPresence', {}))",
      ].join('\n'),
    )
    expect(got.injects).toEqual([
      { service: 'gwbCommands', required: true, line: 1 },
      { service: 'gwbShell', required: true, line: 1 },
      { service: 'gwbData', required: true, line: 3 },
      { service: 'gwbSkills', required: false, line: 6 },
    ])
    expect(got.provides.sort()).toEqual(['gwbExample', 'gwbPresence'])
    expect(got.unreadable).toEqual([])
  })

  it('带类型标注与 as const 的 export const inject 照样认', () => {
    expect(sourceWiringOf("export const inject: readonly string[] = ['gwbCommands'] as const").injects).toEqual([{ service: 'gwbCommands', required: true, line: 1 }])
  })

  it('.inject 带类型参数照样认', () => {
    const got = sourceWiringOf("ctx.inject<{ gwbShell: Pick<GwbShellApi, 'registerPane'>; f: () => void }>(['gwbShell'], (scoped) => {})")
    expect(got.injects).toEqual([{ service: 'gwbShell', required: false, line: 1 }])
    expect(got.unreadable).toEqual([])
  })

  it('像注入又读不出服务名的逐处报：变量参数、对象形式、拼出来的数组、叫 inject 的变量、对象字面量里值是数组的 inject 键、不经 . 直接调用', () => {
    const got = sourceWiringOf(
      [
        'ctx.inject(deps, fn)',
        'export const inject = { gwbCommands: { required: true } }',
        "ctx.inject(['a', ...more], fn)",
        "const inject = ['gwbData']",
        "ctx.plugin({ inject: ['gwbData'], apply })",
        "inject(['gwbData'], fn)",
      ].join('\n'),
    )
    expect(got.unreadable.map((one) => one.line)).toEqual([1, 2, 3, 4, 5, 6])
    expect(got.unreadable[0]!.text).toBe('ctx.inject(deps, fn)')
    expect(got.injects).toEqual([])
  })

  it('不是注入的不管：属性读取、类型里的 inject 成员与方法声明', () => {
    const got = sourceWiringOf(
      [
        'const missing = (plugin.inject ?? []).filter(isMissing)',
        'interface Host { inject?: readonly string[]; inject<T>(deps: readonly string[], fn: (scoped: T) => void): void }',
        'type H = { inject: (deps: string[], fn: () => void) => void }',
      ].join('\n'),
    )
    expect(got).toEqual({ injects: [], provides: [], unreadable: [] })
  })

  it('super 与 provide 的名字不是字面量的不算提供，也不报：继承 Error 的 super(message)、别的库的 provide 方法', () => {
    const got = sourceWiringOf(
      'class E extends Error { constructor(m: string) { super(m) } }\nclass S extends Service { constructor(c: Context) { super(c, NAME) } }\nregistration.provide({ block })\nroot.provide(name, fake)',
    )
    expect(got).toEqual({ injects: [], provides: [], unreadable: [] })
  })
})

describe('contextServicesOf 与 typesEntryOf', () => {
  it('只收 declare module \'cordis\' 里 interface Context 最外一层的属性名；方法、嵌套对象的键、别的模块不算', () => {
    const dts = [
      "declare module 'cordis' {",
      '  interface Context {',
      '    /** 说明里写 { fake: 1 } 也不算 */',
      '    gwbShell: GwbShellApi;',
      '    readonly gwbData?: { nested: string };',
      '    method(): void',
      '  }',
      '}',
      "declare module 'other' { interface Context { notCordis: 1 } }",
    ].join('\n')
    expect(contextServicesOf(dts).sort()).toEqual(['gwbData', 'gwbShell'])
  })

  it('类型入口：exports["."] 的 types 条件优先，没有 exports 时取 types / typings', () => {
    expect(typesEntryOf({ exports: TYPES_EXPORTS })).toBe('./dist/index.d.ts')
    expect(typesEntryOf({ exports: { '.': { import: { types: './a.d.ts', default: './a.js' } } } })).toBe('./a.d.ts')
    expect(typesEntryOf({ types: 'index.d.ts' })).toBe('index.d.ts')
    expect(typesEntryOf({ exports: { '.': './dist/index.js' } })).toBeUndefined()
  })
})

describe('wiringProblems：注入与 peer 一致', () => {
  const peers = { [KERNEL_PACKAGE]: '^0.7.0', [COMMANDS]: '^0.5.0', [SHELL]: '^0.14.0', [SKILLS]: '^0.4.5' }
  const optional = { [SHELL]: { optional: true }, [SKILLS]: { optional: true } }
  const installedAll = {
    ...installed(COMMANDS, { declares: ['gwbCommands'], provides: ['gwbCommands'] }),
    // 外壳按真类型再声明 gwbCommands，运行时只提供 gwbShell：不算 gwbCommands 的提供方
    ...installed(SHELL, { declares: ['gwbShell', 'gwbCommands'], provides: ['gwbShell'] }),
    ...installed(SKILLS, { declares: ['gwbSkills'], provides: ['gwbSkills'] }),
  }
  const wiringPage = page('gwbCommands gwbShell gwbSkills gwbPluginManager')

  it('devkit 的写法：必需注入命令总线写普通 peer，局部注入的写可选 peer；gwbKernel 不查；干净', () => {
    const files = {
      ...installedAll,
      ...wiringPage,
      ...source("export const inject = ['gwbCommands']\nctx.inject(['gwbShell'], f)\nctx.inject(['gwbSkills'], f)\nctx.inject(['gwbKernel'], f)\n"),
    }
    expect(wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({ peerDependencies: peers, peerDependenciesMeta: optional }) }, ioOf(files))).toEqual([])
  })

  it('局部注入、peer 写成必需也放行（缺了它本插件一样功能都没有时的写法）；自己提供的服务不找提供方', () => {
    const files = {
      ...installedAll,
      ...wiringPage,
      ...source("ctx.effect(() => ctx.provide('gwbPluginManager', {}))\nthis.ctx.inject(['gwbCommands'], f)\n"),
    }
    expect(wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({ peerDependencies: peers }) }, ioOf(files))).toEqual([])
  })

  it('提供方只写在 dev：必需的说写普通 peer，局部的说标 optional', () => {
    const files = { ...installedAll, ...wiringPage, ...source("export const inject = ['gwbCommands']\nctx.inject(['gwbShell'], f)\n") }
    const got = wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({ peerDependencies: { [KERNEL_PACKAGE]: '^0.7.0' }, devDependencies: { [COMMANDS]: '^0.5.0', [SHELL]: '^0.14.0' } }) }, ioOf(files))
    expect(got).toEqual([
      'gwbCommands（src/index.ts:1，必需注入） 由 @godcreator/gwb-commands 提供，它不在 peerDependencies 里：写进 peer（范围 ^x.y.z），dev 里那一条删掉',
      'gwbShell（src/index.ts:2，局部注入） 由 @godcreator/gwb-shell 提供，它不在 peerDependencies 里：写进 peer（范围 ^x.y.z，在 peerDependenciesMeta 里标 optional: true），dev 里那一条删掉',
    ])
  })

  it('必需注入的提供方标了 optional：拒', () => {
    const files = { ...installedAll, ...wiringPage, ...source("export const inject = ['gwbShell']\n") }
    const got = wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({ peerDependencies: peers, peerDependenciesMeta: optional }) }, ioOf(files))
    expect(got).toEqual([expect.stringContaining('的提供方 @godcreator/gwb-shell 在 peerDependenciesMeta 里标了 optional')])
  })

  it('peer 与 dev 里都没有提供方：拒，说写进 peer；一处必需就按必需报', () => {
    const files = { ...wiringPage, ...source("ctx.inject(['gwbSettings'], f)\n"), ...source("export const inject = ['gwbSettings']\n", 'src/other.ts') }
    const got = wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({ peerDependencies: { [KERNEL_PACKAGE]: '^0.7.0' } }) }, ioOf({ ...files, ...page('gwbSettings') }))
    expect(got).toEqual([expect.stringContaining('gwbSettings（src/index.ts:1、src/other.ts:1，必需注入）：peer 与 dev 里没有哪个包的类型入口')])
    expect(got[0]).toContain('必需注入写普通 peer')
  })

  it('两个声明方运行时都不提供（或都提供）：判不出由谁提供，拒', () => {
    const files = {
      ...installed(COMMANDS, { declares: ['gwbCommands'] }),
      ...installed('@someone/gwb-fork', { declares: ['gwbCommands'] }),
      ...wiringPage,
      ...source("export const inject = ['gwbCommands']\n"),
    }
    const got = wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({ peerDependencies: { [COMMANDS]: '^0.5.0', '@someone/gwb-fork': '^1.0.0' } }) }, ioOf(files))
    expect(got).toEqual([expect.stringContaining('有 2 个插件的类型入口都给 cordis 的 Context 补了这个名字（@godcreator/gwb-commands、@someone/gwb-fork）')])
  })

  it('提供方不是 gwb 插件（cordis 官方插件）：不查', () => {
    const files = { ...installed('@cordisjs/plugin-timer', { plugin: false, declares: ['timer'] }), ...page('timer'), ...source("export const inject = ['timer']\n") }
    expect(wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({ devDependencies: { '@cordisjs/plugin-timer': '1.1.3' } }) }, ioOf(files))).toEqual([])
  })

  it('局部注入、提供方是同工作区里 peer 写了本包的插件（写 peer 会成环）：放行；必需注入不放行', () => {
    const skillsDir = path.join(REPO, 'plugins', 'skills')
    const sibling = {
      [path.join(skillsDir, 'package.json')]: JSON.stringify({ name: SKILLS, keywords: ['gwb-plugin'], exports: TYPES_EXPORTS, peerDependencies: { [SELF]: 'workspace:^' } }),
      [path.join(skillsDir, 'dist', 'index.d.ts')]: augment('gwbSkills: GwbSkills'),
    }
    const local = { ...sibling, ...page('gwbSkills'), ...source("this.ctx.inject(['gwbSkills'], f)\n") }
    expect(wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({}) }, ioOf(local, [PKG, skillsDir]))).toEqual([])
    const required = { ...sibling, ...page('gwbSkills'), ...source("export const inject = ['gwbSkills']\n") }
    expect(wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({}) }, ioOf(required, [PKG, skillsDir]))).toHaveLength(1)
  })

  it('认不出的写法报出文件与行号', () => {
    const files = { ...wiringPage, ...source('\nctx.inject(deps, fn)\n', 'src/node/index.ts') }
    const got = wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({}) }, ioOf(files))
    expect(got).toEqual([expect.stringContaining('src/node/index.ts:2 认不出的注入或提供写法：ctx.inject(deps, fn)')])
  })

  it('.d.ts 与 src 以外的文件不扫', () => {
    const files = { ...wiringPage, ...source("declare const inject: string\n", 'src/types.d.ts'), [path.join(PKG, 'tests', 'x.test.ts')]: 'ctx.inject(deps, fn)\n' }
    expect(wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({}) }, ioOf(files))).toEqual([])
  })
})

describe('wiringProblems：wiring 页写全', () => {
  it('仓里没有 wiring 页：拒，写明路径', () => {
    const got = wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest: manifestOf({}) }, ioOf({}))
    expect(got).toEqual([expect.stringContaining(`仓里没有「插件之间怎么连」页 ${WIRING_PAGE}`)])
  })

  it('注入与提供的服务名按整词出现在页里；gwbKernel 不要求；缺的一次列全', () => {
    const files = {
      ...installed(COMMANDS, { declares: ['gwbCommands'] }),
      ...source("export const inject = ['gwbCommands']\nctx.inject(['gwbKernel'], f)\nctx.provide('gwbHello', {})\n"),
    }
    const manifest = manifestOf({ peerDependencies: { [COMMANDS]: '^0.5.0' } })
    expect(wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest }, ioOf({ ...files, ...page('| gwbCommands | gwbHello |') }))).toEqual([])
    const got = wiringProblems({ pkgDir: PKG, repoDir: REPO, manifest }, ioOf({ ...files, ...page('gwbCommandsX') }))
    expect(got).toEqual([expect.stringContaining('没写到 gwbCommands、gwbHello')])
  })
})
