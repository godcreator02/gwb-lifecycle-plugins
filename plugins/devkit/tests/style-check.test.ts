import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tailwindOf } from '../src/node-dev-deps.js'
import {
  classSelectors,
  declaredColorNames,
  literalFallbacks,
  literals,
  paletteColorSelectors,
  styleEntryOf,
  styleProblems,
  type StyleCheckIo,
  type TailwindCompile,
} from '../src/style-check.js'

const PKG = path.resolve('/fake-pkg')
const NAME = '@godcreator/gwb-fake'
const ENTRY = "@import 'tailwindcss/theme.css' theme(reference) prefix(fk);\n@import '@godcreator/gwb-shell/theme.reference.css' theme(reference);\n"

/** 假 Tailwind：认得的工具类编得出规则；入口写了 prefix(x) 时只认 `x:` 开头的，变体只认排在前缀后面的 hover: */
const UTILITIES = new Set(['flex', 'p-2', 'bg-primary', 'text-sm'])
function fakeCompile(compiled: string[] = [], utilities: ReadonlySet<string> = UTILITIES): TailwindCompile {
  return async (css, base) => {
    compiled.push(`${base} ${css.includes('prefix(') ? '带前缀' : '去掉前缀'}`)
    const prefix = /prefix\(([a-z]+)\)/.exec(css)?.[1]
    const kept = new Set<string>()
    const compiles = (token: string): boolean => {
      let rest = token
      if (prefix !== undefined) {
        if (!rest.startsWith(`${prefix}:`)) return false
        rest = rest.slice(prefix.length + 1)
      }
      if (rest.startsWith('hover:')) rest = rest.slice('hover:'.length)
      return utilities.has(rest)
    }
    return {
      build(candidates) {
        for (const token of candidates) if (compiles(token)) kept.add(token)
        return [...kept].sort().join('\n')
      },
    }
  }
}

const SHELL_FILES = {
  'node_modules/@godcreator/gwb-shell/package.json': JSON.stringify({ name: '@godcreator/gwb-shell', exports: { './theme.reference.css': './dist/theme.reference.css' } }),
  'node_modules/@godcreator/gwb-shell/dist/theme.reference.css': '@theme inline {\n  --color-background: var(--background);\n  --color-primary: var(--primary);\n}\n',
}

/** 假文件表：键相对包目录 */
function io(files: Record<string, string>, tailwind: Awaited<ReturnType<StyleCheckIo['tailwindOf']>> = { ok: true, compile: fakeCompile() }, pkgDir = PKG): StyleCheckIo & { asked: string[] } {
  const table = new Map(Object.entries(files).map(([rel, text]) => [path.resolve(pkgDir, rel), text]))
  const asked: string[] = []
  return {
    asked,
    readText: (file) => table.get(path.resolve(file)),
    filesUnder: (dir) => [...table.keys()].filter((file) => file.startsWith(path.resolve(dir) + path.sep)),
    async tailwindOf(pkgDir) {
      asked.push(pkgDir)
      return tailwind
    },
  }
}

/** 一个各项都过的插件：样式入口、tsx、外壳、产物 */
function cleanPlugin(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'src/client/styles.css': ENTRY,
    'src/client/App.tsx': 'export const App = () => <div className="fk:flex fk:hover:bg-primary">{`fk:p-2 ${x}`}</div>',
    'dist/style.css': '.fk\\:flex{display:flex}@media (hover:hover){.fk\\:hover\\:bg-primary:hover{background-color:var(--primary)}}.fk\\:p-2{padding:calc(var(--gwb-spacing)*2)}.dark .fk\\:text-sm{font-size:var(--gwb-text-sm)}',
    ...SHELL_FILES,
    ...extra,
  }
}

const PLUGIN = { name: NAME, plugin: true }

describe('styleProblems：什么时候查', () => {
  it('各项都过：没有问题；两次编译都以样式入口所在目录为 base', async () => {
    const compiled: string[] = []
    const files = io(cleanPlugin(), { ok: true, compile: fakeCompile(compiled) })
    expect(await styleProblems(PKG, PLUGIN, files)).toEqual([])
    const base = path.resolve(PKG, 'src/client')
    expect(compiled).toEqual([`${base} 带前缀`, `${base} 去掉前缀`])
  })

  it('不是插件包、没有 dist/style.css：不查，也不找 Tailwind', async () => {
    const notPlugin = io(cleanPlugin({ 'dist/style.css': '.stray{}' }))
    expect(await styleProblems(PKG, { name: NAME, plugin: false }, notPlugin)).toEqual([])
    const { 'dist/style.css': _unused, ...withoutArtifact } = cleanPlugin()
    const noArtifact = io(withoutArtifact)
    expect(await styleProblems(PKG, PLUGIN, noArtifact)).toEqual([])
    expect([...notPlugin.asked, ...noArtifact.asked]).toEqual([])
  })

  it('Tailwind 找不到：原样报出原因，不跳过', async () => {
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin(), { ok: false, error: '包目录 node_modules 里没有 @tailwindcss/cli' }))
    expect(got).toEqual(['包目录 node_modules 里没有 @tailwindcss/cli'])
  })

  it('编译抛错：报出是哪个入口、哪一次编译', async () => {
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin(), { ok: true, compile: async () => { throw new Error("Can't resolve 'tw-animate-css'") } }))
    expect(got).toEqual([expect.stringMatching(/^样式入口 src\/client\/styles\.css 编译不了：Can't resolve 'tw-animate-css'$/)])
  })
})

describe('styleEntryOf：src/ 下唯一一个写了 prefix(<名>) 的 css', () => {
  it('注释里的 prefix(…) 不算；找到入口与前缀', () => {
    const got = styleEntryOf(PKG, io({ 'src/client/other.css': '/* 例：prefix(nope) */ .a{}', 'src/client/styles.css': `/* prefix(fk) 写在下一行 */\n${ENTRY}` }))
    expect(got).toMatchObject({ ok: true, entry: { file: path.resolve(PKG, 'src/client/styles.css'), prefix: 'fk' } })
  })

  it('一个都没有、有两个、一个文件里写了两处、前缀不是纯小写字母：各自报清', () => {
    expect(styleEntryOf(PKG, io({ 'src/a.css': '.a{}' }))).toMatchObject({ ok: false, error: expect.stringContaining('src/ 下找不到写了 prefix(<前缀>) 的 css 文件') })
    expect(styleEntryOf(PKG, io({ 'src/a.css': ENTRY, 'src/b/c.css': ENTRY }))).toMatchObject({ ok: false, error: expect.stringContaining('有 2 个 css 文件写了 prefix(…)（src/a.css、src/b/c.css）') })
    expect(styleEntryOf(PKG, io({ 'src/a.css': `${ENTRY}@import 'x.css' prefix(fk);` }))).toMatchObject({ ok: false, error: expect.stringContaining('写了 2 处 prefix(…)') })
    expect(styleEntryOf(PKG, io({ 'src/a.css': "@import 'tailwindcss/theme.css' prefix(my-ui);" }))).toMatchObject({ ok: false, error: expect.stringContaining('只收 a-z') })
  })

  it('styleProblems 里入口找不到就只报这一条', async () => {
    const got = await styleProblems(PKG, PLUGIN, io({ 'dist/style.css': '.x{}', ...SHELL_FILES }))
    expect(got).toEqual([expect.stringContaining('找不到写了 prefix(<前缀>) 的 css 文件')])
  })
})

describe('产物 dist/style.css', () => {
  it('a. 类选择器都带前缀：别的前缀、没前缀的报，.dark 放行；声明值里的小数、@media 里嵌的规则都认得对', async () => {
    const css = '.dark .fk\\:a{margin:.25rem}@media (hover:hover){.stray:hover{}}.other\\:flex{}/* .in-comment{} */'
    expect(classSelectors(css).sort()).toEqual(['.dark', '.fk\\:a', '.other\\:flex', '.stray'])
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin({ 'dist/style.css': css })))
    expect(got).toEqual([expect.stringContaining('有 2 个类选择器不带 fk: 前缀：.other\\:flex、.stray')])
  })

  it('b. 出现 data-gwb-plugin：报', async () => {
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin({ 'dist/style.css': '[data-gwb-plugin="x"] .fk\\:flex{}' })))
    expect(got).toEqual([expect.stringContaining('出现了 data-gwb-plugin')])
  })

  it('c. var() 的 fallback 写死了值：报；只由 var() 组成（含 var() 列表）、currentcolor、空、tw-animate-css 自带的、@property/@supports 里的放行', async () => {
    const css = [
      '.fk\\:a{padding:var(--gwb-spacing, 0.25rem);color:var(--x,var(--y));border-color:var(--z,currentcolor);gap:var(--g,)}',
      '.fk\\:from-primary{--tw-gradient-stops:var(--tw-gradient-via-stops, var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position))}',
      '.fk\\:b{animation-duration:var(--tw-duration,.15s)}',
      '@property --tw-foo{syntax:"*";initial-value:var(--q, 1px)}',
      '@supports (color:red){.fk\\:c{width:var(--w, 2px)}}',
    ].join('')
    expect(literalFallbacks(css)).toEqual(['var(--gwb-spacing, 0.25rem)'])
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin({ 'dist/style.css': css })))
    expect(got).toEqual([expect.stringContaining('1 处 var() 的 fallback 写死了值：var(--gwb-spacing, 0.25rem)')])
  })

  it('d. 颜色类只用主题令牌：外壳 theme.reference.css、样式入口、产物里（含带前缀改写的）声明的色名放行，出厂调色板报', async () => {
    const entry = `${ENTRY}@theme { --color-src-plugin: var(--fk-src-plugin); }`
    const css = [
      '.fk\\:bg-primary{background-color:var(--primary)}.fk\\:text-background{color:var(--background)}.fk\\:border-transparent{border-color:transparent}',
      '.fk\\:bg-src-plugin{background-color:var(--fk-color-src-plugin)}.fk\\:bg-brand{background-color:var(--fk-color-brand)}:root{--fk-color-brand:#123}',
      '.fk\\:text-sm{font-size:var(--gwb-text-sm)}.fk\\:border-t{border-top-width:1px}.fk\\:border-dashed{border-style:dashed}.fk\\:text-center{text-align:center}',
      '.fk\\:bg-blue-500{background-color:var(--fk-color-blue-500)}@media (hover:hover){.fk\\:hover\\:text-red-600:hover{color:var(--fk-color-red-600)}}',
    ].join('')
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin({ 'src/client/styles.css': entry, 'dist/style.css': css })))
    expect(got).toEqual([expect.stringContaining('有 2 个颜色类用了主题令牌之外的色名：.fk\\:bg-blue-500、.fk\\:hover\\:text-red-600')])
  })

  it('d. 包目录 node_modules 里没装外壳：报出来，其余检查照做', async () => {
    const files = cleanPlugin({ 'dist/style.css': '.stray{}' })
    for (const key of Object.keys(SHELL_FILES)) delete files[key]
    const got = await styleProblems(PKG, PLUGIN, io(files))
    expect(got).toEqual([expect.stringContaining('不带 fk: 前缀'), expect.stringContaining('包目录 node_modules 里没装外壳 @godcreator/gwb-shell')])
  })

  it('d. 外壳自己就是被检查的包：从包目录读它自己的 theme.reference.css', async () => {
    const files = cleanPlugin({
      'package.json': JSON.stringify({ name: '@godcreator/gwb-shell', exports: { './theme.reference.css': './dist/theme.reference.css' } }),
      'dist/theme.reference.css': '@theme inline { --color-primary: var(--primary); }',
    })
    for (const key of Object.keys(SHELL_FILES)) delete files[key]
    expect(await styleProblems(PKG, { name: '@godcreator/gwb-shell', plugin: true }, io(files))).toEqual([])
  })

  it('declaredColorNames 与 paletteColorSelectors', () => {
    expect(declaredColorNames('--color-a: x; --fk-color-b: y; /* --color-c: z */')).toEqual(['a'])
    expect(declaredColorNames('--color-a: x; --fk-color-b: y;', 'fk')).toEqual(['a', 'b'])
    const css = [
      '.fk\\:bg-a\\/50{background-color:color-mix(in oklab,var(--fk-color-a) 50%,transparent)}',
      '.fk\\:bg-z{background-color:var(--color-z)}',
      '.dark .fk\\:dark\\:text-y{color:var(--fk-color-y)}',
      '.fk\\:text-q\\/50{color:var(--q);@supports (color:color-mix(in lab,red,red)){color:color-mix(in oklab,var(--fk-color-q) 50%,transparent)}}',
      '.fk\\:border-dotted{border-style:dotted}',
    ].join('')
    expect(paletteColorSelectors(css, 'fk', new Set(['a']))).toEqual(['.fk\\:bg-z', '.fk\\:dark\\:text-y', '.fk\\:text-q\\/50'])
  })
})

describe('产物里的 @scope：第三方 css 放进根带前缀的 @scope', () => {
  const KATEX = '.katex{font:1.21em KaTeX_Main}.katex .mfrac>span{text-align:center}'

  it('根带前缀的 @scope 里不带前缀的类放行：压缩后的 @scope(…)、带 to (…) 界限（界限不要求前缀）、嵌在 @media 里的都认得；@font-face 不误报', async () => {
    const css = [
      '.fk\\:flex{display:flex}',
      '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2")}',
      `@scope(.fk\\:render-root) to (.katex-html .hole){${KATEX}}`,
      `@scope (div.fk\\:math) {${KATEX}}`,
      `@media (min-width:10px){@scope(.fk\\:render-root){.katex-display{margin:1em 0}}}`,
    ].join('')
    expect(await styleProblems(PKG, PLUGIN, io(cleanPlugin({ 'dist/style.css': css })))).toEqual([])
  })

  it('根选择器没有带前缀的类：报，写明要求与写法；没写根的、选择器列表里有一项不带前缀的也报', async () => {
    const css = [`@scope (.katex){${KATEX}}`, `@scope{.katex{}}`, `@scope (.fk\\:a, .other){.katex{}}`, `@scope (.fk\\:ok){.katex{}}`].join('')
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin({ 'dist/style.css': css })))
    expect(got).toEqual([expect.stringContaining('有 3 个 @scope 的根选择器没有 .fk\\: 开头的类：@scope、@scope (.fk\\:a, .other)、@scope (.katex)')])
    expect(got[0]).toContain('@scope (.fk\\:<名>) { … }')
  })

  it('块内照样查：写死的 fallback、data-gwb-plugin、主题令牌之外的颜色类', async () => {
    const css = '@scope (.fk\\:render-root){.katex{padding:var(--gwb-spacing, 2px)}[data-gwb-plugin] .katex{}.fk\\:bg-blue-500{background-color:var(--fk-color-blue-500)}}'
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin({ 'dist/style.css': css })))
    expect(got).toEqual([
      expect.stringContaining('出现了 data-gwb-plugin'),
      expect.stringContaining('1 处 var() 的 fallback 写死了值：var(--gwb-spacing, 2px)'),
      expect.stringContaining('有 1 个颜色类用了主题令牌之外的色名：.fk\\:bg-blue-500'),
    ])
  })

  it('块外不带前缀的照样报，只报块外那几个；报错里写明第三方 css 可以放进 @scope', async () => {
    const css = `.stray{}@scope (.fk\\:render-root){${KATEX}}.katex-after{}@media (hover:hover){@scope (.fk\\:render-root){.katex{}}.loose:hover{}}`
    const got = await styleProblems(PKG, PLUGIN, io(cleanPlugin({ 'dist/style.css': css })))
    expect(got).toEqual([expect.stringContaining('有 3 个类选择器不带 fk: 前缀：.katex-after、.loose、.stray')])
    expect(got[0]).toContain('@scope (.fk\\:<名>)')
  })

  it('源码里只当 @scope 根或界限用的前缀类编不出规则也不报；别的编不出的照报', async () => {
    const files = cleanPlugin({
      'src/client/App.tsx': 'export const App = () => <div className="fk:flex fk:render-root"><i className="fk:hole fk:nope" /></div>',
      'dist/style.css': `.fk\\:flex{display:flex}@scope(.fk\\:render-root) to (.fk\\:hole){${KATEX}}`,
    })
    expect(await styleProblems(PKG, PLUGIN, io(files))).toEqual([
      'fk:nope（src/client/App.tsx）：带 fk: 前缀却编不出规则——工具类或变体名拼错了，或有变体排在了前缀前面；不是类名的字符串别用 fk: 开头',
    ])
  })
})

describe('源码里的类名', () => {
  it('literals：注释里的引号不算，转义的引号不断开，模板串的插值换成空白', () => {
    const source = "// it's a comment\n/* `not` */ const a = 'x\\'y'; const b = `p ${q} r`; const c = \"z\""
    expect(literals(source)).toEqual(["x\\'y", 'p   r', 'z'])
  })

  it('e. 前缀排在变体后面、带前缀编不出规则、漏了前缀：各报一条，写明在哪个文件、怎么改', async () => {
    const got = await styleProblems(
      PKG,
      PLUGIN,
      io(
        cleanPlugin({
          'src/client/App.tsx': 'export const App = () => <div className="fk:flex hover:fk:p-2 fk:flx">{"flex"}</div>',
          'src/client/deep/Row.tsx': "const k = 'flex import-me'",
          'src/other/Outside.tsx': "const k = 'p-2'",
        }),
      ),
    )
    expect(got).toEqual([
      'hover:fk:p-2（src/client/App.tsx）：前缀要排在最前，写成 fk:hover:p-2——前缀排在变体后面 Tailwind 不报错，只是一条规则都不出',
      'fk:flx（src/client/App.tsx）：带 fk: 前缀却编不出规则——工具类或变体名拼错了，或有变体排在了前缀前面；不是类名的字符串别用 fk: 开头',
      'flex（src/client/App.tsx、src/client/deep/Row.tsx）：漏了 fk: 前缀，写成 fk:flex——不带前缀的类名一条规则都不出，页面上那一处没样式也不报错',
    ])
  })

  it('标记类 group / peer（带不带 /<名>）自己不出规则也不报；变体名 outline 不查漏没漏前缀', async () => {
    const files = cleanPlugin({
      'src/client/App.tsx': 'export const App = () => <Button variant="outline" className="fk:group fk:group/row fk:peer fk:peer/switch fk:flex" />',
    })
    const compile = fakeCompile([], new Set([...UTILITIES, 'outline']))
    expect(await styleProblems(PKG, PLUGIN, io(files, { ok: true, compile }))).toEqual([])
  })

  it('样式入口所在目录下一个 .tsx 都没有：报，不找 Tailwind', async () => {
    const files = cleanPlugin()
    delete files['src/client/App.tsx']
    const checked = io(files)
    expect(await styleProblems(PKG, PLUGIN, checked)).toEqual([expect.stringContaining('所在目录下一个 .tsx 都没有')])
    expect(checked.asked).toEqual([])
  })
})

/**
 * 用真实的 Tailwind 4 编：devkit 的 dev 里装了 @tailwindcss/cli、tailwindcss 与外壳，编译器照发版时的找法（tailwindOf）从 devkit 包目录找。
 * 文件表仍是假的，只把包目录放在 devkit 自己下面，入口里的 @import 才能从 src/ 往上解析到 node_modules
 */
describe('用真实 Tailwind 编出来的产物与源码', () => {
  const DEVKIT = path.resolve(import.meta.dirname, '..')
  const REAL_ENTRY = `${ENTRY}@import 'tailwindcss/utilities.css' layer(utilities) source(none);\n`
  const SHELL_THEME = path.join(DEVKIT, 'node_modules/@godcreator/gwb-shell/dist/theme.reference.css')

  async function realCompile(): Promise<TailwindCompile> {
    const found = await tailwindOf(DEVKIT)
    if (!found.ok) throw new Error(found.error)
    return found.compile
  }

  /** 源码里写这些类、产物由同一份入口编出来：两层看到的是同一套工具类 */
  async function realPlugin(entry: string, tokens: string[]): Promise<{ files: Record<string, string>; compile: TailwindCompile }> {
    const compile = await realCompile()
    const artifact = (await compile(entry, path.join(DEVKIT, 'src'))).build(tokens)
    const files = {
      'src/styles.css': entry,
      'src/App.tsx': `export const App = () => <div className="${tokens.join(' ')}" />`,
      'dist/style.css': artifact,
      'node_modules/@godcreator/gwb-shell/package.json': fs.readFileSync(path.join(DEVKIT, 'node_modules/@godcreator/gwb-shell/package.json'), 'utf8'),
      'node_modules/@godcreator/gwb-shell/dist/theme.reference.css': fs.readFileSync(SHELL_THEME, 'utf8'),
    }
    return { files, compile }
  }

  it('颜色类前缀后面跟的不是色名：线型、表格边框与间距、溢出与换行、对齐、字号、边侧宽度、背景尺寸、渐变位置都不报；用主题令牌的颜色类不报', async () => {
    const tokens = [
      ...['solid', 'dashed', 'dotted', 'double', 'hidden', 'none'].map((style) => `fk:border-${style}`),
      'fk:border-collapse', 'fk:border-separate', 'fk:border-spacing-0', 'fk:border-spacing-2', 'fk:border-spacing-x-1',
      'fk:text-ellipsis', 'fk:text-clip', 'fk:text-wrap', 'fk:text-nowrap', 'fk:text-balance', 'fk:text-pretty',
      'fk:text-center', 'fk:text-start', 'fk:text-sm', 'fk:text-2xl',
      'fk:divide-x', 'fk:divide-y-2', 'fk:divide-x-reverse', 'fk:divide-dashed', 'fk:divide-dotted',
      'fk:border', 'fk:border-2', 'fk:border-t', 'fk:border-x-4',
      'fk:bg-cover', 'fk:bg-no-repeat', 'fk:bg-center', 'fk:bg-clip-text', 'fk:bg-linear-to-r', 'fk:from-10%', 'fk:to-90%',
      'fk:bg-primary', 'fk:text-muted-foreground', 'fk:border-t-border', 'fk:divide-border', 'fk:from-primary', 'fk:hover:bg-accent', 'fk:bg-primary/50',
    ]
    const { files, compile } = await realPlugin(REAL_ENTRY, tokens)
    expect(await styleProblems(DEVKIT, PLUGIN, io(files, { ok: true, compile }, DEVKIT))).toEqual([])
  })

  it('出厂调色板照报：各种颜色工具类（带透明度、只给一边、分隔线、渐变、ring）都认得', async () => {
    const tokens = ['fk:bg-blue-500', 'fk:text-red-600/50', 'fk:border-t-blue-500', 'fk:divide-red-500', 'fk:from-blue-500', 'fk:ring-blue-500', 'fk:border-dashed']
    const { files } = await realPlugin(REAL_ENTRY, tokens)
    const allowed = new Set(declaredColorNames(fs.readFileSync(SHELL_THEME, 'utf8')))
    expect(paletteColorSelectors(files['dist/style.css'], 'fk', allowed)).toEqual([
      '.fk\\:bg-blue-500',
      '.fk\\:border-t-blue-500',
      '.fk\\:divide-red-500',
      '.fk\\:from-blue-500',
      '.fk\\:ring-blue-500',
      '.fk\\:text-red-600\\/50',
    ])
  })

  it('样式入口里 @utility 用带前缀的 @apply：去掉前缀那次也编得过；漏了前缀照报，自定义的工具类漏了前缀也报', async () => {
    const entry = `${REAL_ENTRY}@utility chip {\n  @apply fk:inline-flex fk:items-center fk:hover:bg-accent;\n}\n`
    const { files, compile } = await realPlugin(entry, ['fk:chip', 'fk:flex'])
    files['src/Row.tsx'] = "const loose = 'flex chip'"
    expect(await styleProblems(DEVKIT, PLUGIN, io(files, { ok: true, compile }, DEVKIT))).toEqual([
      'chip（src/Row.tsx）：漏了 fk: 前缀，写成 fk:chip——不带前缀的类名一条规则都不出，页面上那一处没样式也不报错',
      'flex（src/Row.tsx）：漏了 fk: 前缀，写成 fk:flex——不带前缀的类名一条规则都不出，页面上那一处没样式也不报错',
    ])
  })
})
