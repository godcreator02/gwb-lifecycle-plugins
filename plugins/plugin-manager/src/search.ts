/**
 * npm registry 检索协议 `GET <registry>/-/v1/search` 的响应：`{ objects, total, time }`，每条 `object.package`
 * 带 name / version / description / keywords。keywords 只在检索响应里有，单包详情接口会去掉它
 */

/** 插件在包清单 `keywords` 里写的关键词。库、共享包没有它 */
export const PLUGIN_KEYWORD = 'gwb-plugin'

/** 检索出来的一条：包名、registry 上的最新版本、一句简介、包自己写的 keywords */
export interface SearchRow {
  pkg: string
  version?: string
  description?: string
  /** 包清单里写的 keywords；registry 没给、不是数组、元素不是字符串的都滤掉 */
  keywords: string[]
}

/** 整份响应认不出时是 undefined，和「查成了但没有结果」（空数组）分得开 */
export type ParsedSearch = SearchRow[] | undefined

/** 一条源查完的结果，合并前的输入。没查成的源也在里面（`ok: false` 带 error），由 `mergeScoped` 分开 */
export interface ScopedSearch {
  scope: string
  ok: boolean
  packages?: SearchRow[]
  error?: string
}

/** 查成的源里的包按传入顺序并在一起（包名自带 scope，不用去重），没查成的列进 `failed` */
export function mergeScoped(results: readonly ScopedSearch[]): {
  packages: SearchRow[]
  failed: { scope: string; error: string }[]
} {
  const packages: SearchRow[] = []
  const failed: { scope: string; error: string }[] = []
  for (const result of results) {
    if (result.ok && result.packages !== undefined) packages.push(...result.packages)
    else failed.push({ scope: result.scope, error: result.error ?? '没说原因' })
  }
  return { packages, failed }
}

/** 是不是插件只看包自己写的 keywords，名字不参与判断 */
export function isPluginRow(row: SearchRow): boolean {
  return row.keywords.includes(PLUGIN_KEYWORD)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** gitea 把 scope 与名字分开放（`scope: "@godcreator"`、`name: "gwb-x"`），拼回全名；name 已带 @ 的原样用 */
function fullPackageNameOf(name: string, scope: unknown): string {
  return isNonEmptyString(scope) && !name.startsWith('@') ? `${scope}/${name}` : name
}

/** 同一份响应里新条目带 `version`，旧的一批只有 `dist-tags.latest`：前者优先 */
function latestVersionOf(packageInfo: Record<string, unknown>): string | undefined {
  const version = packageInfo['version']
  const distTagLatest = isRecord(packageInfo['dist-tags']) ? packageInfo['dist-tags']['latest'] : undefined
  if (isNonEmptyString(version)) return version
  if (isNonEmptyString(distTagLatest)) return distTagLatest
  return undefined
}

function searchRowOf(packageInfo: Record<string, unknown>, name: string): SearchRow {
  const row: SearchRow = { pkg: fullPackageNameOf(name, packageInfo['scope']), keywords: [] }
  const latestVersion = latestVersionOf(packageInfo)
  if (latestVersion !== undefined) row.version = latestVersion
  const description = packageInfo['description']
  if (isNonEmptyString(description)) row.description = description
  const keywords = packageInfo['keywords']
  if (Array.isArray(keywords)) row.keywords = keywords.filter((keyword): keyword is string => typeof keyword === 'string')
  return row
}

/** objects 为空 → 空数组；整份不是这种 JSON → undefined；坏条目只跳过那一条 */
export function parseSearch(text: string): ParsedSearch {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['objects'])) return undefined
  const rows: SearchRow[] = []
  for (const item of parsed['objects']) {
    if (!isRecord(item) || !isRecord(item['package'])) continue
    const name = item['package']['name']
    if (!isNonEmptyString(name)) continue
    rows.push(searchRowOf(item['package'], name))
  }
  return rows
}
