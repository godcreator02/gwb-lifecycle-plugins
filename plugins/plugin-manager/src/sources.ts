/**
 * 零 I/O 纯逻辑。只认三种行，其余（注释、空行、别的配置）原样保留：
 * `@j:registry=https://host/api/packages/J/npm/`、`//host/api/packages/J/npm/:_authToken=shxxx`、`registry=https://registry.npmjs.org/`。
 * token 行按源地址配对、不按 scope（同一个 token 可以配好几条源）：换源、删源时，没有别的 scope 还指向那个地址才一起删
 */

/** 一条 scope 路由（token 只在写盘前短暂持有，回执里一律经 `maskLine` 遮掉） */
export interface SourceEntry {
  scope: string
  registry: string
  token?: string
}

/** 列表里看到的一条：多了出处。pnpm 把两层 npmrc 合起来读，只看一层会漏 */
export interface SourceView extends SourceEntry {
  file: 'user' | 'home'
}

/** `@` 开头、不带 `/`。大写也收（gitea 源上 `@j` 实际能用），只拦手滑写成包名或忘了 `@` */
const SCOPE_RE = /^@[\w.-]+$/

/** `@scope:registry=<url>` */
const SCOPE_LINE_RE = /^(@[\w.-]+):registry=(\S+)$/

/** `//<host/path>/:_authToken=<token>`。键里没有协议，配对靠 `registryKeyOf` */
const TOKEN_LINE_RE = /^(\/\/\S+?):_authToken=(\S+)$/

/** `registry=<url>`，没有单独配置的 scope 都从这里装 */
const GLOBAL_LINE_RE = /^registry=(\S+)$/

/** npm 官方源。两份 npmrc 都没写 `registry=` 时 pnpm 用的就是它 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** 生态自己的 scope：本机所有 home 的安装、所有源码仓的安装与发版都指向它，插件管理不许改、不许删 */
export const BOOTSTRAP_SCOPE = '@godcreator'

export function isScope(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_RE.test(value)
}

/** http(s) 开头、没有空白。源长什么样由 pnpm 判断 */
export function isRegistryUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/\S+$/.test(value)
}

/** 源地址 → token 行的键：去掉协议、补上结尾斜杠，与 `TOKEN_LINE_RE` 捕获的键形状相同 */
export function registryKeyOf(registry: string): string {
  const withoutProtocol = registry.replace(/^https?:\/\//, '')
  return `//${withoutProtocol.endsWith('/') ? withoutProtocol : `${withoutProtocol}/`}`
}

/** token 的值换成 `***`，不带长度也不带前缀 */
export function maskLine(line: string): string {
  return line.replace(/(_authToken=)\S+$/, '$1***')
}

interface ScopeLine {
  scope: string
  registry: string
  index: number
}

interface TokenLine {
  key: string
  token: string
  index: number
}

function scopeAndTokenLinesOf(text: string): { scopes: ScopeLine[]; tokens: TokenLine[] } {
  const scopes: ScopeLine[] = []
  const tokens: TokenLine[] = []
  text.split('\n').forEach((line, index) => {
    const scopeMatch = SCOPE_LINE_RE.exec(line)
    if (scopeMatch !== null) {
      scopes.push({ scope: scopeMatch[1]!, registry: scopeMatch[2]!, index })
      return
    }
    const tokenMatch = TOKEN_LINE_RE.exec(line)
    if (tokenMatch !== null) tokens.push({ key: tokenMatch[1]!, token: tokenMatch[2]!, index })
  })
  return { scopes, tokens }
}

/** 一份 npmrc 文本里的全部 scope 路由，token 按 `registryKeyOf` 配上 */
export function parseSources(text: string): SourceEntry[] {
  const { scopes, tokens } = scopeAndTokenLinesOf(text)
  return scopes.map(({ scope, registry }) => ({
    scope,
    registry,
    token: tokens.find((token) => token.key === registryKeyOf(registry))?.token,
  }))
}

/** 逐份解析、带上出处，保持传入的顺序 */
export function mergeSources(parts: readonly { file: 'user' | 'home'; text: string }[]): SourceView[] {
  return parts.flatMap(({ file, text }) => parseSources(text).map((entry) => ({ ...entry, file })))
}

function globalRegistryOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const globalMatch = GLOBAL_LINE_RE.exec(line.trim())
    if (globalMatch !== null && isRegistryUrl(globalMatch[1])) return globalMatch[1]
  }
  return undefined
}

/**
 * 照 pnpm 的优先级：先 `@scope:registry=`，再 `registry=`，每一种 home 级优先于机器级，都没有就是 npm 官方源；
 * 返回的地址以 `/` 结尾。环境变量或 pnpm 全局配置指定的源这里看不到
 */
export function registryFor(scope: string, layers: { home: string; user: string }): string {
  const scopedRegistry =
    parseSources(layers.home).find((source) => source.scope === scope)?.registry ??
    parseSources(layers.user).find((source) => source.scope === scope)?.registry
  const registry = scopedRegistry ?? globalRegistryOf(layers.home) ?? globalRegistryOf(layers.user) ?? DEFAULT_REGISTRY
  return registry.endsWith('/') ? registry : `${registry}/`
}

function anyScopeStillPointsTo(lines: readonly string[], registry: string): boolean {
  const key = registryKeyOf(registry)
  return lines.some((line) => {
    const scopeMatch = SCOPE_LINE_RE.exec(line)
    return scopeMatch !== null && registryKeyOf(scopeMatch[2]!) === key
  })
}

/** 按内容找、不按旧下标：前面插删过行，下标已经变了 */
function dropTokenLineIfNoScopePointsTo(lines: string[], registry: string): void {
  if (anyScopeStillPointsTo(lines, registry)) return
  const key = registryKeyOf(registry)
  const tokenLineIndex = lines.findIndex((line) => TOKEN_LINE_RE.test(line) && TOKEN_LINE_RE.exec(line)![1] === key)
  if (tokenLineIndex !== -1) lines.splice(tokenLineIndex, 1)
}

/**
 * 已有就原地替换，没有就追加到末尾。`token` 没给就只动路由行（公开源不需要凭据）。
 * `wrote` 是这次写进去的行（含明文 token），放进回执之前调用方必须先过 `maskLine`
 */
export function upsertSource(text: string, entry: SourceEntry): { text: string; wrote: string[]; replaced: boolean } {
  const hadTrailingNewline = text.endsWith('\n') || text === ''
  const lines = text.split('\n')
  // 文本以换行结尾时 split 出的最后一段是空串，追加要插在它前面
  const appendAt = hadTrailingNewline ? lines.length - 1 : lines.length

  const previousScopeLine = scopeAndTokenLinesOf(text).scopes.find((scopeLine) => scopeLine.scope === entry.scope)
  const writtenLines: string[] = [`${entry.scope}:registry=${entry.registry}`]

  if (previousScopeLine !== undefined) {
    lines[previousScopeLine.index] = writtenLines[0]!
  } else {
    lines.splice(appendAt, 0, writtenLines[0]!)
  }

  if (entry.token !== undefined) {
    const key = registryKeyOf(entry.registry)
    const tokenLine = `${key}:_authToken=${entry.token}`
    const existingTokenLine = scopeAndTokenLinesOf(lines.join('\n')).tokens.find((candidate) => candidate.key === key)
    if (existingTokenLine !== undefined) {
      lines[existingTokenLine.index] = tokenLine
    } else {
      lines.splice(appendAt + 1, 0, tokenLine)
    }
    writtenLines.push(tokenLine)
  }

  if (previousScopeLine !== undefined && registryKeyOf(previousScopeLine.registry) !== registryKeyOf(entry.registry)) {
    dropTokenLineIfNoScopePointsTo(lines, previousScopeLine.registry)
  }

  return { text: lines.join('\n'), wrote: writtenLines, replaced: previousScopeLine !== undefined }
}

/** 没有这条 scope 就回 `removed: false`，一个字节都不动 */
export function removeSource(text: string, scope: string): { text: string; removed: boolean; registry?: string } {
  const { scopes } = scopeAndTokenLinesOf(text)
  const scopeLine = scopes.find((candidate) => candidate.scope === scope)
  if (scopeLine === undefined) return { text, removed: false }

  const lines = text.split('\n')
  const registry = scopeLine.registry
  lines.splice(scopeLine.index, 1)
  dropTokenLineIfNoScopePointsTo(lines, registry)
  return { text: lines.join('\n'), removed: true, registry }
}
