/** 产物里的一条 import：静态的（`import … from`、`export … from`、`import '<名>'`），或参数是字符串字面量的 `import()` */
export interface ScannedImport {
  specifier: string
  dynamic: boolean
  /** `import {} from` / `export {} from`：源码里 `import { type X }` 在 verbatimModuleSyntax 下留下的空 import */
  empty: boolean
}

/**
 * 按 JS 的词法找产物里的 import：字符串、模板字面量的文字段、正则字面量、注释里的 `import(…)` 都不算，
 * 压成一行也照样认。参数不是字符串字面量的 `import(x)` 不记。
 * 读不下去（字符串、模板、正则、注释没闭合，括号不配对）就抛错，错误信息带行列号
 */
export function scanModuleImports(code: string): ScannedImport[] {
  return importsInTokens(code, tokenize(code))
}

type BraceKind = 'block' | 'expression' | 'template'
type ParenKind = 'condition' | 'plain'

/** `start` 是词在源码里的偏移，报错时换算成行列号 */
type Token =
  | { kind: 'name'; value: string; start: number; depth: number }
  | { kind: 'string'; value: string; start: number }
  | { kind: 'literal'; start: number }
  | { kind: 'punct'; value: string; start: number; closed?: BraceKind | ParenKind }

/** 后面跟的是表达式的关键字：它们后面的 `/` 是正则的开头 */
const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends'])
/** `if (…) /re/` 这类：条件的右括号之后是一条新语句 */
const KEYWORDS_BEFORE_CONDITION = new Set(['if', 'while', 'for', 'with'])
const KEYWORDS_BEFORE_BLOCK = new Set(['else', 'do', 'try', 'finally'])
const MULTI_CHAR_PUNCT = ['=>', '++', '--']

const IDENTIFIER = /[\p{ID_Start}$_\\][\p{ID_Continue}$\p{Join_Control}\\]*/uy
const NUMBER = /\.?\d[\w.]*/y
const WHITESPACE = /\s/

function tokenize(code: string): Token[] {
  const tokens: Token[] = []
  const braces: BraceKind[] = []
  const parens: ParenKind[] = []
  let brackets = 0
  let i = code.startsWith('#!') ? lineEndOf(code, 0) : 0

  const previousToken = (): Token | undefined => tokens[tokens.length - 1]
  const depth = (): number => braces.length + parens.length + brackets
  const pushTemplateChunk = (start: number): number => {
    const chunk = templateChunkEnd(code, start)
    if (chunk.opensSubstitution) {
      braces.push('template')
      tokens.push({ kind: 'punct', value: '${', start })
    } else {
      tokens.push({ kind: 'literal', start })
    }
    return chunk.end
  }

  while (i < code.length) {
    const ch = code[i]!
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || (ch.charCodeAt(0) > 127 && WHITESPACE.test(ch))) {
      i++
      continue
    }
    if (ch === '/' && code[i + 1] === '/') {
      i = lineEndOf(code, i)
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      if (end === -1) fail(code, i, '块注释没有闭合')
      i = end + 2
      continue
    }
    if (ch === '/' && regexCanStartAfter(previousToken())) {
      tokens.push({ kind: 'literal', start: i })
      i = regexEnd(code, i)
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = stringEnd(code, i)
      tokens.push({ kind: 'string', value: code.slice(i + 1, end - 1), start: i })
      i = end
      continue
    }
    if (ch === '`') {
      i = pushTemplateChunk(i)
      continue
    }
    IDENTIFIER.lastIndex = i
    const name = IDENTIFIER.exec(code)
    if (name !== null) {
      tokens.push({ kind: 'name', value: name[0], start: i, depth: depth() })
      i += name[0].length
      continue
    }
    NUMBER.lastIndex = i
    const number = NUMBER.exec(code)
    if (number !== null) {
      tokens.push({ kind: 'literal', start: i })
      i += number[0].length
      continue
    }
    if (ch === '{') {
      braces.push(braceOpensBlock(previousToken()) ? 'block' : 'expression')
      tokens.push({ kind: 'punct', value: '{', start: i })
      i++
      continue
    }
    if (ch === '}') {
      const closed = braces.pop()
      if (closed === undefined) fail(code, i, '多出来的 }')
      if (closed === 'template') {
        i = pushTemplateChunk(i)
        continue
      }
      tokens.push({ kind: 'punct', value: '}', start: i, closed })
      i++
      continue
    }
    if (ch === '(') {
      const previous = previousToken()
      parens.push(previous?.kind === 'name' && KEYWORDS_BEFORE_CONDITION.has(previous.value) ? 'condition' : 'plain')
      tokens.push({ kind: 'punct', value: '(', start: i })
      i++
      continue
    }
    if (ch === ')') {
      const closed = parens.pop()
      if (closed === undefined) fail(code, i, '多出来的 )')
      tokens.push({ kind: 'punct', value: ')', start: i, closed })
      i++
      continue
    }
    if (ch === '[') brackets++
    if (ch === ']' && --brackets < 0) fail(code, i, '多出来的 ]')
    const multi = MULTI_CHAR_PUNCT.find((punct) => code.startsWith(punct, i))
    tokens.push({ kind: 'punct', value: multi ?? ch, start: i })
    i += multi?.length ?? 1
  }
  if (braces.length > 0 || parens.length > 0 || brackets > 0) fail(code, code.length, '到文件末尾还有没闭合的括号')
  return tokens
}

function regexCanStartAfter(previous: Token | undefined): boolean {
  if (previous === undefined) return true
  switch (previous.kind) {
    case 'string':
    case 'literal':
      return false
    case 'name':
      return KEYWORDS_BEFORE_EXPRESSION.has(previous.value)
    case 'punct':
      if (previous.value === ')') return previous.closed === 'condition'
      if (previous.value === '}') return previous.closed === 'block'
      return previous.value !== ']' && previous.value !== '++' && previous.value !== '--'
  }
}

/**
 * `{` 开的是语句块还是对象字面量，只用来判断配对的 `}` 之后的 `/` 是正则还是除号。
 * `case x: {` 与标签 `a: {` 会判成对象字面量，这两处的 `}` 之后紧跟正则会被当成除号
 */
function braceOpensBlock(previous: Token | undefined): boolean {
  if (previous === undefined) return true
  if (previous.kind === 'punct') return [';', '{', '}', ')', '=>'].includes(previous.value)
  if (previous.kind === 'name') return KEYWORDS_BEFORE_BLOCK.has(previous.value) || !KEYWORDS_BEFORE_EXPRESSION.has(previous.value)
  return false
}

function lineEndOf(code: string, from: number): number {
  const end = code.indexOf('\n', from)
  return end === -1 ? code.length : end
}

function stringEnd(code: string, start: number): number {
  const quote = code[start]
  for (let i = start + 1; i < code.length; i++) {
    const ch = code[i]
    if (ch === '\\') i++
    else if (ch === quote) return i + 1
    else if (ch === '\n') break
  }
  fail(code, start, '字符串没有闭合')
}

function regexEnd(code: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < code.length; i++) {
    const ch = code[i]
    if (ch === '\\') i++
    else if (ch === '\n') break
    else if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      IDENTIFIER.lastIndex = i + 1
      const flags = IDENTIFIER.exec(code)
      return i + 1 + (flags?.[0].length ?? 0)
    }
  }
  fail(code, start, '正则字面量没有闭合')
}

/** `start` 是开头的反引号，或结束上一段插值的 `}`；读到收尾的反引号或下一个 `${` 为止 */
function templateChunkEnd(code: string, start: number): { end: number; opensSubstitution: boolean } {
  for (let i = start + 1; i < code.length; i++) {
    const ch = code[i]
    if (ch === '\\') i++
    else if (ch === '`') return { end: i + 1, opensSubstitution: false }
    else if (ch === '$' && code[i + 1] === '{') return { end: i + 2, opensSubstitution: true }
  }
  fail(code, start, '模板字面量没有闭合')
}

function fail(code: string, offset: number, what: string): never {
  const before = code.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - before.lastIndexOf('\n')
  throw new Error(`第 ${line} 行第 ${column} 列：${what}`)
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token?.kind === 'punct' && token.value === value
}

function isName(token: Token | undefined, value: string): boolean {
  return token?.kind === 'name' && token.value === value
}

function importsInTokens(code: string, tokens: Token[]): ScannedImport[] {
  const found: ScannedImport[] = []
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!
    if (token.kind !== 'name' || (token.value !== 'import' && token.value !== 'export')) continue
    if (isPunct(tokens[k - 1], '.')) continue
    if (token.value === 'import' && isPunct(tokens[k + 1], '(')) {
      const argument = tokens[k + 2]
      if (argument?.kind === 'string' && (isPunct(tokens[k + 3], ')') || isPunct(tokens[k + 3], ','))) {
        found.push({ specifier: argument.value, dynamic: true, empty: false })
      }
      continue
    }
    // 静态 import / export 只能写在模块顶层；括号里的 import / export 是对象键、方法名
    if (token.depth !== 0) continue
    const statement = token.value === 'import' ? staticImportAt(code, tokens, k) : reExportAt(tokens, k)
    if (statement !== undefined) found.push(statement)
  }
  return found
}

function staticImportAt(code: string, tokens: Token[], at: number): ScannedImport | undefined {
  const next = tokens[at + 1]
  if (next?.kind === 'string') return { specifier: next.value, dynamic: false, empty: false }
  if (isPunct(next, '.')) return undefined
  for (let k = at + 2; k < tokens.length && !isPunct(tokens[k], ';'); k++) {
    const specifier = tokens[k + 1]
    if (isName(tokens[k], 'from') && specifier?.kind === 'string') {
      return { specifier: specifier.value, dynamic: false, empty: k === at + 3 && isPunct(next, '{') && isPunct(tokens[at + 2], '}') }
    }
  }
  fail(code, tokens[at]!.start, "import 语句里找不到 from '…'")
}

function reExportAt(tokens: Token[], at: number): ScannedImport | undefined {
  const next = tokens[at + 1]
  let clauseEnd: number
  if (isPunct(next, '*')) {
    clauseEnd = isName(tokens[at + 2], 'as') ? at + 3 : at + 1
  } else if (isPunct(next, '{')) {
    clauseEnd = at + 2
    while (clauseEnd < tokens.length && !isPunct(tokens[clauseEnd], '}')) clauseEnd++
  } else {
    return undefined
  }
  const specifier = tokens[clauseEnd + 2]
  if (!isName(tokens[clauseEnd + 1], 'from') || specifier?.kind !== 'string') return undefined
  return { specifier: specifier.value, dynamic: false, empty: clauseEnd === at + 2 && isPunct(next, '{') }
}
