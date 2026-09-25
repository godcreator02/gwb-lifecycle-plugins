import path from 'node:path'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'
import { exportTarget } from './artifact-check.js'
import { isRecord } from './vocab.js'

// 纯逻辑：读文件、列目录都经调用方给的 io，测试里给一张假文件表

export interface WiringCheckIo {
  readText(file: string): string | undefined
  /** 目录下（递归）全部文件的绝对路径；目录不在回空表。不进 `node_modules` */
  filesUnder(dir: string): string[]
  /** 工作区里的包目录（绝对路径）：仓根往下两层里有 package.json 的目录 */
  workspacePackageDirs(repoDir: string): string[]
}

/** 内核接口在根上下文上、永不撤销，用 `requireKernel` 取，不写进 inject，也不查 */
const KERNEL_SERVICE = 'gwbKernel'

// ── 去掉注释与字面量内容的源码 ─────────────────────────────────────────────────

interface StringLiteral {
  value: string
  /** 右引号之后的位置 */
  end: number
}

/**
 * `code` 与原文等长：注释、字符串与模板字面量的内容、正则字面量换成空格（换行保留，行号不变），引号留着；
 * `literals` 是单双引号字符串：左引号的位置 → 值
 */
export interface MaskedSource {
  code: string
  literals: Map<number, StringLiteral>
}

/** 这些字符后面的 `/` 是正则的开头，不是除号 */
const OPERATOR_BEFORE_REGEX = new Set('(,=:[!&|?{};+-*%<>~^'.split(''))
const KEYWORD_BEFORE_REGEX = /(?<![\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

/**
 * 最小词法状态机：行注释、块注释、单双引号字符串、模板字面量（`${…}` 里按代码继续扫）、正则字面量。
 * 单双引号字符串与正则在换行处截断：它们本来不能跨行，.tsx 里 JSX 文本中的撇号、`</div>` 最多只影响那一行
 */
export function maskSource(source: string): MaskedSource {
  const chars = source.split('')
  const literals = new Map<number, StringLiteral>()
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' '
  }
  /** 每一层是正在扫的 `${…}` 里还没闭合的 `{` 数 */
  const templateExpressionDepths: number[] = []
  let lastSignificant = -1

  const scanTemplateChunk = (start: number): number => {
    let j = start
    while (j < source.length) {
      if (source[j] === '\\') {
        j += 2
        continue
      }
      if (source[j] === '`') {
        blank(start, j)
        lastSignificant = j
        return j + 1
      }
      if (source[j] === '$' && source[j + 1] === '{') {
        blank(start, j)
        templateExpressionDepths.push(0)
        lastSignificant = j + 1
        return j + 2
      }
      j++
    }
    blank(start, source.length)
    return source.length
  }

  const regexMayStartAfter = (index: number): boolean => {
    if (index === -1) return true
    const before = source[index]!
    if (OPERATOR_BEFORE_REGEX.has(before)) return true
    if (!/[\w$]/.test(before)) return false
    return KEYWORD_BEFORE_REGEX.test(source.slice(Math.max(0, index - 11), index + 1))
  }

  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      const newline = source.indexOf('\n', i)
      const stop = newline === -1 ? source.length : newline
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2)
      const stop = close === -1 ? source.length : close + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      let value = ''
      while (j < source.length && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\' && j + 1 < source.length) {
          value += source[j + 1]
          j += 2
          continue
        }
        value += source[j]
        j++
      }
      blank(i + 1, j)
      if (source[j] === c) {
        literals.set(i, { value, end: j + 1 })
        lastSignificant = j
        i = j + 1
      } else {
        lastSignificant = j - 1
        i = j
      }
      continue
    }
    if (c === '`') {
      i = scanTemplateChunk(i + 1)
      continue
    }
    if (templateExpressionDepths.length > 0 && (c === '{' || c === '}')) {
      const top = templateExpressionDepths.length - 1
      if (c === '{') templateExpressionDepths[top]!++
      else if (templateExpressionDepths[top] === 0) {
        templateExpressionDepths.pop()
        i = scanTemplateChunk(i + 1)
        continue
      } else templateExpressionDepths[top]!--
    }
    if (c === '/' && regexMayStartAfter(lastSignificant)) {
      let j = i + 1
      let inClass = false
      while (j < source.length && source[j] !== '\n') {
        const r = source[j]
        if (r === '\\') {
          j += 2
          continue
        }
        if (r === '[') inClass = true
        else if (r === ']') inClass = false
        else if (r === '/' && !inClass) break
        j++
      }
      if (source[j] === '/') {
        blank(i + 1, j)
        j++
        while (j < source.length && /[a-z]/i.test(source[j]!)) j++
        lastSignificant = j - 1
        i = j
        continue
      }
    }
    if (!/\s/.test(c)) lastSignificant = i
    i++
  }
  return { code: chars.join(''), literals }
}

function skipSpace(code: string, from: number): number {
  let p = from
  while (p < code.length && /\s/.test(code[p]!)) p++
  return p
}

function lineOf(code: string, index: number): number {
  let line = 1
  for (let k = 0; k < index; k++) if (code[k] === '\n') line++
  return line
}

/** `start` 处（可先有空白）是只由单双引号字符串组成的数组字面量：值与 `]` 之后的位置；别的写法回 undefined */
function stringArrayAt(masked: MaskedSource, start: number): { values: string[]; end: number } | undefined {
  const { code, literals } = masked
  let p = skipSpace(code, start)
  if (code[p] !== '[') return undefined
  p++
  const values: string[] = []
  for (;;) {
    p = skipSpace(code, p)
    if (code[p] === ']') return { values, end: p + 1 }
    const literal = literals.get(p)
    if (literal === undefined) return undefined
    values.push(literal.value)
    p = skipSpace(code, literal.end)
    if (code[p] === ',') {
      p++
      continue
    }
    if (code[p] === ']') return { values, end: p + 1 }
    return undefined
  }
}

// ── 源码里的注入与提供 ─────────────────────────────────────────────────────────

/** 一处注入：`export const inject` / `static inject` 是必需，`.inject([...], fn)` 是局部注入 */
export interface InjectSite {
  service: string
  required: boolean
  line: number
}

export interface SourceWiring {
  injects: InjectSite[]
  /** `super(<上下文>, '<名>'` 与 `.provide('<名>'` 提供的服务名 */
  provides: string[]
  /** 认不出的写法：行号与那一行的原文 */
  unreadable: { line: number; text: string }[]
}

const INJECT_WORD = /(?<![\w$])inject(?![\w$])/g
const EXPORT_CONST_BEFORE = /(?<![\w$])export\s+const\s+$/
const STATIC_BEFORE = /(?<![\w$])static\s+(?:readonly\s+)?$/
const VARIABLE_BEFORE = /(?<![\w$])(?:const|let|var)\s+$/
const MEMBER_ACCESS_BEFORE = /\.\s*$/
/** `inject` 之后到 `=`：可带一段类型标注 */
const ASSIGNMENT_AFTER_NAME = /^\s*(?::[^=;\n]*)?=/
const SUPER_WITH_NAME = /(?<![\w$])super\s*\(\s*[\w$.]+\s*,\s*/g
const PROVIDE_CALL = /\.\s*provide\s*\(\s*/g

/** `open` 处是 `<` 时跳过整段类型参数（`=>` 的 `>` 不算闭合），回之后的位置；配不上回 undefined */
function afterTypeArguments(code: string, open: number): number | undefined {
  if (code[open] !== '<') return open
  let depth = 0
  for (let k = open; k < code.length; k++) {
    if (code[k] === '<') depth++
    else if (code[k] === '>' && code[k - 1] !== '=' && --depth === 0) return k + 1
  }
  return undefined
}

type InjectReading = { kind: 'sites'; services: string[]; required: boolean } | { kind: 'unreadable' } | { kind: 'not-an-injection' }

/**
 * 一处 `inject` 标识符是什么。认得三种注入：`export const inject = [...]`、`static inject = [...]`、`<上下文>.inject([...], fn)`
 * （可带类型参数），数组里只能是字符串字面量。像注入又读不出服务名的报「认不出」：这三种写法的参数不是字面量数组、
 * 叫 inject 的变量、对象字面量里值是数组的 inject 键、不经 `.` 直接调用 `inject([...])`。
 * 不是注入的不管：属性读取（`plugin.inject ?? []`）、类型里的 inject 成员与方法声明
 */
function readInjectAt(masked: MaskedSource, at: number): InjectReading {
  const { code } = masked
  const before = code.slice(Math.max(0, at - 40), at)
  const afterName = at + 'inject'.length
  if (MEMBER_ACCESS_BEFORE.test(before)) {
    const open = afterTypeArguments(code, skipSpace(code, afterName))
    if (open === undefined) return { kind: 'unreadable' }
    const paren = skipSpace(code, open)
    if (code[paren] !== '(') return { kind: 'not-an-injection' }
    const array = stringArrayAt(masked, paren + 1)
    if (array === undefined || ![',', ')'].includes(code[skipSpace(code, array.end)] ?? '')) return { kind: 'unreadable' }
    return { kind: 'sites', services: array.values, required: false }
  }
  if (EXPORT_CONST_BEFORE.test(before) || STATIC_BEFORE.test(before)) {
    const assignment = ASSIGNMENT_AFTER_NAME.exec(code.slice(afterName))
    const array = assignment === null ? undefined : stringArrayAt(masked, afterName + assignment[0].length)
    return array === undefined ? { kind: 'unreadable' } : { kind: 'sites', services: array.values, required: true }
  }
  if (VARIABLE_BEFORE.test(before)) return { kind: 'unreadable' }
  let next = skipSpace(code, afterName)
  if (code[next] === '?') next = skipSpace(code, next + 1)
  if (code[next] === ':') return code[skipSpace(code, next + 1)] === '[' ? { kind: 'unreadable' } : { kind: 'not-an-injection' }
  if (code[next] === '(' && code[skipSpace(code, next + 1)] === '[') return { kind: 'unreadable' }
  return { kind: 'not-an-injection' }
}

/**
 * 源码里的注入与提供。提供只认服务名是字符串字面量的 `super(<上下文>, '<名>'` 与 `.provide('<名>'`：
 * 名字不是字面量的不算、也不报——super 与 provide 都是常见的名字（继承 Error 的 super(message)、别的库的 provide 方法）
 */
export function sourceWiringOf(source: string): SourceWiring {
  const masked = maskSource(source)
  const { code } = masked
  const lines = source.split('\n')
  const injects: InjectSite[] = []
  const unreadable: { line: number; text: string }[] = []

  for (const match of code.matchAll(INJECT_WORD)) {
    const reading = readInjectAt(masked, match.index)
    if (reading.kind === 'not-an-injection') continue
    const line = lineOf(code, match.index)
    if (reading.kind === 'unreadable') unreadable.push({ line, text: (lines[line - 1] ?? '').trim().slice(0, 120) })
    else for (const service of reading.services) injects.push({ service, required: reading.required, line })
  }

  const provides = new Set<string>()
  for (const pattern of [SUPER_WITH_NAME, PROVIDE_CALL]) {
    for (const match of code.matchAll(pattern)) {
      const literal = masked.literals.get(match.index + match[0].length)
      if (literal !== undefined) provides.add(literal.value)
    }
  }
  return { injects, provides: [...provides], unreadable }
}

// ── 类型声明里给 cordis Context 补的项 ─────────────────────────────────────────

const DECLARE_MODULE = /(?<![\w$])declare\s+module\s+/g
const CONTEXT_INTERFACE = /(?<![\w$])interface\s+Context(?![\w$])[^{]*\{/g
const MEMBER_NAME = /(?:^|[;,\n{])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/g

/** `open` 处的 `{` 配对的 `}` 的位置；到结尾都没配上回结尾 */
function closingBrace(code: string, open: number): number {
  let depth = 0
  for (let k = open; k < code.length; k++) {
    if (code[k] === '{') depth++
    else if (code[k] === '}' && --depth === 0) return k
  }
  return code.length
}

/** 只留最外一层：括号本身留着，括号里的内容换成空格 */
function outermostLevel(body: string): string {
  let depth = 0
  let flat = ''
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') {
      flat += depth === 0 ? ch : ' '
      depth++
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth--
      flat += depth === 0 ? ch : ' '
    } else flat += depth === 0 ? ch : ' '
  }
  return flat
}

/** 一份 .d.ts 里 `declare module 'cordis' { interface Context { … } }` 补上的属性名 */
export function contextServicesOf(dts: string): string[] {
  const masked = maskSource(dts)
  const { code } = masked
  const names = new Set<string>()
  for (const declared of code.matchAll(DECLARE_MODULE)) {
    const literal = masked.literals.get(declared.index + declared[0].length)
    if (literal?.value !== 'cordis') continue
    const open = skipSpace(code, literal.end)
    if (code[open] !== '{') continue
    const moduleBody = code.slice(open + 1, closingBrace(code, open))
    for (const contextInterface of moduleBody.matchAll(CONTEXT_INTERFACE)) {
      const bodyOpen = contextInterface.index + contextInterface[0].length - 1
      const members = outermostLevel(moduleBody.slice(bodyOpen + 1, closingBrace(moduleBody, bodyOpen)))
      for (const member of members.matchAll(MEMBER_NAME)) names.add(member[1]!)
    }
  }
  return [...names]
}

/** 包的类型入口（相对包目录）：`exports["."]` 里的 `types` 条件，没有时取清单的 `types` / `typings` */
export function typesEntryOf(manifest: Record<string, unknown>): string | undefined {
  const exported = manifest.exports
  if (exported !== undefined) {
    const root = isRecord(exported) && Object.keys(exported).some((key) => key.startsWith('.')) ? exported['.'] : exported
    const found = typesConditionOf(root)
    if (found !== undefined) return found
  }
  for (const key of ['types', 'typings']) {
    const value = manifest[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function typesConditionOf(target: unknown): string | undefined {
  if (typeof target === 'string') return /\.d\.[cm]?ts$/.test(target) ? target : undefined
  if (!isRecord(target)) return undefined
  if (typeof target['types'] === 'string') return target['types']
  for (const value of Object.values(target)) {
    const found = typesConditionOf(value)
    if (found !== undefined) return found
  }
  return undefined
}

// ── 依赖里谁提供哪个服务 ───────────────────────────────────────────────────────

interface KnownPackage {
  name: string
  dir: string
  manifest: Record<string, unknown>
  plugin: boolean
  /** 类型入口给 cordis Context 补的名字 */
  declares: Set<string>
  /** 它自己 peer、dev、dependencies 里写的全部包名 */
  dependsOn: Set<string>
}

/** `filesUnder` 刚列出来的文件，读不到就是列完之后被删了 */
function listedText(file: string, io: Pick<WiringCheckIo, 'readText'>): string {
  const text = io.readText(file)
  if (text === undefined) throw new Error(`${file} 刚列出来就读不到了：检查途中有别的进程在改这个目录`)
  return text
}

function namesIn(table: unknown): string[] {
  return isRecord(table) ? Object.keys(table) : []
}

function knownPackageAt(dir: string, io: Pick<WiringCheckIo, 'readText'>): KnownPackage | undefined {
  const text = io.readText(path.join(dir, 'package.json'))
  if (text === undefined) return undefined
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(manifest) || typeof manifest.name !== 'string') return undefined
  const entry = typesEntryOf(manifest)
  const dts = entry === undefined ? undefined : io.readText(path.resolve(dir, entry))
  return {
    name: manifest.name,
    dir,
    manifest,
    plugin: Array.isArray(manifest.keywords) && manifest.keywords.includes('gwb-plugin'),
    declares: new Set(dts === undefined ? [] : contextServicesOf(dts)),
    dependsOn: new Set([...namesIn(manifest.peerDependencies), ...namesIn(manifest.devDependencies), ...namesIn(manifest.dependencies)]),
  }
}

/** 包的运行时代码（`exports["."]` 入口所在目录下的 js）里 `super(<上下文>, '<名>'` 与 `.provide('<名>'` 提供的服务名 */
function runtimeProvidesOf(known: KnownPackage, io: Pick<WiringCheckIo, 'readText' | 'filesUnder'>): Set<string> {
  const entry = exportTarget(known.manifest, '.')
  if (entry === undefined) return new Set()
  const provides = new Set<string>()
  for (const file of io.filesUnder(path.dirname(path.resolve(known.dir, entry))).filter((one) => RUNTIME_MODULE.test(one))) {
    for (const name of sourceWiringOf(listedText(file, io)).provides) provides.add(name)
  }
  return provides
}

/**
 * 类型入口给 Context 补了这个名字的插件。不止一个时只留运行时代码里真的提供它的：外壳为了 pnpm 的目录布局把 gwbCommands、
 * gwbData 按真类型再声明一遍，它不提供这两个服务。一个都留不下时原样回，由调用方报「判不出」
 */
function providersOf(service: string, candidates: readonly KnownPackage[], io: Pick<WiringCheckIo, 'readText' | 'filesUnder'>): KnownPackage[] {
  const declarers = candidates.filter((one) => one.declares.has(service))
  if (declarers.length <= 1) return declarers
  const providing = declarers.filter((one) => runtimeProvidesOf(one, io).has(service))
  return providing.length === 0 ? declarers : providing
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export interface WiringCheckInput {
  pkgDir: string
  repoDir: string
  /** 解析出的整份包清单 */
  manifest: Record<string, unknown> & { name: string }
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const RUNTIME_MODULE = /\.[cm]?js$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

/** 一个服务在本包源码里的全部注入：有一处必需就算必需 */
interface ServiceUsage {
  required: boolean
  sites: string[]
}

function scanSources(pkgDir: string, io: WiringCheckIo): { usages: Map<string, ServiceUsage>; provides: Set<string>; problems: string[] } {
  const usages = new Map<string, ServiceUsage>()
  const provides = new Set<string>()
  const problems: string[] = []
  const files = io
    .filesUnder(path.join(pkgDir, 'src'))
    .filter((file) => SOURCE_FILE.test(file) && !DECLARATION_FILE.test(file))
    .sort()
  for (const file of files) {
    const rel = path.relative(pkgDir, file).replaceAll('\\', '/')
    const wiring = sourceWiringOf(listedText(file, io))
    for (const { line, text } of wiring.unreadable) {
      problems.push(
        `${rel}:${String(line)} 认不出的注入或提供写法：${text}。发版前检查只认 export const inject = ['<服务名>', …]、static inject = [...]、` +
          `<上下文>.inject(['<服务名>', …], fn) 与 <上下文>.provide('<服务名>', …)，数组里只写字符串字面量；改写成这几种（类型里要用 inject 方法就从 cordis 取 Context 类型，别自己声明）`,
      )
    }
    for (const site of wiring.injects) {
      const usage = usages.get(site.service) ?? { required: false, sites: [] }
      usage.required ||= site.required
      usage.sites.push(`${rel}:${String(site.line)}`)
      usages.set(site.service, usage)
    }
    for (const name of wiring.provides) provides.add(name)
  }
  return { usages, provides, problems }
}

function describeUsage(service: string, usage: ServiceUsage): string {
  return `${service}（${usage.sites.join('、')}，${usage.required ? '必需注入' : '局部注入'}）`
}

/**
 * 局部注入、peer 与 dev 里都找不到提供方时，只有一种情况放行：提供方是同一个工作区里的插件，它自己 peer / dev 写了本包，
 * 本包再写它就成了包依赖环（pnpm 12 的 `pnpm -r` 遇环直接退出）
 */
function providedByCyclicSibling(service: string, input: WiringCheckInput, io: WiringCheckIo): boolean {
  const self = path.resolve(input.pkgDir)
  for (const dir of io.workspacePackageDirs(input.repoDir)) {
    if (path.resolve(dir) === self) continue
    const sibling = knownPackageAt(dir, io)
    if (sibling?.plugin === true && sibling.declares.has(service) && sibling.dependsOn.has(input.manifest.name)) return true
  }
  return false
}

function optionalPeersOf(meta: unknown): Set<string> {
  const optional = new Set<string>()
  if (!isRecord(meta)) return optional
  for (const [name, entry] of Object.entries(meta)) if (isRecord(entry) && entry['optional'] === true) optional.add(name)
  return optional
}

function injectPeerProblems(input: WiringCheckInput, usages: Map<string, ServiceUsage>, provides: Set<string>, io: WiringCheckIo): string[] {
  const { manifest, pkgDir } = input
  const peers = new Set(namesIn(manifest.peerDependencies))
  const optionalPeers = optionalPeersOf(manifest.peerDependenciesMeta)
  const candidates: KnownPackage[] = []
  for (const name of new Set([...peers, ...namesIn(manifest.devDependencies)])) {
    if (name === manifest.name || name === 'cordis' || name === KERNEL_PACKAGE) continue
    const known = knownPackageAt(path.join(pkgDir, 'node_modules', ...name.split('/')), io)
    if (known !== undefined) candidates.push(known)
  }
  const plugins = candidates.filter((one) => one.plugin)

  const problems: string[] = []
  for (const [service, usage] of usages) {
    if (service === KERNEL_SERVICE || provides.has(service)) continue
    const providers = providersOf(service, plugins, io)
    if (providers.length > 1) {
      problems.push(
        `${describeUsage(service, usage)}：peer 与 dev 里有 ${String(providers.length)} 个插件的类型入口都给 cordis 的 Context 补了这个名字（${providers.map((one) => one.name).join('、')}），` +
          `运行时代码里提供它的（super(<上下文>, '${service}') 或 .provide('${service}')）不是恰好一个，判不出由谁提供。查清谁提供，把别的从 peer 与 dev 里删掉`,
      )
      continue
    }
    const provider = providers[0]
    if (provider === undefined) {
      if (!usage.required && providedByCyclicSibling(service, input, io)) continue
      // 提供方不是 gwb 插件（例如 cordis 官方插件 @cordisjs/plugin-timer）：「用到的插件写 peer」管不到它
      if (candidates.some((one) => !one.plugin && one.declares.has(service))) continue
      problems.push(
        `${describeUsage(service, usage)}：peer 与 dev 里没有哪个包的类型入口（exports["."] 的 types）给 cordis 的 Context 补了 ${service}，判不出由谁提供。` +
          `把提供它的插件写进 peerDependencies（${usage.required ? '必需注入写普通 peer' : '局部注入在 peerDependenciesMeta 里标 optional: true'}），再在仓根 pnpm install`,
      )
      continue
    }
    if (!peers.has(provider.name)) {
      problems.push(
        `${describeUsage(service, usage)} 由 ${provider.name} 提供，它不在 peerDependencies 里：写进 peer（范围 ^x.y.z${usage.required ? '' : '，在 peerDependenciesMeta 里标 optional: true'}），dev 里那一条删掉`,
      )
    } else if (usage.required && optionalPeers.has(provider.name)) {
      problems.push(
        `${describeUsage(service, usage)} 的提供方 ${provider.name} 在 peerDependenciesMeta 里标了 optional：必需注入的服务缺了，本插件就不加载，去掉 optional；缺了它本插件也能用的话，把注入改成 ctx.inject([...], fn)`,
      )
    }
  }
  return problems
}

/**
 * 插件包的注入与 peer 一致：源码里注入的每个服务，提供方（peer / dev 里的插件，看类型入口给 cordis Context
 * 补的名字）写在 peer 里，必需注入的不标 optional
 */
export function wiringProblems(input: WiringCheckInput, io: WiringCheckIo): string[] {
  const scanned = scanSources(input.pkgDir, io)
  return [...scanned.problems, ...injectPeerProblems(input, scanned.usages, scanned.provides, io)]
}
