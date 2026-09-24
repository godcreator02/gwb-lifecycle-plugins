import fs from 'node:fs'
import path from 'node:path'
import { importSpecifiersOf } from './capabilities.js'
import { isRecord } from './vocab.js'

// `gwb.provides` 的消费方是 devkit.capabilities 与服务表：它们照这张表给出每个服务、每个 import 入口的用法

/** 服务名只认标识符：注释里 `super(ctx, '<名>')` 这类示意写法不会被当成服务 */
const SERVICE_NAME = String.raw`([A-Za-z_$][\w$]*)`
const QUOTED_SERVICE_NAME = String.raw`(['"\`])${SERVICE_NAME}\1`

const PROVIDE_PATTERNS = [
  new RegExp(String.raw`super\(\s*ctx\s*,\s*${QUOTED_SERVICE_NAME}`, 'g'),
  new RegExp(String.raw`\.provide\(\s*${QUOTED_SERVICE_NAME}`, 'g'),
  new RegExp(String.raw`new\s+[\w.]+\s*\(\s*ctx\s*,\s*${QUOTED_SERVICE_NAME}`, 'g'),
]

/**
 * 按文本扫三种写法：`super(ctx, '<名>')`、`ctx.provide('<名>', …)`、`new XxxService(ctx, '<名>')`。
 * 只看文本不看语法，注释里照这三种写法写出的真实服务名也算提供
 */
export function servicesProvidedBySource(sourceText: string): Set<string> {
  const providedServiceNames = new Set<string>()
  for (const pattern of PROVIDE_PATTERNS) {
    for (const match of sourceText.matchAll(pattern)) providedServiceNames.add(match[2] ?? '')
  }
  return providedServiceNames
}

/** 包目录 `src/` 下全部 `.ts` / `.tsx` 的文本连成一份；没有 `src/` 是空串 */
export function sourceTextUnder(pkgDir: string): string {
  const srcDir = path.join(pkgDir, 'src')
  if (!fs.existsSync(srcDir)) return ''
  return fs
    .readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n')
}

function isGwbPackage(manifest: Record<string, unknown>): boolean {
  const keywords = manifest['keywords']
  return Array.isArray(keywords) && (keywords.includes('gwb') || keywords.includes('gwb-plugin'))
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

const DECLARATION_SHAPE = '{ "summary": "<一句话说它提供什么>", "usage": "<怎么用：服务写方法怎么调，入口写 import 什么>" }'

function declarationProblems(key: string, declaration: unknown): string[] {
  if (!isRecord(declaration)) {
    return [`gwb.provides 里 "${key}" 是 ${JSON.stringify(declaration)}：改成 ${DECLARATION_SHAPE}`]
  }
  const problems: string[] = []
  if (!isNonEmptyString(declaration['summary'])) {
    problems.push(`gwb.provides 里 "${key}" 的 summary 是 ${JSON.stringify(declaration['summary'])}：改成非空字符串，一句话说它提供什么`)
  }
  if (!isNonEmptyString(declaration['usage'])) {
    problems.push(`gwb.provides 里 "${key}" 的 usage 是 ${JSON.stringify(declaration['usage'])}：改成非空字符串，写怎么用（服务写方法怎么调，入口写 import 什么）`)
  }
  return problems
}

function listedOrNone(names: readonly string[]): string {
  return names.length === 0 ? '无' : names.join('、')
}

/**
 * `keywords` 含 `gwb` 或 `gwb-plugin` 的包才查，别的回空表。三条规则：
 * 源码提供的每个服务在 `gwb.provides` 里都有一条；`gwb.provides` 的每个键是源码提供的服务名，或本包 exports 里的
 * import 说明符（主入口是包名，子路径是 `包名/子路径`）；每条声明的 summary 与 usage 是非空字符串
 */
export function providesDeclarationProblems(manifest: Record<string, unknown>, sourceText: string): string[] {
  if (!isGwbPackage(manifest)) return []
  const gwb = manifest['gwb']
  const provides = isRecord(gwb) ? gwb['provides'] : undefined
  if (provides !== undefined && !isRecord(provides)) {
    return [`gwb.provides 是 ${JSON.stringify(provides)}：改成对象 { "<服务名或 import 说明符>": ${DECLARATION_SHAPE} }`]
  }
  const declarations = provides ?? {}
  const providedServiceNames = [...servicesProvidedBySource(sourceText)].sort()
  const pkg = typeof manifest['name'] === 'string' ? manifest['name'] : ''
  const specifiers = pkg === '' ? [] : importSpecifiersOf(pkg, manifest)

  const problems: string[] = []
  for (const service of providedServiceNames) {
    if (!(service in declarations)) {
      problems.push(`源码提供服务 ${service}，gwb.provides 里没有它：加一条 "${service}": ${DECLARATION_SHAPE}`)
    }
  }
  for (const [key, declaration] of Object.entries(declarations)) {
    if (!providedServiceNames.includes(key) && !specifiers.includes(key)) {
      problems.push(
        `gwb.provides 里 "${key}" 既不是源码提供的服务（源码提供的：${listedOrNone(providedServiceNames)}），` +
          `也不是本包 exports 里的 import 说明符（有：${listedOrNone(specifiers)}）：改成其中一个，或删掉这一条`,
      )
    }
    problems.push(...declarationProblems(key, declaration))
  }
  return problems
}
