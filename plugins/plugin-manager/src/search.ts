/**
 * npm registry 标准检索协议（`GET <registry>/-/v1/search`）的解析与过滤。纯函数，单独测。
 *
 * **这里不认识任何具体的 registry**——Verdaccio、npmjs、gitea 实现的都是同一份协议；
 * 地址由调用方按 scope 从 npmrc 找（从哪装，就在哪搜）。
 *
 * 返回形状是实测确定的（2026-09-08，`text=@godcreator&size=100`）：顶层 `{ objects, total,
 * time }`，每条 `object.package` 里带 `name` / `version` / `description` / `keywords`。
 * 字段缺失的单条跳过，整份认不出返回 undefined，让调用方给一句能看懂的话。
 *
 * **name 有两种形状**（2026-09-15 实测）：npmjs、verdaccio 把 scope 写在 name 里
 * （`@godcreator/gwb-x`）；gitea 分开放——`package.scope` 是 `"@godcreator"`、`name` 只有
 * `gwb-x`。不统一的话整张表都是短名，包名全是错的。
 *
 * **「是不是插件」看包自己的声明**（2026-09-18 起）：包清单的 `keywords` 里有没有
 * `gwb-plugin`（`isPluginRow`）。这个字段**只有检索响应里有**——单包详情接口会把 keywords
 * 去掉（2026-09-18 实测），所以一次请求就能判断完，不用逐个包再查。名字（scope、`gwb-` 前缀）
 * 不参与判断，**没有兜底**：没写这个关键词的包不进「可装」列表。
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

/**
 * 合并多条源的检索结果：查成的源里的包**按传入顺序**并在一起（顺序由调用方定——生态自己的
 * scope 在前、其余按名字排），没查成的源列进 `failed`，**一条源失败不影响别的**。
 * 包名自带 scope，不会重复，不用去重。
 */
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

/** 这一条是不是插件：只看包自己写的 keywords 里有没有 `PLUGIN_KEYWORD` */
export function isPluginRow(row: SearchRow): boolean {
  return row.keywords.includes(PLUGIN_KEYWORD)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析检索响应。objects 为空 → 空数组；不是这份 JSON → undefined；坏条目只跳过那一条。
 *
 * **响应不统一**：新收录的条目带 `package.version`，旧的一批只有 `dist-tags.latest`
 * （2026-09-08 实测，同一份响应里两种并存）——最新版本优先取前者，没有再取后者。
 */
export function parseSearch(text: string): ParsedSearch {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw) || !Array.isArray(raw['objects'])) return undefined
  const out: SearchRow[] = []
  for (const item of raw['objects']) {
    if (!isRecord(item) || !isRecord(item['package'])) continue
    const rawName = item['package']['name']
    if (typeof rawName !== 'string' || rawName === '') continue
    // gitea 分开放的 scope 拼回全名；name 已经带 @ 的（npmjs、verdaccio）原样用
    const scope = item['package']['scope']
    const pkg =
      typeof scope === 'string' && scope !== '' && !rawName.startsWith('@') ? `${scope}/${rawName}` : rawName
    const row: SearchRow = { pkg, keywords: [] }
    const version = item['package']['version']
    const latest = isRecord(item['package']['dist-tags']) ? item['package']['dist-tags']['latest'] : undefined
    const resolved =
      typeof version === 'string' && version !== ''
        ? version
        : typeof latest === 'string' && latest !== ''
          ? latest
          : undefined
    if (resolved !== undefined) row.version = resolved
    const description = item['package']['description']
    if (typeof description === 'string' && description !== '') row.description = description
    const keywords = item['package']['keywords']
    if (Array.isArray(keywords)) row.keywords = keywords.filter((one): one is string => typeof one === 'string')
    out.push(row)
  }
  return out
}
