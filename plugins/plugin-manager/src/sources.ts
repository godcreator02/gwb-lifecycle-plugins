/**
 * npmrc 里 scope 路由的解析、增改、删除，以及按 scope 找 registry 地址。零 I/O 纯逻辑：
 * 磁盘上那两份文件（机器级 `~/.npmrc` 与 home 级 `<home>/.npmrc`）的读写在 `home.ts`，这里只处理文本。
 *
 * 只认三种行，其余（注释、空行、`electron_mirror=` 这类别的配置）原样保留：
 *
 * ```
 * @j:registry=https://host/api/packages/J/npm/
 * //host/api/packages/J/npm/:_authToken=shxxx
 * registry=https://registry.npmjs.org/
 * ```
 *
 * **token 行按「源的地址」配对，不按 scope**：同一个 token 可以配好几条源（本机的
 * `@godcreator` 与 `@j` 就共用一个 gitea token）。所以换源、删源时，那条 token 行只有在
 * **没有任何别的 scope 还指向同一个地址**时才一起删掉，否则留下——删掉别人还在用的凭据会让
 * 安装失败，多留一行没人用的只是占一行。
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

/** scope 的形状：`@` 开头，不带 `/`。npm 规定小写，但 gitea 源上 `@j` 这种大写实际能用，
 * 这里不比 pnpm 更严——只拦手滑写成包名（`@a/b`）或忘了 `@` */
const SCOPE_RE = /^@[\w.-]+$/

/** 一行 scope 路由：`@scope:registry=<url>` */
const SCOPE_LINE_RE = /^(@[\w.-]+):registry=(\S+)$/

/** 一行凭据：`//<host/path>/:_authToken=<token>`。键里没有协议，配对靠 `registryKeyOf` */
const TOKEN_LINE_RE = /^(\/\/\S+?):_authToken=(\S+)$/

/** 一行全局源：`registry=<url>`，没有单独配置的 scope 都从这里装 */
const GLOBAL_LINE_RE = /^registry=(\S+)$/

/** npm 官方源。两份 npmrc 都没写 `registry=` 时 pnpm 用的就是它 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** 生态自己的 scope：本机所有 home 的安装、所有源码仓的安装与发版都指向它，插件管理不许改、不许删 */
export const BOOTSTRAP_SCOPE = '@godcreator'

export function isScope(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_RE.test(value)
}

/** 源地址的形状：http(s) 开头、没有空白。不深究更多，源长什么样由 pnpm 判断 */
export function isRegistryUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/\S+$/.test(value)
}

/**
 * 源地址 → token 行的键。`https://h/p/npm/` 与 `https://h/p/npm`（没斜杠）是同一条源，
 * 键必须统一：去掉协议、补上结尾斜杠。返回**带 `//` 前缀、不带 `:_authToken`** 的那一段，
 * 与 `TOKEN_LINE_RE` 捕获的键形状相同，可以直接比较。
 */
export function registryKeyOf(registry: string): string {
  const bare = registry.replace(/^https?:\/\//, '')
  return `//${bare.endsWith('/') ? bare : `${bare}/`}`
}

/** 回执里可以给人看的一行：token 的值换成 `***`，不带长度也不带前缀 */
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

function classify(text: string): { scopes: ScopeLine[]; tokens: TokenLine[] } {
  const scopes: ScopeLine[] = []
  const tokens: TokenLine[] = []
  text.split('\n').forEach((line, index) => {
    const scope = SCOPE_LINE_RE.exec(line)
    if (scope !== null) {
      scopes.push({ scope: scope[1]!, registry: scope[2]!, index })
      return
    }
    const token = TOKEN_LINE_RE.exec(line)
    if (token !== null) tokens.push({ key: token[1]!, token: token[2]!, index })
  })
  return { scopes, tokens }
}

/** 一份 npmrc 文本里的全部 scope 路由。token 按 `registryKeyOf` 配上；配不上就没有 */
export function parseSources(text: string): SourceEntry[] {
  const { scopes, tokens } = classify(text)
  return scopes.map(({ scope, registry }) => ({
    scope,
    registry,
    token: tokens.find((token) => token.key === registryKeyOf(registry))?.token,
  }))
}

/** 几份 npmrc 合起来看：逐份解析、带上出处，保持传入的顺序（先机器级后 home 级由调用方安排） */
export function mergeSources(parts: readonly { file: 'user' | 'home'; text: string }[]): SourceView[] {
  return parts.flatMap(({ file, text }) => parseSources(text).map((entry) => ({ ...entry, file })))
}

/** 一份 npmrc 文本里的 `registry=` 那一行；没有就是 undefined */
function globalRegistryOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const hit = GLOBAL_LINE_RE.exec(line.trim())
    if (hit !== null && isRegistryUrl(hit[1])) return hit[1]
  }
  return undefined
}

/**
 * 这个 scope 的包从哪个 registry 装，照 pnpm 读这两份文件的优先级：先找 `@scope:registry=`，
 * 再找 `registry=`，每一种都是 home 级优先于机器级；都没有就是 npm 官方源。返回的地址以 `/` 结尾。
 *
 * 只看这两份文件：用环境变量或 pnpm 全局配置指定的源，这里看不到。
 */
export function registryFor(scope: string, layers: { home: string; user: string }): string {
  const scoped =
    parseSources(layers.home).find((hit) => hit.scope === scope)?.registry ??
    parseSources(layers.user).find((hit) => hit.scope === scope)?.registry
  const found = scoped ?? globalRegistryOf(layers.home) ?? globalRegistryOf(layers.user) ?? DEFAULT_REGISTRY
  return found.endsWith('/') ? found : `${found}/`
}

/** 这些行里还有没有 scope 指向这条源——决定 token 行要不要一起删 */
function stillReferenced(lines: readonly string[], registry: string): boolean {
  const key = registryKeyOf(registry)
  return lines.some((line) => {
    const hit = SCOPE_LINE_RE.exec(line)
    return hit !== null && registryKeyOf(hit[2]!) === key
  })
}

/**
 * 写入或替换一条 scope 路由（幂等：已有就原地替换，没有就追加到末尾）。`token` 没给就
 * 只动路由行——公开源不需要凭据，也不该替调用方猜一条。
 *
 * 换源时**旧源的 token 行**如果已经没有别的 scope 指向它，一起删掉；还有就留着（见文件开头）。
 * `wrote` 是这次真正写进去的行（含明文 token），放进回执之前调用方必须先过 `maskLine`。
 */
export function upsertSource(text: string, entry: SourceEntry): { text: string; wrote: string[]; replaced: boolean } {
  const hadTrailingNewline = text.endsWith('\n') || text === ''
  const lines = text.split('\n')
  // 文本以换行结尾时 split 出的最后一段是空串——追加要插在它前面，别多出一行空白
  const appendAt = hadTrailingNewline ? lines.length - 1 : lines.length

  const previous = classify(text).scopes.find((hit) => hit.scope === entry.scope)
  const wrote: string[] = [`${entry.scope}:registry=${entry.registry}`]

  if (previous !== undefined) {
    lines[previous.index] = wrote[0]!
  } else {
    lines.splice(appendAt, 0, wrote[0]!)
  }

  if (entry.token !== undefined) {
    const key = registryKeyOf(entry.registry)
    const tokenLine = `${key}:_authToken=${entry.token}`
    const existing = classify(lines.join('\n')).tokens.find((hit) => hit.key === key)
    if (existing !== undefined) {
      lines[existing.index] = tokenLine
    } else {
      lines.splice(appendAt + 1, 0, tokenLine)
    }
    wrote.push(tokenLine)
  }

  // 旧源没人指向了才删它的 token；追加之后行号变了，按内容删而不是按旧下标
  if (previous !== undefined && registryKeyOf(previous.registry) !== registryKeyOf(entry.registry)) {
    const oldKey = registryKeyOf(previous.registry)
    if (!stillReferenced(lines, previous.registry)) {
      const at = lines.findIndex((line) => TOKEN_LINE_RE.test(line) && TOKEN_LINE_RE.exec(line)![1] === oldKey)
      if (at !== -1) lines.splice(at, 1)
    }
  }

  return { text: lines.join('\n'), wrote, replaced: previous !== undefined }
}

/**
 * 删掉一条 scope 路由。token 行同样只在没人指向时一起删。没有这条 scope 就返回 `removed: false`，
 * 一个字节都不动——调用方据此在回执里说明「机器级没有这条」。
 */
export function removeSource(text: string, scope: string): { text: string; removed: boolean; registry?: string } {
  const { scopes } = classify(text)
  const hit = scopes.find((candidate) => candidate.scope === scope)
  if (hit === undefined) return { text, removed: false }

  const lines = text.split('\n')
  const registry = hit.registry
  lines.splice(hit.index, 1)
  if (!stillReferenced(lines, registry)) {
    const key = registryKeyOf(registry)
    const at = lines.findIndex((line) => TOKEN_LINE_RE.test(line) && TOKEN_LINE_RE.exec(line)![1] === key)
    if (at !== -1) lines.splice(at, 1)
  }
  return { text: lines.join('\n'), removed: true, registry }
}
