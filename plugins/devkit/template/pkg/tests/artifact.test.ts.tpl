import fs from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 构建产物的检查。没有 dist/ 时整组跳过——`pnpm check` 不构建。
 *
 * 这个插件的产物分三样：node 侧 tsc 输出（index.js），浏览器侧 esbuild 输出（client.js），
 * 样式 tailwindcss 输出（style.css）。分别检查：node 侧相对 import 带 .js；包名 import 两侧各有
 * 放行名单（见下）；样式的类名全带前缀、var() 的 fallback 里没有写死的值、颜色类只用主题令牌。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '../dist')
const built = fs.existsSync(distDir)

if (!built) console.warn('[{{pkgName}}] dist/ 还没生成，产物检查整组跳过（pnpm build 之后再运行）')

const CLIENT = 'client.js'
/** node 侧产物里允许留下的包名 import：node 内置模块、electron、宿主提供的 cordis。别的插件与词汇表包只 import type，编译后整句消失 */
const NODE_SIDE_ALLOWED = new Set(['electron', 'cordis'])
const isNodeBuiltin = (spec: string): boolean => spec.startsWith('node:') || builtinModules.includes(spec)
/** 浏览器侧产物里允许留下的包名 import：importmap 的提供方（外壳）在清单 gwb.shared 里声明的键 */
function sharedNamesOfShell(): Set<string> {
  const manifestPath = createRequire(import.meta.url).resolve('@godcreator/gwb-shell/package.json')
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const gwb = isRecord(manifest) ? manifest['gwb'] : undefined
  const shared = isRecord(gwb) ? gwb['shared'] : undefined
  if (!isRecord(shared)) throw new Error(`${manifestPath} 里没有 gwb.shared：装的外壳版本不提供 importmap`)
  return new Set(Object.keys(shared))
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** 正则锚行首：字符串字面量里的 import 总带着缩进，顶格的才是真的顶层 import */
const RELATIVE = /^import\s+(?:[^'"]*from\s*)?['"](\.[^'"]*)['"]/gm
const BARE = /^import\s+(?:[^'"]*from\s*)?['"]([^'".][^'"]*)['"]/gm

/** css 注释 */
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g
/**
 * 一条规则的选择器：`{` 之前那段。**只在这一段里找类**——全文搜 `.xxx` 会把声明值里的
 * 小数（`0.25rem` 的 `.25rem`）也当成类选择器。前面的 `{` / `}` / `;` 用后行断言、不算进匹配：
 * 算进去的话，`@media (hover: hover) {` 吃掉那个 `{`，嵌在里面的 `.x\:hover\:…:hover {` 就漏查了
 */
const PRELUDE = /(?<=^|[{};])([^{};]*)\{/g
/** 一个类选择器。转义序列（`.{{cssPrefix}}\:flex` 里那个 `\:`）整体算进类名 */
const CLASS_SELECTOR = /\.(?:\\.|[A-Za-z0-9_-])+/g
/** 唯一放行的非前缀类：`.dark` 是页面级亮暗标志，只以祖先身份出现 */
const DARK_FLAG = new Set(['.dark'])

function classSelectors(css: string): string[] {
  const found = new Set<string>()
  for (const rule of css.replaceAll(CSS_COMMENT, '').matchAll(PRELUDE)) {
    const prelude = rule[1]!.trim()
    if (prelude.startsWith('@')) continue
    for (const cls of prelude.matchAll(CLASS_SELECTOR)) found.add(cls[0])
  }
  return [...found]
}

/**
 * **var() 的 fallback 里不许有写死的值**：外壳导出的 `theme.reference.css` 把本插件用到的
 * Tailwind 主题键全部映射到页面变量，`var(--x, 0.25rem)` 这类写死在插件里的 fallback 就不该出现。
 * 出现了说明外壳升级后没重新构建、或有人手写了默认值，两种都不报错，但页面上令牌改了样式不跟着变。
 * 放行：var() 引用、currentcolor、空、下面那份 tw-animate-css 自带的默认值名单。
 */
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

/** 把 @property 与 @supports 的整块换成空白：这两类块里的默认值是 Tailwind 自己的，不参与 fallback 检查 */
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
        const c = css[j] ?? ''
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

/** 每个 var() 调用的完整文本（括号配对直到闭合，嵌套的各自也算一条） */
function varCalls(css: string): string[] {
  const out: string[] = []
  let i = css.indexOf('var(')
  while (i !== -1) {
    let depth = 0
    let end = -1
    for (let j = i; j < css.length; j++) {
      const c = css[j] ?? ''
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) {
        end = j
        break
      }
    }
    if (end === -1) break
    out.push(css.slice(i, end + 1))
    i = css.indexOf('var(', i + 4)
  }
  return out
}

/** 调用自己那层括号内的第一个逗号之后的内容——没有 fallback 时是 undefined */
function fallbackOf(call: string): string | undefined {
  let depth = 0
  for (let i = 0; i < call.length; i++) {
    const c = call[i] ?? ''
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 1) return call.slice(i + 1, -1).trim()
  }
  return undefined
}

/** 字面量 fallback 的完整清单（应恒为空） */
function literalFallbacks(css: string): string[] {
  const bad: string[] = []
  for (const call of varCalls(blankMechanism(css.replaceAll(CSS_COMMENT, '')))) {
    const fallback = fallbackOf(call)
    if (fallback === undefined) continue
    if (fallback === '') continue
    if (fallback === 'currentcolor') continue
    if (BAKED_BY_TW_ANIMATE.has(call)) continue
    if (fallback.replaceAll(/var\([^()]*\)/g, ' ').trim() === '') continue
    bad.push(call)
  }
  return bad
}

/**
 * **颜色类只用主题令牌，不用 Tailwind 出厂调色板**（`bg-blue-500` 这类）：令牌的值全页一份、跟着外观设置变，
 * 调色板的值写死在本插件里，换主题、切亮暗都不跟着变，也不报错。
 * 放行的色名：外壳导出的 `theme.reference.css` 与本插件样式入口 `src/client/styles.css` 里 `--color-<名>:`
 * 声明过的名字（后者是插件自己在 `@theme` 里登记的令牌），外加 CSS 关键字 transparent / inherit / current。
 * 查的颜色类前缀是 text- / bg- / border- / from- / via- / to- / divide-。
 */
const COLOR_FAMILY = '(?:text|bg|border|from|via|to|divide)-'
/** 这几个前缀后面跟的不一定是色名：字号与对齐（text-sm、text-center）、边侧与宽度（border-t、border-2） */
const NOT_A_COLOR_NAME = /^(?:[bltrxy2](?:-\d+)?|\d|center|left|right|justify|start|end|xs|sm|base|lg|xl|2xl|3xl|4xl)$/
const COLOR_KEYWORDS = ['transparent', 'inherit', 'current']

function declaredColorNames(css: string): string[] {
  return [...css.matchAll(/--color-([\w-]+)\s*:/g)].map((m) => m[1]!)
}

function allowedColorNames(): Set<string> {
  const tokenMap = fs.readFileSync(createRequire(import.meta.url).resolve('@godcreator/gwb-shell/theme.reference.css'), 'utf8')
  const ownEntry = fs.readFileSync(path.resolve(here, '../src/client/styles.css'), 'utf8')
  return new Set([...COLOR_KEYWORDS, ...declaredColorNames(tokenMap), ...declaredColorNames(ownEntry)])
}

/** 用了放行名单之外色名的类选择器 */
function paletteColorSelectors(css: string, allowed: Set<string>): string[] {
  const bad = new Set<string>()
  for (const selector of classSelectors(css)) {
    for (const m of selector.matchAll(new RegExp(`(?:^|\\\\:)${COLOR_FAMILY}([\\w-]+)`, 'g'))) {
      const name = m[1]!
      if (NOT_A_COLOR_NAME.test(name)) continue
      if (!allowed.has(name)) bad.add(selector)
    }
  }
  return [...bad].sort()
}

describe.skipIf(!built)('产物', () => {
  const all = built ? fs.readdirSync(distDir).filter((f) => f.endsWith('.js')) : []
  const nodeSide = all.filter((f) => f !== CLIENT)

  /** 一组产物文件里所有顶层包名 import 的说明符 */
  function bareImportsOf(files: string[]): Set<string> {
    const bare = new Set<string>()
    for (const file of files) {
      for (const m of fs.readFileSync(path.join(distDir, file), 'utf8').matchAll(BARE)) bare.add(m[1]!)
    }
    return bare
  }

  it('三样产物都在：node 侧至少有 index.js，浏览器侧有 client.js，外加 style.css', () => {
    // node 侧 = 所有 .js 减掉 client.js；以后拆出 store.js 这类新文件也算在内
    expect(nodeSide).toContain('index.js')
    expect(all).toContain(CLIENT)
    expect(fs.existsSync(path.join(distDir, 'style.css'))).toBe(true)
  })

  it('node 侧：相对 import 一律带扩展名——产物给 node 直接加载，ESM 不补扩展名', () => {
    const bad: string[] = []
    for (const file of nodeSide) {
      const text = fs.readFileSync(path.join(distDir, file), 'utf8')
      for (const m of text.matchAll(RELATIVE)) {
        if (!m[1]!.endsWith('.js')) bad.push(`${file}: ${m[1]!}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('node 侧：包名 import 只有 node 内置模块、electron、cordis', () => {
    const bad = [...bareImportsOf(nodeSide)].filter((spec) => !isNodeBuiltin(spec) && !NODE_SIDE_ALLOWED.has(spec))
    expect(bad).toEqual([])
  })

  it('浏览器侧：包名 import 只有外壳 gwb.shared 里声明的名字——别的名字页面上解析不到', () => {
    const shared = sharedNamesOfShell()
    expect([...bareImportsOf([CLIENT])].filter((spec) => !shared.has(spec))).toEqual([])
  })

  it('style.css 里的类选择器一律 .{{cssPrefix}}\\: 开头——样式只作用于本插件靠的就是前缀', () => {
    const bad = classSelectors(fs.readFileSync(path.join(distDir, 'style.css'), 'utf8'))
      .filter((s) => !s.startsWith('.{{cssPrefix}}\\:') && !DARK_FLAG.has(s))
      .sort()
    expect(bad).toEqual([])
  })

  it('style.css 里没有 data-gwb-plugin——靠类名前缀，不依赖任何祖先关系', () => {
    expect(fs.readFileSync(path.join(distDir, 'style.css'), 'utf8')).not.toContain('data-gwb-plugin')
  })

  it('style.css 的 var() fallback 里没有写死的值——令牌的值全页一份，由外壳提供', () => {
    const bad = literalFallbacks(fs.readFileSync(path.join(distDir, 'style.css'), 'utf8')).sort()
    expect(bad).toEqual([])
  })

  it('style.css 的颜色类只用主题令牌——外壳 theme.reference.css 与本插件样式入口声明过的 --color-<名>，不用出厂调色板', () => {
    expect(paletteColorSelectors(fs.readFileSync(path.join(distDir, 'style.css'), 'utf8'), allowedColorNames())).toEqual([])
  })
})