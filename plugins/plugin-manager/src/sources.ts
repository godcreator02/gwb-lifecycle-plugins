/**
 * 零 I/O 纯逻辑：市场名单（设置项）对上 pnpm 合并好的配置（home 里运行 `pnpm config list --json`：机器级 `~/.npmrc`、
 * home 级 `<home>/.npmrc`、pnpm 自己的全局配置与环境变量合在一起，装包按的就是这一份），得出每个市场去哪个源查
 */

/** 市场名单这一项设置的键。放公共区（`*`）是为了地址固定：窗格与 agent 改它不用知道插件管理条目的 id；值仍按 home 存 */
export const MARKETS_SETTING_KEY = 'plugin-markets'

/** 新装的机器上名单的默认值：生态自己的 scope */
export const DEFAULT_MARKETS: readonly string[] = ['@godcreator']

/** npm 的 scope 写法：`@` 加小写字母、数字、`.` `_` `-` */
const SCOPE_RE = /^@[a-z0-9][a-z0-9._-]*$/

/** 一个市场去哪查：地址以 `/` 结尾；查不了的带原因 */
export type MarketSource = { ok: true; scope: string; registry: string } | { ok: false; scope: string; error: string }

/** 设置项的值是外部输入：不是字符串数组、有重复都直接报错，不替它修正 */
export function marketsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`设置项 ${MARKETS_SETTING_KEY} 要是字符串数组（每项一个 scope，如 ["@godcreator"]），现在是 ${JSON.stringify(value)}`)
  }
  const duplicated = value.find((scope, index) => value.indexOf(scope) !== index)
  if (duplicated !== undefined) throw new Error(`设置项 ${MARKETS_SETTING_KEY} 里 ${duplicated} 写了不止一次`)
  return value
}

/**
 * 市场的源只认 pnpm 配置里这个 scope 自己的路由 `@scope:registry`：没有路由时 pnpm 会去全局源装，
 * 那不是这个市场，查出来多半是空的，所以报「没配源」而不是去全局源查
 */
export function marketSourceOf(scope: string, pnpmConfig: Readonly<Record<string, unknown>>): MarketSource {
  if (!SCOPE_RE.test(scope)) return { ok: false, scope, error: '不是 scope 的写法：要 @ 开头，后面是小写字母、数字、. _ -，如 @godcreator' }
  const key = `${scope}:registry`
  const registry = pnpmConfig[key]
  if (registry === undefined) {
    return { ok: false, scope, error: `pnpm 里没配这个市场的源：往 ~/.npmrc 加一行 ${key}=<源地址>，私有源再加一行凭据，写法见说明书 gwb-plugin-manager 的「加一个市场」` }
  }
  if (typeof registry !== 'string') return { ok: false, scope, error: `pnpm 配置里 ${key} 的值不是字符串：${JSON.stringify(registry)}` }
  return { ok: true, scope, registry: registry.endsWith('/') ? registry : `${registry}/` }
}

/** 源地址 → pnpm 的凭据键 `//<主机>/<路径>/:_authToken`。凭据按源地址配，不按 scope */
export function authTokenKeyOf(registry: string): string {
  const withoutProtocol = registry.replace(/^https?:\/\//, '')
  return `//${withoutProtocol.endsWith('/') ? withoutProtocol : `${withoutProtocol}/`}:_authToken`
}
