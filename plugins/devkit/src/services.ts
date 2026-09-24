// 纯函数：输入是各包 .d.ts 的原文，读盘在 node-services-deps.ts

/** 一个包装在 home 里的样子：清单里的名字、版本，与它全部 .d.ts 的原文 */
export interface PackageTypeDeclarations {
  pkg: string
  version: string
  declarationTexts: string[]
}

/** 类型声明里给 cordis `Context` 补的一项：`gwbSkills: GwbSkillsApi;` */
export interface ContextField {
  service: string
  type: string
  optional: boolean
}

export interface ServiceEntry {
  service: string
  /** 声明了这个服务、类型也定义在自己声明里的包，`<包名>@<版本>`；正常只有一个 */
  providers: string[]
  type: string
  /** 提供方声明里写的是 `name?:`（缺了也能加载） */
  optional: boolean
  /** 第一个提供方里这个类型的定义原文，连同紧挨着的文档注释；没有提供方时没有这个字段 */
  definition?: string
  /** 也声明了这个服务、类型却是从别的包 import 来的包（用它的一方） */
  declaredAlsoBy: string[]
}

const CORDIS_MODULE_BLOCK = /declare module ['"]cordis['"]\s*\{/g
const CONTEXT_INTERFACE = /\binterface Context\b[^{]*\{/g
const CONTEXT_FIELD = /^\s*([A-Za-z_$][\w$]*)(\?)?\s*:\s*([^;]+);/gm

/** `text[openBrace]` 是 `{`，回与它配对的 `}` 的下标；配不上回 -1 */
function matchingBrace(text: string, openBrace: number): number {
  let depth = 0
  for (let index = openBrace; index < text.length; index++) {
    if (text[index] === '{') depth++
    else if (text[index] === '}' && --depth === 0) return index
  }
  return -1
}

/** 花括号块的正文：`pattern` 匹配到以 `{` 结尾的开头，回每一处 `{…}` 之间的内容 */
function blockBodies(text: string, pattern: RegExp): string[] {
  const bodies: string[] = []
  for (const match of text.matchAll(pattern)) {
    const openBrace = match.index + match[0].length - 1
    const closeBrace = matchingBrace(text, openBrace)
    if (closeBrace !== -1) bodies.push(text.slice(openBrace + 1, closeBrace))
  }
  return bodies
}

/** 一份 .d.ts 里 `declare module 'cordis' { interface Context { … } }` 补的全部项 */
export function contextFieldsOf(declarationText: string): ContextField[] {
  const fields: ContextField[] = []
  for (const moduleBody of blockBodies(declarationText, CORDIS_MODULE_BLOCK)) {
    for (const contextBody of blockBodies(moduleBody, CONTEXT_INTERFACE)) {
      for (const match of contextBody.matchAll(CONTEXT_FIELD)) {
        fields.push({ service: match[1]!, type: match[3]!.trim(), optional: match[2] === '?' })
      }
    }
  }
  return fields
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `headStart` 前面紧挨着（中间只有空白）的那段 `/** … *\/` 的起点；没有就是 `headStart` 自己 */
function startWithDocComment(text: string, headStart: number): number {
  const before = text.slice(0, headStart).trimEnd()
  if (!before.endsWith('*/')) return headStart
  const docStart = before.lastIndexOf('/**')
  return docStart === -1 ? headStart : docStart
}

/**
 * 一份 .d.ts 里 `type` 这个名字的定义原文（interface / class / type 别名），连同紧挨在前面的文档注释；没定义回 undefined。
 * 定义从行首写起；`import type { X }`、`import { type X }` 这类引用不在行首，不算
 */
export function definitionOf(declarationText: string, type: string): string | undefined {
  const head = new RegExp(`^[ \\t]*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(interface|class|type)\\s+${escapeRegExp(type)}\\b`, 'gm')
  for (const match of declarationText.matchAll(head)) {
    const start = startWithDocComment(declarationText, match.index)
    if (match[1] === 'type') {
      const end = declarationText.indexOf(';', match.index)
      if (end !== -1) return declarationText.slice(start, end + 1).trim()
      continue
    }
    const openBrace = declarationText.indexOf('{', match.index + match[0].length)
    const closeBrace = openBrace === -1 ? -1 : matchingBrace(declarationText, openBrace)
    if (closeBrace !== -1) return declarationText.slice(start, closeBrace + 1).trim()
  }
  return undefined
}

function definitionIn(declarations: PackageTypeDeclarations, type: string): string | undefined {
  for (const text of declarations.declarationTexts) {
    const found = definitionOf(text, type)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 各包的 .d.ts → 服务总览，按服务名排序。一个包给 `Context` 补了某个服务、这个服务的类型又定义在它自己的声明里，
 * 它就是提供方；类型从别处 import 来的只是在用
 */
export function servicesOf(packages: PackageTypeDeclarations[]): ServiceEntry[] {
  const entries = new Map<string, ServiceEntry>()
  for (const declarations of packages) {
    const label = `${declarations.pkg}@${declarations.version}`
    for (const field of declarations.declarationTexts.flatMap(contextFieldsOf)) {
      const entry = entries.get(field.service) ?? { service: field.service, providers: [], type: field.type, optional: field.optional, declaredAlsoBy: [] }
      entries.set(field.service, entry)
      if (entry.providers.includes(label) || entry.declaredAlsoBy.includes(label)) continue
      const definition = definitionIn(declarations, field.type)
      if (definition === undefined) {
        entry.declaredAlsoBy.push(label)
        continue
      }
      if (entry.providers.length === 0) {
        entry.type = field.type
        entry.optional = field.optional
        entry.definition = definition
      }
      entry.providers.push(label)
    }
  }
  return [...entries.values()].sort((a, b) => (a.service < b.service ? -1 : 1))
}
