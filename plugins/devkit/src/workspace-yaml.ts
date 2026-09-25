/**
 * 读 YAML 里本包用得到的那一层：顶层映射的键，值是标量、流式集合、块内容三种形状。
 * 不是完整的 YAML 解析器：插件运行时只能 import node 内置模块与 peer 里的包，本包构建不打包，带不进 yaml 库。
 * 读不懂的写法直接报错并写明第几行，不猜。
 */

/** 一个顶层键的值。块内容与流式集合只在调用方要读那个键时才往下解析 */
type TopLevelValue =
  | { kind: 'scalar'; value: string }
  | { kind: 'flow'; text: string; line: number }
  | { kind: 'block'; lines: Array<{ text: string; line: number }> }
  | { kind: 'block-scalar' }

interface TopLevelEntry {
  key: string
  line: number
  value: TopLevelValue
}

/** 普通标量不许用这些字符开头：YAML 里它们各有语法含义 */
const PLAIN_SCALAR_FORBIDDEN_START = /^[[\]{},&*!|>'"%@`#]|^[-?:](\s|$)/

/** 双引号标量里认的转义，与 JSON 那一套相同 */
const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

class YamlReader {
  private readonly lines: string[]

  constructor(
    text: string,
    private readonly file: string,
  ) {
    this.lines = text.split(/\r?\n/)
  }

  /** `lineIndex` 从 0 数，报错里写成从 1 数的行号 */
  fail(lineIndex: number, why: string): Error {
    return new Error(`${this.file} 第 ${String(lineIndex + 1)} 行本包读不懂：${why}。这一行是 ${JSON.stringify(this.lines[lineIndex] ?? '')}`)
  }

  entries(): TopLevelEntry[] {
    const entries: TopLevelEntry[] = []
    let i = 0
    while (i < this.lines.length) {
      const line = this.lines[i] ?? ''
      if (isBlankOrComment(line) || (entries.length === 0 && line.trimEnd() === '---')) {
        i++
        continue
      }
      if (/^\s/.test(line) || /^-(\s|$)/.test(line)) throw this.fail(i, '顶层这一行既不是「键: 值」，也不属于上面哪个键')
      const { key, rest } = this.splitKey(line, i)
      const keyLine = i
      const valueText = stripPlainComment(rest).trim()
      if (valueText === '') {
        const body: Array<{ text: string; line: number }> = []
        i++
        while (i < this.lines.length) {
          const next = this.lines[i] ?? ''
          if (!isBlankOrComment(next) && !/^\s/.test(next) && !/^-(\s|$)/.test(next)) break
          if (!isBlankOrComment(next)) body.push({ text: next, line: i })
          i++
        }
        entries.push({ key, line: keyLine, value: { kind: 'block', lines: body } })
        continue
      }
      if (/^[|>][-+0-9]*$/.test(valueText)) {
        i++
        while (i < this.lines.length && (isBlankOrComment(this.lines[i] ?? '') || /^\s/.test(this.lines[i] ?? ''))) i++
        entries.push({ key, line: keyLine, value: { kind: 'block-scalar' } })
        continue
      }
      if (rest.trimStart().startsWith('[') || rest.trimStart().startsWith('{')) {
        const { text, endLine } = this.consumeFlow(i, rest.trimStart())
        entries.push({ key, line: keyLine, value: { kind: 'flow', text, line: keyLine } })
        i = endLine + 1
        continue
      }
      entries.push({ key, line: keyLine, value: { kind: 'scalar', value: this.scalar(rest, i) } })
      i++
    }
    return entries
  }

  private splitKey(line: string, lineIndex: number): { key: string; rest: string } {
    if (line.startsWith("'") || line.startsWith('"')) {
      const { value, end } = this.quoted(line, 0, lineIndex)
      const after = line.slice(end)
      if (!after.startsWith(':') || !/^:(\s|$)/.test(after)) throw this.fail(lineIndex, '带引号的键后面要紧跟「: 」')
      return { key: value, rest: after.slice(1) }
    }
    const match = /^([^\s#][^#]*?):(?=\s|$)(.*)$/.exec(line)
    if (match === null) throw this.fail(lineIndex, '顶层这一行不是「键: 值」')
    return { key: (match[1] ?? '').trimEnd(), rest: match[2] ?? '' }
  }

  /** 一个标量：单引号、双引号或普通标量，后面只许跟空白与注释 */
  scalar(raw: string, lineIndex: number): string {
    const text = raw.trim()
    if (text.startsWith("'") || text.startsWith('"')) {
      const { value, end } = this.quoted(text, 0, lineIndex)
      const tail = text.slice(end)
      if (tail !== '' && !/^\s+#/.test(tail) && tail.trim() !== '') throw this.fail(lineIndex, '引号收尾之后还有别的内容')
      return value
    }
    const value = stripPlainComment(text).trim()
    if (PLAIN_SCALAR_FORBIDDEN_START.test(value)) throw this.fail(lineIndex, `不带引号的值不能以 ${JSON.stringify(value[0])} 开头`)
    if (/:(\s|$)/.test(value)) throw this.fail(lineIndex, '不带引号的值里不能有「: 」，要么加引号')
    return value
  }

  /** 从 `start` 处的引号读到收尾的引号，回解出来的值与收尾引号之后的位置 */
  private quoted(text: string, start: number, lineIndex: number): { value: string; end: number } {
    const quote = text[start]
    let value = ''
    let i = start + 1
    while (i < text.length) {
      const c = text[i] ?? ''
      if (quote === "'") {
        if (c === "'") {
          if (text[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          return { value, end: i + 1 }
        }
        value += c
        i++
        continue
      }
      if (c === '"') return { value, end: i + 1 }
      if (c === '\\') {
        const next = text[i + 1] ?? ''
        if (next === 'u') {
          const hex = text.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.fail(lineIndex, '\\u 后面要跟四位十六进制')
          value += String.fromCharCode(Number.parseInt(hex, 16))
          i += 6
          continue
        }
        const escaped = DOUBLE_QUOTED_ESCAPES[next]
        if (escaped === undefined) throw this.fail(lineIndex, `双引号里的转义 \\${next} 本包不认（只认 JSON 那一套）`)
        value += escaped
        i += 2
        continue
      }
      value += c
      i++
    }
    throw this.fail(lineIndex, `${quote === "'" ? '单' : '双'}引号没有收尾（引号里的值不跨行）`)
  }

  /** 从 `[` 或 `{` 读到配对的收尾，可以跨行；回去掉注释、换行换成空格的正文与收尾所在行 */
  private consumeFlow(startLine: number, firstLineRest: string): { text: string; endLine: number } {
    let depth = 0
    let text = ''
    let lineIndex = startLine
    let segment = firstLineRest
    for (;;) {
      let i = 0
      while (i < segment.length) {
        const c = segment[i] ?? ''
        if (c === "'" || c === '"') {
          const { end } = this.quoted(segment, i, lineIndex)
          text += segment.slice(i, end)
          i = end
          continue
        }
        if (c === '#' && (i === 0 || /\s/.test(segment[i - 1] ?? ''))) break
        if (c === '[' || c === '{') depth++
        if (c === ']' || c === '}') depth--
        text += c
        i++
        if (depth === 0) {
          const tail = segment.slice(i)
          if (tail.trim() !== '' && !/^\s+#/.test(tail)) throw this.fail(lineIndex, '流式集合收尾之后还有别的内容')
          return { text, endLine: lineIndex }
        }
      }
      text += ' '
      lineIndex++
      if (lineIndex >= this.lines.length) throw this.fail(startLine, '流式集合（[ 或 {）到文件末尾都没有收尾')
      segment = this.lines[lineIndex] ?? ''
    }
  }

  /** 流式列表 `[a, 'b', "c"]` 的各项；是映射、或项里还套着集合，都报错 */
  flowSequence(text: string, lineIndex: number, key: string): string[] {
    if (!text.startsWith('[')) throw this.fail(lineIndex, `${key} 要是列表`)
    const inner = text.slice(1, -1)
    const items: string[] = []
    let current = ''
    let i = 0
    while (i < inner.length) {
      const c = inner[i] ?? ''
      if (c === "'" || c === '"') {
        const { end } = this.quoted(inner, i, lineIndex)
        current += inner.slice(i, end)
        i = end
        continue
      }
      if (c === '[' || c === '{') throw this.fail(lineIndex, `${key} 的列表项里又套了集合`)
      if (c === ',') {
        items.push(current)
        current = ''
        i++
        continue
      }
      current += c
      i++
    }
    items.push(current)
    // 尾逗号之后那一段是空的，不算一项
    if (items.length > 0 && (items[items.length - 1] ?? '').trim() === '') items.pop()
    return items.map((item) => {
      if (item.trim() === '') throw this.fail(lineIndex, `${key} 的列表里有空项`)
      return this.scalar(item, lineIndex)
    })
  }

  /** 块列表：每行一个「- 标量」，短横线的缩进一致 */
  blockSequence(lines: Array<{ text: string; line: number }>, key: string): string[] {
    let indent: number | undefined
    return lines.map(({ text, line }) => {
      const match = /^(\s*)-(?:\s+(.*))?$/.exec(text)
      if (match === null) throw this.fail(line, `${key} 下面这一行不是列表项「- 值」`)
      const width = (match[1] ?? '').length
      indent ??= width
      if (width !== indent) throw this.fail(line, `${key} 的列表项缩进不一致`)
      const item = (match[2] ?? '').trim()
      if (item === '' || item.startsWith('#')) throw this.fail(line, `${key} 的列表项是空的，或者下面还套着一层`)
      if (item.startsWith('[') || item.startsWith('{')) throw this.fail(line, `${key} 的列表项里又套了集合`)
      return this.scalar(item, line)
    })
  }
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/** 普通标量的注释从「空白 + #」开始 */
function stripPlainComment(text: string): string {
  const match = /(^|\s)#/.exec(text)
  return match === null ? text : text.slice(0, match.index)
}

/**
 * pnpm-workspace.yaml 里 `packages` 的各条 glob。没有这个键回 null；有但不是标量列表、或文件里有读不懂的写法，报错
 */
export function workspacePackageGlobs(text: string, file: string): string[] | null {
  const reader = new YamlReader(text, file)
  const entry = reader.entries().find((e) => e.key === 'packages')
  if (entry === undefined) return null
  const { value } = entry
  if (value.kind === 'flow') return reader.flowSequence(value.text, value.line, 'packages')
  if (value.kind === 'block') return reader.blockSequence(value.lines, 'packages')
  throw reader.fail(entry.line, 'packages 要是列表')
}

/** 只有一层、值全是标量的 YAML（插件页的 frontmatter），回键到值的表 */
export function topLevelScalars(text: string, file: string): Record<string, string> {
  const reader = new YamlReader(text, file)
  const scalars: Record<string, string> = {}
  for (const entry of reader.entries()) {
    if (entry.value.kind !== 'scalar') throw reader.fail(entry.line, `${entry.key} 的值要是一个标量`)
    scalars[entry.key] = entry.value.value
  }
  return scalars
}

/** 顶层结构读得懂就过，读不懂就抛。嵌套在顶层键下面的内容不往下查 */
export function assertReadableYaml(text: string, file: string): void {
  new YamlReader(text, file).entries()
}
