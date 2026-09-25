/**
 * 零 I/O 纯逻辑，只读 npmrc。认三种行，其余（注释、空行、别的配置）跳过：
 * `@j:registry=https://host/api/packages/J/npm/`、`//host/api/packages/J/npm/:_authToken=shxxx`、`registry=https://registry.npmjs.org/`。
 * token 行按源地址配对、不按 scope（同一个 token 可以配好几条源）
 */

/** 一条 scope 路由；token 只给检索用，不进任何回执 */
export interface SourceEntry {
  scope: string
  registry: string
  token?: string
}

/** `@scope:registry=<url>` */
const SCOPE_LINE_RE = /^(@[\w.-]+):registry=(\S+)$/

/** `//<host/path>/:_authToken=<token>`。键里没有协议，配对靠 `registryKeyOf` */
const TOKEN_LINE_RE = /^(\/\/\S+?):_authToken=(\S+)$/

/** `registry=<url>`，没有单独配置的 scope 都从这里装 */
const GLOBAL_LINE_RE = /^registry=(\S+)$/

/** npm 官方源。两份 npmrc 都没写 `registry=` 时 pnpm 用的就是它 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** 生态自己的 scope：`search` 总是第一个查它，npmrc 里没写它时它走全局源 */
export const BOOTSTRAP_SCOPE = '@godcreator'

/** http(s) 开头、没有空白。源长什么样由 pnpm 判断 */
function isRegistryUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/\S+$/.test(value)
}

/** 源地址 → token 行的键：去掉协议、补上结尾斜杠，与 `TOKEN_LINE_RE` 捕获的键形状相同 */
export function registryKeyOf(registry: string): string {
  const withoutProtocol = registry.replace(/^https?:\/\//, '')
  return `//${withoutProtocol.endsWith('/') ? withoutProtocol : `${withoutProtocol}/`}`
}

/** 一份 npmrc 文本里的全部 scope 路由，token 按 `registryKeyOf` 配上 */
export function parseSources(text: string): SourceEntry[] {
  const scopes: { scope: string; registry: string }[] = []
  const tokens: { key: string; token: string }[] = []
  for (const line of text.split('\n')) {
    const scopeMatch = SCOPE_LINE_RE.exec(line)
    if (scopeMatch !== null) {
      scopes.push({ scope: scopeMatch[1]!, registry: scopeMatch[2]! })
      continue
    }
    const tokenMatch = TOKEN_LINE_RE.exec(line)
    if (tokenMatch !== null) tokens.push({ key: tokenMatch[1]!, token: tokenMatch[2]! })
  }
  return scopes.map(({ scope, registry }) => ({
    scope,
    registry,
    token: tokens.find((token) => token.key === registryKeyOf(registry))?.token,
  }))
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
