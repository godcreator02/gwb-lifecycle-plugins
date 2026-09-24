import { isPluginRow, parseSearch, type SearchRow } from './search.js'

/** 调 npm registry 的检索接口 `GET <registry>/-/v1/search`：网络请求只在这里，响应的解析与「是不是插件」的判断在 `search.ts` */

/** 一条源最多等这么久。等不到只算这一条没查成，别的源照常 */
const SEARCH_TIMEOUT_MS = 10_000

/** 一条源一次最多列这么多个包 */
const SEARCH_PAGE_SIZE = 250

export type RegistrySearchResult = { ok: true; packages: SearchRow[] } | { ok: false; error: string }

/**
 * 查一条源上某个 scope 下的插件。`registry` 以 `/` 结尾；这条源配了凭据就带上，私有源的检索接口未必允许匿名。
 * 没查成（连不上、超时、非 2xx、响应认不出）都回 `ok: false` 带原因，由调用方和别的源的结果合并
 */
export async function searchRegistry(registry: string, scope: string, token: string | undefined): Promise<RegistrySearchResult> {
  // text 固定为 scope：列出这个 scope 下的全部包；是不是插件在解析后按 keywords 判断
  const url = `${registry}-/v1/search?text=${encodeURIComponent(scope)}&size=${String(SEARCH_PAGE_SIZE)}`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
    })
    if (!response.ok) return { ok: false, error: `registry 返回 ${String(response.status)}（${url}）` }
    const rows = parseSearch(await response.text())
    if (rows === undefined) {
      return { ok: false, error: '检索响应认不出来（要的是 npm registry 的检索 JSON）。' }
    }
    return { ok: true, packages: rows.filter(isPluginRow) }
  } catch (err: unknown) {
    return { ok: false, error: `检索没成（${String(SEARCH_TIMEOUT_MS / 1000)} 秒内没有响应，或连不上源）：${String(err)}` }
  }
}
