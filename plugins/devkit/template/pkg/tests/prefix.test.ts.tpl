import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'
import { describe, expect, it } from 'vitest'

/**
 * **忘加前缀的守卫。**
 *
 * 样式只作用于本插件，靠的是「类名自带 `{{cssPrefix}}:` 前缀」，代价是**漏加前缀不会有任何提示**：`flex` 不带前缀，
 * 带前缀的编译一个字节都不输出，页面上就是那一处没样式——不报错、构建照样通过。
 *
 * 判法：把 src/client 下所有 tsx 里的字符串字面量抽出来切 token；对每个不以
 * `{{cssPrefix}}:` 开头的 token，拿本插件的 styles.css（去掉 prefix 再编——带前缀的编译器
 * 对裸 `flex` 只会回「不认识」，分不出漏没漏）问 Tailwind「编得出规则吗」。
 * 编得出来的，就是本该带前缀而没带的类。模板串的插值段、data-probe 的值、
 * import 说明符这些自然编不出规则，不用特判。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.resolve(here, '../src/client')

/** 模板串里的插值段——静态段之外的部分，不是字面量文本 */
const INTERPOLATION = /\$\{[^{}]*\}/g

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...tsxFiles(full))
    else if (e.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/**
 * 一份源码里所有字符串字面量的**内容**。必须认得注释——头注里全是反引号代码段，
 * 一对反引号在正则眼里就是一个模板串。走一遍最小状态机：行注释、块注释、
 * 单双引号、反引号各是一个状态，只在字符串状态里收字符。
 */
function literals(source: string): string[] {
  const out: string[] = []
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
        // 转义序列两个字符一起收下，免得把 \' 这类被转义的引号当成字符串结束
        if (source[i] === '\\') text += source[i++] ?? ''
        text += source[i++] ?? ''
      }
      i++
      out.push(quote === '`' ? text.replaceAll(INTERPOLATION, ' ') : text)
    } else {
      i++
    }
  }
  return out
}

describe('忘加前缀的守卫', () => {
  const files = tsxFiles(clientDir)

  it('src/client 下确实有 tsx——一个都没找到的话这条守卫等于什么都没查', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('字符串字面量里没有漏掉 {{cssPrefix}}: 前缀的类名', async () => {
    const input = fs.readFileSync(path.join(clientDir, 'styles.css'), 'utf8').replace(' prefix({{cssPrefix}})', '')
    // 那一行真的摘干净了才算数（头注里也提到 prefix）
    expect(input.replaceAll(/\/\*[\s\S]*?\*\//g, '')).not.toContain('prefix(')

    const compiler = await compile(input, { base: clientDir, onDependency: () => {} })

    const tokens = new Set<string>()
    for (const file of files) {
      for (const literal of literals(fs.readFileSync(file, 'utf8'))) {
        for (const token of literal.split(/\s+/)) {
          if (token === '' || token.startsWith('{{cssPrefix}}:')) continue
          tokens.add(token)
        }
      }
    }

    // `build` 是增量的：候选一旦交给它就留在里面。判据是**逐个传入，看这一步的输出
    // 有没有变**——变了才说明这个 token 自己编出了规则
    const missing: string[] = []
    let previous = compiler.build([])
    for (const token of tokens) {
      const next = compiler.build([token])
      if (next === previous) continue
      missing.push(token)
      previous = next
    }
    expect(missing.sort()).toEqual([])
  })
})
