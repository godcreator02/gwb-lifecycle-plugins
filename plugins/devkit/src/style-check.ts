import path from 'node:path'
import { exportTarget } from './artifact-check.js'
import { isRecord } from './vocab.js'

// 纯逻辑：读文件、列目录、找 Tailwind 都经调用方给的 io，测试里给假文件表与假编译器

/** 带界面插件的样式产物。插件包构建后有它才查 */
export const STYLE_ARTIFACT = 'dist/style.css'

/** 外壳包：主题令牌的色名从它导出的 `theme.reference.css` 读 */
export const SHELL_PACKAGE = '@godcreator/gwb-shell'
const SHELL_THEME_REFERENCE = './theme.reference.css'

/** Tailwind 编译器：`build` 是增量的，交给它的候选一直留在里面，回的是到这一步为止的整份 css */
export interface TailwindCompiler {
  build(candidates: string[]): string
}

/** 编译一份样式入口；`base` 是入口所在目录，入口里的 `@import` 从这里解析 */
export type TailwindCompile = (css: string, base: string) => Promise<TailwindCompiler>

export type TailwindLookup = { ok: true; compile: TailwindCompile } | { ok: false; error: string }

export interface StyleCheckIo {
  readText(file: string): string | undefined
  /** 目录下（递归）全部文件的绝对路径；目录不在回空表 */
  filesUnder(dir: string): string[]
  /** 被检查包自己构建样式用的那份 Tailwind 的编译器；找不到回 error，写明原因 */
  tailwindOf(pkgDir: string): Promise<TailwindLookup>
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g

function withoutComments(css: string): string {
  return css.replaceAll(CSS_COMMENT, '')
}

function relativeToPackage(pkgDir: string, file: string): string {
  return path.relative(pkgDir, file).replaceAll('\\', '/')
}

/** `filesUnder` 刚列出来的文件，读不到就是列完之后被删了 */
function listedText(file: string, io: Pick<StyleCheckIo, 'readText'>): string {
  const text = io.readText(file)
  if (text === undefined) throw new Error(`${file} 刚列出来就读不到了：检查途中有别的进程在改这个目录`)
  return text
}

// ── 样式入口 ──────────────────────────────────────────────────────────────────

/** 样式入口：`src/` 下唯一一个写了 `prefix(<名>)` 的 css 文件 */
export interface StyleEntry {
  file: string
  /** Tailwind 的类名前缀，`prefix(<名>)` 里的名字 */
  prefix: string
  /** 去掉注释后的入口全文 */
  css: string
}

const PREFIX_CALL = /\bprefix\(([^()]*)\)/g
/** Tailwind 4 的 prefix() 只收 a-z */
const PREFIX_NAME = /^[a-z]+$/

export function styleEntryOf(pkgDir: string, io: Pick<StyleCheckIo, 'readText' | 'filesUnder'>): { ok: true; entry: StyleEntry } | { ok: false; error: string } {
  const srcDir = path.join(pkgDir, 'src')
  const entries: { file: string; css: string; prefixes: string[] }[] = []
  for (const file of io.filesUnder(srcDir).filter((one) => one.endsWith('.css')).sort()) {
    const css = withoutComments(listedText(file, io))
    const prefixes = [...css.matchAll(PREFIX_CALL)].map((m) => m[1]!.trim())
    if (prefixes.length > 0) entries.push({ file, css, prefixes })
  }
  const hint = `样式入口是 ${STYLE_ARTIFACT} 由它编出来的那个 css，前缀写在它 @import 'tailwindcss/theme.css' theme(reference) 那一行的 prefix(<前缀>) 里`
  if (entries.length === 0) {
    return { ok: false, error: `有 ${STYLE_ARTIFACT}，但 src/ 下找不到写了 prefix(<前缀>) 的 css 文件，查不了类名前缀。${hint}` }
  }
  if (entries.length > 1) {
    const listed = entries.map((one) => relativeToPackage(pkgDir, one.file)).join('、')
    return { ok: false, error: `src/ 下有 ${String(entries.length)} 个 css 文件写了 prefix(…)（${listed}），认不出哪个是样式入口：一个插件只有一个样式入口、一个前缀` }
  }
  const [only] = entries as [(typeof entries)[number]]
  const rel = relativeToPackage(pkgDir, only.file)
  if (only.prefixes.length > 1) {
    return { ok: false, error: `样式入口 ${rel} 里写了 ${String(only.prefixes.length)} 处 prefix(…)（${only.prefixes.join('、')}）：只在 @import 'tailwindcss/theme.css' 那一行写一处` }
  }
  const prefix = only.prefixes[0]!
  if (!PREFIX_NAME.test(prefix)) {
    return { ok: false, error: `样式入口 ${rel} 里的前缀 prefix(${prefix}) 不是纯小写字母：Tailwind 4 的 prefix() 只收 a-z` }
  }
  return { ok: true, entry: { file: only.file, prefix, css: only.css } }
}

// ── 产物 dist/style.css ──────────────────────────────────────────────────────

/**
 * 一条规则的选择器是 `{` 之前那段，只在这一段里找类：全文搜 `.xxx` 会把声明值里的小数（`0.25rem`）当成类。
 * 前面的 `{` / `}` / `;` 用后行断言、不算进匹配，不然 `@media (…) {` 吃掉那个 `{`，嵌在里面的规则就漏查了
 */
const PRELUDE = /(?<=^|[{};])([^{};]*)\{/g
/** 一个类选择器。转义序列（`.dsh\:flex` 里那个 `\:`）整体算进类名 */
const CLASS_SELECTOR = /\.(?:\\.|[A-Za-z0-9_-])+/g
/** 唯一放行的不带前缀的类：`.dark` 是页面级亮暗标志，只以祖先身份出现 */
const DARK_FLAG = '.dark'

export function classSelectors(css: string): string[] {
  const found = new Set<string>()
  for (const rule of withoutComments(css).matchAll(PRELUDE)) {
    const prelude = rule[1]!.trim()
    if (prelude.startsWith('@')) continue
    for (const cls of prelude.matchAll(CLASS_SELECTOR)) found.add(cls[0])
  }
  return [...found]
}

function unprefixedSelectorProblems(css: string, prefix: string): string[] {
  const bad = classSelectors(css)
    .filter((selector) => !selector.startsWith(`.${prefix}\\:`) && selector !== DARK_FLAG)
    .sort()
  if (bad.length === 0) return []
  return [
    `${STYLE_ARTIFACT} 里有 ${String(bad.length)} 个类选择器不带 ${prefix}: 前缀：${bad.join('、')}。样式只作用于本插件靠的就是类名前缀，` +
      `不带前缀的类会命中页面上别的插件画出来的元素：样式入口里手写的规则、@import 进来的 css 里的类名都改成 ${prefix}: 开头的工具类（或删掉），只有 .dark 放行`,
  ]
}

function pluginAttributeProblems(css: string): string[] {
  if (!css.includes('data-gwb-plugin')) return []
  return [`${STYLE_ARTIFACT} 里出现了 data-gwb-plugin：样式只靠类名前缀限定范围，不依赖 [data-gwb-plugin] 这类祖先选择器——删掉样式入口里带它的规则`]
}

/** tw-animate-css 自带的默认值：写死在它的规则里，不是外壳令牌 */
const BAKED_BY_TW_ANIMATE = new Set([
  'var(--tw-duration,.15s)',
  'var(--tw-ease,ease)',
  'var(--tw-animation-delay,0s)',
  'var(--tw-animation-iteration-count,1)',
  'var(--tw-animation-direction,normal)',
  'var(--tw-animation-fill-mode,none)',
  'var(--tw-enter-opacity,1)',
  'var(--tw-enter-translate-x,0)',
  'var(--tw-enter-translate-y,0)',
  'var(--tw-enter-scale,1)',
  'var(--tw-enter-rotate,0)',
  'var(--tw-enter-blur,0)',
  'var(--tw-exit-opacity,1)',
  'var(--tw-exit-translate-x,0)',
  'var(--tw-exit-translate-y,0)',
  'var(--tw-exit-scale,1)',
  'var(--tw-exit-rotate,0)',
  'var(--tw-exit-blur,0)',
])

/** `@property` 与 `@supports` 的整块换成空白：这两类块里的默认值是 Tailwind 自己的，不查 fallback */
function blankMechanism(css: string): string {
  const chars = css.split('')
  for (const name of ['@property', '@supports']) {
    let at = css.indexOf(name)
    while (at !== -1) {
      const open = css.indexOf('{', at)
      if (open === -1) break
      let depth = 1
      let j = open + 1
      while (j < css.length && depth > 0) {
        const c = css[j]
        if (c === '{') depth++
        else if (c === '}') depth--
        j++
      }
      for (let k = at; k < j; k++) if (chars[k] !== '\n') chars[k] = ' '
      at = css.indexOf(name, j)
    }
  }
  return chars.join('')
}

/** 每个 var() 调用的完整文本（括号配对到闭合，嵌套的各算一条） */
function varCalls(css: string): string[] {
  const calls: string[] = []
  let i = css.indexOf('var(')
  while (i !== -1) {
    let depth = 0
    let end = -1
    for (let j = i; j < css.length; j++) {
      const c = css[j]
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) {
        end = j
        break
      }
    }
    if (end === -1) break
    calls.push(css.slice(i, end + 1))
    i = css.indexOf('var(', i + 4)
  }
  return calls
}

/** 调用自己那层括号里第一个逗号之后的内容；没有 fallback 回 undefined */
function fallbackOf(call: string): string | undefined {
  let depth = 0
  for (let i = 0; i < call.length; i++) {
    const c = call[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 1) return call.slice(i + 1, -1).trim()
  }
  return undefined
}

/** fallback 里有写死值的 var() 调用。放行：没有 fallback、空、currentcolor、只由 var() 组成、tw-animate-css 自带的那几条 */
export function literalFallbacks(css: string): string[] {
  const bad = new Set<string>()
  for (const call of varCalls(blankMechanism(withoutComments(css)))) {
    const fallback = fallbackOf(call)
    if (fallback === undefined || fallback === '' || fallback === 'currentcolor') continue
    if (BAKED_BY_TW_ANIMATE.has(call)) continue
    if (fallback.replaceAll(/var\([^()]*\)/g, ' ').trim() === '') continue
    bad.add(call)
  }
  return [...bad].sort()
}

function literalFallbackProblems(css: string): string[] {
  const bad = literalFallbacks(css)
  if (bad.length === 0) return []
  return [
    `${STYLE_ARTIFACT} 里有 ${String(bad.length)} 处 var() 的 fallback 写死了值：${bad.join('、')}。令牌的值全页一份、由外壳提供，写死在插件里的值换主题、切亮暗都不跟着变：` +
      `外壳的 theme.reference.css 把 Tailwind 主题键都映射到了页面变量，出现这种 fallback 多半是装的外壳旧了（仓根 pnpm install 后重新构建），或样式入口里手写了默认值（删掉）`,
  ]
}

/** 查的颜色类前缀 */
const COLOR_FAMILY = '(?:text|bg|border|from|via|to|divide)-'
/** 这几个前缀后面跟的不一定是色名：字号与对齐（text-sm、text-center）、边侧与宽度（border-t、border-2） */
const NOT_A_COLOR_NAME = /^(?:[bltrxy2](?:-\d+)?|\d|center|left|right|justify|start|end|xs|sm|base|lg|xl|2xl|3xl|4xl)$/
const COLOR_KEYWORDS = ['transparent', 'inherit', 'current']

/** css 里 `--color-<名>:` 声明的色名；给了前缀时 Tailwind 改写过的 `--<前缀>-color-<名>:` 也算 */
export function declaredColorNames(css: string, prefix?: string): string[] {
  const declared = prefix === undefined ? /--color-([\w-]+)\s*:/g : new RegExp(`--(?:${prefix}-)?color-([\\w-]+)\\s*:`, 'g')
  return [...withoutComments(css).matchAll(declared)].map((m) => m[1]!)
}

/** 用了放行名单之外色名的类选择器 */
export function paletteColorSelectors(css: string, allowed: ReadonlySet<string>): string[] {
  const bad = new Set<string>()
  const colorClass = new RegExp(`(?:^|\\\\:)${COLOR_FAMILY}([\\w-]+)`, 'g')
  for (const selector of classSelectors(css)) {
    for (const m of selector.matchAll(colorClass)) {
      const name = m[1]!
      if (NOT_A_COLOR_NAME.test(name)) continue
      if (!allowed.has(name)) bad.add(selector)
    }
  }
  return [...bad].sort()
}

/** 外壳 `theme.reference.css` 里声明的色名。外壳自己就是被检查的包时从包目录读，否则从包目录 node_modules 里装的外壳读 */
function shellColorNamesOf(pkgDir: string, pkgName: string, io: Pick<StyleCheckIo, 'readText'>): { ok: true; names: string[] } | { ok: false; error: string } {
  const shellDir = pkgName === SHELL_PACKAGE ? pkgDir : path.join(pkgDir, 'node_modules', ...SHELL_PACKAGE.split('/'))
  const manifestFile = path.join(shellDir, 'package.json')
  const text = io.readText(manifestFile)
  if (text === undefined) {
    return { ok: false, error: `包目录 node_modules 里没装外壳 ${SHELL_PACKAGE}（读不到 ${manifestFile}），算不出主题令牌有哪些色名：带界面的插件用外壳注册窗格，peer 里写上外壳，再在仓根 pnpm install` }
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `外壳的清单不是合法 JSON（${manifestFile}）：${String(err)}` }
  }
  const target = isRecord(manifest) ? exportTarget(manifest, SHELL_THEME_REFERENCE) : undefined
  if (target === undefined) return { ok: false, error: `外壳清单的 exports 里没有 "${SHELL_THEME_REFERENCE}"（${manifestFile}），读不到主题令牌的色名` }
  const themeFile = path.resolve(shellDir, target)
  const theme = io.readText(themeFile)
  if (theme === undefined) return { ok: false, error: `外壳的 theme.reference.css 读不到（${themeFile}）` }
  return { ok: true, names: declaredColorNames(theme) }
}

function paletteProblems(css: string, allowed: ReadonlySet<string>): string[] {
  const bad = paletteColorSelectors(css, allowed)
  if (bad.length === 0) return []
  return [
    `${STYLE_ARTIFACT} 里有 ${String(bad.length)} 个颜色类用了主题令牌之外的色名：${bad.join('、')}。颜色类只用主题令牌——外壳 theme.reference.css 与本插件样式入口声明的 --color-<名>，` +
      `外加 transparent / inherit / current；Tailwind 出厂调色板（bg-blue-500 这类）的值写死在插件里，换主题、切亮暗都不跟着变。换成语义色，或在样式入口的 @theme 里登记本插件自己的令牌`,
  ]
}

// ── 源码里的类名 ──────────────────────────────────────────────────────────────

/** 模板串里的插值段：不是字面量文本 */
const INTERPOLATION = /\$\{[^{}]*\}/g

/**
 * 一份源码里所有字符串字面量的内容。必须认得注释：头注里的反引号代码段在正则眼里就是模板串。
 * 最小状态机：行注释、块注释、单双引号、反引号各一个状态，只在字符串状态里收字符
 */
export function literals(source: string): string[] {
  const found: string[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let text = ''
      i++
      while (i < source.length && source[i] !== quote) {
        // 转义序列两个字符一起收下，免得把 \' 当成字符串结束
        if (source[i] === '\\') text += source[i++] ?? ''
        text += source[i++] ?? ''
      }
      i++
      found.push(quote === '`' ? text.replaceAll(INTERPOLATION, ' ') : text)
    } else {
      i++
    }
  }
  return found
}

/** Tailwind 的标记类：自己不出规则，只给 group-hover:、peer-checked: 这类变体当祖先或兄弟用 */
const MARKER_CLASS = /^(?:group|peer)(?:\/[\w-]+)?$/

/**
 * 不查「漏了前缀」的 token：`outline` 是 shadcn 组件的变体名（`variant="outline"`），又恰好是工具类 `outline-style: solid`。
 * 代价是真把光秃秃的 `outline` 写成类名时漏报；实际写法是 `outline-none` / `outline-hidden`
 */
const VARIANT_NAME_NOT_CLASS = new Set(['outline'])

/** token → 出现在哪些文件（相对包目录） */
type TokenSites = Map<string, Set<string>>

function tokenSitesOf(pkgDir: string, tsxFiles: string[], io: Pick<StyleCheckIo, 'readText'>): TokenSites {
  const sites: TokenSites = new Map()
  for (const file of tsxFiles) {
    for (const literal of literals(listedText(file, io))) {
      for (const token of literal.split(/\s+/)) {
        if (token === '') continue
        const files = sites.get(token) ?? new Set<string>()
        files.add(relativeToPackage(pkgDir, file))
        sites.set(token, files)
      }
    }
  }
  return sites
}

/** 逐个交给增量编译器，这一步的输出变了就是这个 token 自己编出了规则 */
function tokensWithRule(compiler: TailwindCompiler, tokens: Iterable<string>): Set<string> {
  const withRule = new Set<string>()
  let previous = compiler.build([])
  for (const token of tokens) {
    const next = compiler.build([token])
    if (next !== previous) withRule.add(token)
    previous = next
  }
  return withRule
}

function where(sites: TokenSites, token: string): string {
  return [...(sites.get(token) ?? [])].sort().join('、')
}

async function compiled(compile: TailwindCompile, css: string, base: string, label: string): Promise<{ ok: true; compiler: TailwindCompiler } | { ok: false; error: string }> {
  try {
    return { ok: true, compiler: await compile(css, base) }
  } catch (err) {
    return { ok: false, error: `${label}编译不了：${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 源码层：样式入口所在目录（递归）下 .tsx 里字符串字面量切出的 token。
 * 前缀排在变体后面的报；带前缀却编不出规则的报；不带前缀、但入口去掉 prefix() 后编得出规则的报「漏了前缀」
 */
async function sourceClassProblems(pkgDir: string, entry: StyleEntry, io: StyleCheckIo): Promise<string[]> {
  const entryDir = path.dirname(entry.file)
  const entryRel = relativeToPackage(pkgDir, entry.file)
  const tsxFiles = io.filesUnder(entryDir).filter((one) => one.endsWith('.tsx')).sort()
  if (tsxFiles.length === 0) {
    return [`样式入口 ${entryRel} 所在目录下一个 .tsx 都没有，查不了源码里的类名前缀：界面源码与样式入口放在同一个目录（或它的子目录）里`]
  }
  const tailwind = await io.tailwindOf(pkgDir)
  if (!tailwind.ok) return [tailwind.error]

  const prefix = `${entry.prefix}:`
  const prefixAfterVariant = `:${entry.prefix}:`
  const sites = tokenSitesOf(pkgDir, tsxFiles, io)
  const prefixed: string[] = []
  const misplaced: string[] = []
  const bare: string[] = []
  for (const token of sites.keys()) {
    if (token.startsWith(prefix)) {
      const utility = token.slice(prefix.length)
      if (utility !== '' && !MARKER_CLASS.test(utility)) prefixed.push(token)
    } else if (token.includes(prefixAfterVariant)) misplaced.push(token)
    else if (!VARIANT_NAME_NOT_CLASS.has(token)) bare.push(token)
  }

  const withPrefix = await compiled(tailwind.compile, entry.css, entryDir, `样式入口 ${entryRel} `)
  if (!withPrefix.ok) return [withPrefix.error]
  const unprefixedCss = entry.css.replace(new RegExp(`\\s*\\bprefix\\(\\s*${entry.prefix}\\s*\\)`), '')
  const withoutPrefix = await compiled(tailwind.compile, unprefixedCss, entryDir, `样式入口 ${entryRel} 去掉 prefix(${entry.prefix}) 后`)
  if (!withoutPrefix.ok) return [withoutPrefix.error]

  const prefixedWithRule = tokensWithRule(withPrefix.compiler, prefixed)
  const bareWithRule = tokensWithRule(withoutPrefix.compiler, bare)
  return [
    ...misplaced.sort().map(
      (token) =>
        `${token}（${where(sites, token)}）：前缀要排在最前，写成 ${prefix}${token.replace(prefixAfterVariant, ':')}——前缀排在变体后面 Tailwind 不报错，只是一条规则都不出`,
    ),
    ...prefixed
      .filter((token) => !prefixedWithRule.has(token))
      .sort()
      .map(
        (token) =>
          `${token}（${where(sites, token)}）：带 ${prefix} 前缀却编不出规则——工具类或变体名拼错了，或有变体排在了前缀前面；不是类名的字符串别用 ${prefix} 开头`,
      ),
    ...[...bareWithRule]
      .sort()
      .map((token) => `${token}（${where(sites, token)}）：漏了 ${prefix} 前缀，写成 ${prefix}${token}——不带前缀的类名一条规则都不出，页面上那一处没样式也不报错`),
  ]
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

/**
 * 带界面插件的样式检查。不是插件包、或构建后没有 `dist/style.css` 的不查。
 * 产物层查类名前缀、data-gwb-plugin、var() 的 fallback、颜色类只用主题令牌；源码层查 .tsx 里的类名前缀
 */
export async function styleProblems(pkgDir: string, pkg: { name: string; plugin: boolean }, io: StyleCheckIo): Promise<string[]> {
  if (!pkg.plugin) return []
  const css = io.readText(path.join(pkgDir, STYLE_ARTIFACT))
  if (css === undefined) return []
  const found = styleEntryOf(pkgDir, io)
  if (!found.ok) return [found.error]
  const { entry } = found

  const problems = [...unprefixedSelectorProblems(css, entry.prefix), ...pluginAttributeProblems(css), ...literalFallbackProblems(css)]
  const shellColors = shellColorNamesOf(pkgDir, pkg.name, io)
  if (shellColors.ok) {
    const allowed = new Set([...COLOR_KEYWORDS, ...shellColors.names, ...declaredColorNames(entry.css), ...declaredColorNames(css, entry.prefix)])
    problems.push(...paletteProblems(css, allowed))
  } else {
    problems.push(shellColors.error)
  }
  problems.push(...(await sourceClassProblems(pkgDir, entry, io)))
  return problems
}
