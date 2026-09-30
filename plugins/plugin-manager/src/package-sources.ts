import { searchRegistry } from './registry.js'
import type { MarketStatus, Outcome, PluginRow, SearchFound } from './receipts.js'
import { mergeScoped, type ScopedSearch } from './search.js'
import { authTokenKeyOf, marketSourceOf, marketsOf, MARKETS_SETTING_KEY } from './sources.js'

/** `search` 要的三样：市场名单、pnpm 合并好的配置、某条源的凭据 */
export interface PackageSourcesDeps {
  /** 设置项 `plugin-markets` 的值，原样给 */
  markets: unknown
  readPnpmConfig(): Promise<Outcome<Record<string, unknown>>>
  /** 读 pnpm 配置里的一个键（凭据）；没配是 undefined */
  readPnpmConfigValue(key: string): Promise<string | undefined>
}

/** 名单里的市场并发查，一个失败只进 `note` 与它自己的状态，全都没查成才 `ok: false` */
export async function searchPlugins(deps: PackageSourcesDeps): Promise<Outcome<SearchFound>> {
  const markets = marketsOf(deps.markets)
  if (markets.length === 0) return { ok: false, error: `市场名单是空的：公共区的设置项 ${MARKETS_SETTING_KEY} 至少要有一个 scope，如 ["@godcreator"]` }
  const pnpmConfig = await deps.readPnpmConfig()
  if (!pnpmConfig.ok) return { ok: false, error: `问 pnpm 要配置没成：${pnpmConfig.error}` }

  const searched = await Promise.all(markets.map((scope) => searchMarket(deps, pnpmConfig.data, scope)))
  const merged = mergeScoped(searched.map(({ result }) => result))
  if (merged.failed.length === markets.length) {
    return { ok: false, error: `一个市场都没查成——${merged.failed.map((failure) => `${failure.scope}：${failure.error}`).join('；')}` }
  }
  return {
    ok: true,
    data: {
      packages: merged.packages,
      markets: searched.map(({ status }) => status),
      ...(merged.failed.length === 0
        ? {}
        : { note: `这几个市场没查成（其余照常）：${merged.failed.map((failure) => `${failure.scope}（${failure.error}）`).join('、')}` }),
    },
  }
}

async function searchMarket(
  deps: PackageSourcesDeps,
  pnpmConfig: Readonly<Record<string, unknown>>,
  scope: string,
): Promise<{ result: ScopedSearch; status: MarketStatus }> {
  const source = marketSourceOf(scope, pnpmConfig)
  if (!source.ok) return { result: { scope, ok: false, error: source.error }, status: { scope, ok: false, error: source.error } }
  const receipt = await searchRegistry(source.registry, scope, await deps.readPnpmConfigValue(authTokenKeyOf(source.registry)))
  if (!receipt.ok) {
    return { result: { scope, ok: false, error: receipt.error }, status: { scope, registry: source.registry, ok: false, error: receipt.error } }
  }
  const packages: PluginRow[] = receipt.data
  return { result: { scope, ok: true, packages }, status: { scope, registry: source.registry, ok: true, count: packages.length } }
}
