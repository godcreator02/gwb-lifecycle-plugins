import { readNpmrc } from './home.js'
import { searchRegistry } from './registry.js'
import type { Outcome, PluginRow, SearchFound } from './receipts.js'
import { mergeScoped } from './search.js'
import { BOOTSTRAP_SCOPE, parseSources, registryFor } from './sources.js'

/** `search` 读的两份 npmrc，只读不写 */
export interface PackageSourcesDeps {
  /** 机器级 `~/.npmrc` */
  userNpmrc: string
  /** home 级 `<home>/.npmrc` */
  homeNpmrc: string
}

/** 并发查全部配好的源，一条失败只进 `note`，全都没查成才 `ok: false` */
export async function searchPlugins(deps: PackageSourcesDeps): Promise<Outcome<SearchFound>> {
  const scopes = await configuredScopes(deps)
  const receiptsInScopeOrder = await Promise.all(scopes.map((one) => searchOne(deps, one)))
  const merged = mergeScoped(
    scopes.map((one, index) => {
      const receipt = receiptsInScopeOrder[index]!
      return receipt.ok ? { scope: one, ok: true, packages: receipt.data } : { scope: one, ok: false, error: receipt.error }
    }),
  )
  if (merged.packages.length === 0 && merged.failed.length === scopes.length) {
    const failureSummary = merged.failed.map((failure) => `${failure.scope}：${failure.error}`).join('；')
    return { ok: false, error: `一条源都没查成——${failureSummary}` }
  }
  return {
    ok: true,
    data: {
      packages: merged.packages,
      ...(merged.failed.length === 0
        ? {}
        : { note: `这几条源没查成（其余照常）：${merged.failed.map((failure) => `${failure.scope}（${failure.error}）`).join('、')}` }),
    },
  }
}

/** 去重、顺序固定：@godcreator 永远第一（npmrc 里一条都没有时它走全局源），其余按名字排 */
async function configuredScopes(deps: PackageSourcesDeps): Promise<string[]> {
  const scopesInNpmrc = new Set<string>()
  for (const text of [await readNpmrc(deps.userNpmrc), await readNpmrc(deps.homeNpmrc)]) {
    for (const { scope } of parseSources(text)) scopesInNpmrc.add(scope)
  }
  return [BOOTSTRAP_SCOPE, ...[...scopesInNpmrc].filter((scope) => scope !== BOOTSTRAP_SCOPE).sort()]
}

/** `scope` 来自 npmrc 的路由行，形状已由解析保证 */
async function searchOne(deps: PackageSourcesDeps, scope: string): Promise<Outcome<PluginRow[]>> {
  const registry = registryFor(scope, { home: await readNpmrc(deps.homeNpmrc), user: await readNpmrc(deps.userNpmrc) })
  return searchRegistry(registry, scope, await tokenForScope(deps, scope))
}

/** 两层 npmrc 合起来看，home 级同名行优先，和 pnpm 读的顺序一致。只给检索用，值不出这条调用链 */
async function tokenForScope(deps: PackageSourcesDeps, scope: string): Promise<string | undefined> {
  for (const file of [deps.homeNpmrc, deps.userNpmrc]) {
    const source = parseSources(await readNpmrc(file)).find((entry) => entry.scope === scope)
    if (source !== undefined) return source.token
  }
  return undefined
}
