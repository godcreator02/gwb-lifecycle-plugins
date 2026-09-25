import type { GwbResult } from '@godcreator/gwb-kernel-desktop'
import { readNpmrc, writeNpmrc } from './home.js'
import { searchRegistry } from './registry.js'
import { mergeScoped, type PluginRow } from './search.js'
import {
  BOOTSTRAP_SCOPE,
  isRegistryUrl,
  isScope,
  maskLine,
  mergeSources,
  parseSources,
  registryFor,
  removeSource as removeSourceLines,
  upsertSource as upsertSourceLines,
} from './sources.js'
import { noteOf, type Outcome } from './vocab.js'

/** 检索成了的回执 */
interface SearchFound {
  /** 全部配好的源上的插件。**空数组 = 查成了、一个都没有**，和「没查成」分得开 */
  packages: PluginRow[]
  /** 有源没查成时，点名是哪几条（其余照常） */
  note?: string
}

/** 写成一条包源的回执。回执经命令总线传出去，`lines` 里的 token 一律已遮掉 */
interface SourceAdded {
  scope: string
  registry: string
  /** token 行写没写（公开源不需要凭据，只写路由行） */
  tokenWritten: boolean
  /** 机器级原来就有这条 scope：这次是原地替换，不是追加 */
  replaced: boolean
  /** 写进去的行（已遮掉 token） */
  lines: string[]
  /** 值得说一声的：home 级有同名 scope 指向别处、pnpm 用的是那一条 */
  note?: string
}

/** 列表里的一条包源。`token` 只报有没有，不报值 */
interface SourceReport {
  scope: string
  registry: string
  /** 来自哪份文件——pnpm 把两层合起来读，只看一层会漏 */
  file: 'user' | 'home'
  token: boolean
}

/** 列包源的回执 */
interface SourceListResult {
  /** 机器级那份 npmrc 的路径（source.add / source.remove 改的就是它） */
  user: string
  /** home 级那份的路径（只读展示；手工加过行才会存在） */
  home: string
  sources: SourceReport[]
}

/** 删掉一条包源的回执 */
interface SourceRemoved {
  scope: string
  /** 被删掉的那条路由指向的源 */
  registry?: string
}

export interface PackageSourcesDeps {
  /** 机器级 npmrc：包源路由的正本，add / remove 改的就是它 */
  userNpmrc: string
  /** home 级 npmrc：只读 */
  homeNpmrc: string
  /** 按名字调别的插件的命令：读 gitea 分区的设置用 `settings.get` */
  runCommand(name: string, args: unknown): Promise<GwbResult>
  log: { info(message: string): void; warn(message: string): void }
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

function assertScopeShape(scope: string): void {
  if (!isScope(scope)) {
    throw new Error(`scope 要写成 @xxx（比如 "@j"），收到的是 ${JSON.stringify(scope)}`)
  }
}

function assertGiteaOwnerShape(owner: string): void {
  if (!/^[\w.-]+$/.test(owner)) {
    throw new Error(`owner 要是 gitea 上的用户名或组织名（字母、数字、连字符），收到 ${JSON.stringify(owner)}`)
  }
}

function registryWithTrailingSlash(registry: string | undefined): string {
  if (!isRegistryUrl(registry)) {
    throw new Error(`registry 要是 http(s) 地址（收到 ${JSON.stringify(registry)}）`)
  }
  return registry.endsWith('/') ? registry : `${registry}/`
}

async function userNpmrcRoutes(deps: PackageSourcesDeps, scope: string, registry: string): Promise<boolean> {
  const routed = parseSources(await readNpmrc(deps.userNpmrc)).find((source) => source.scope === scope)
  return routed !== undefined && routed.registry === registry
}

/** home 级有同名 scope 指向别处时 pnpm 用的是那一条，机器级这条不起作用 */
async function homeNpmrcOverrideNote(deps: PackageSourcesDeps, scope: string, registry: string): Promise<string | undefined> {
  const homeSource = parseSources(await readNpmrc(deps.homeNpmrc)).find((source) => source.scope === scope)
  if (homeSource === undefined || homeSource.registry === registry) return undefined
  return `home 级 ${deps.homeNpmrc} 里也有 ${scope}（指向 ${homeSource.registry}），pnpm 会用那一条；要让这条生效，删掉 home 级那行`
}

export async function addSource(
  deps: PackageSourcesDeps,
  scope: string,
  opts: { registry?: string; owner?: string; token?: string },
): Promise<Outcome<SourceAdded>> {
  // 调用方写错的当场抛；下面每一种「没成」都是正常结果，写进回执
  assertScopeShape(scope)
  if (scope === BOOTSTRAP_SCOPE) {
    throw new Error(`${BOOTSTRAP_SCOPE} 是本机所有 home 与源码仓安装、发版用的源，本命令不改它`)
  }
  const { registry, owner } = opts
  let token = opts.token
  if (registry !== undefined && owner !== undefined) {
    throw new Error('registry 与 owner 只给一个：owner 走 gitea 的简便写法（拼源地址、取 gitea.token），registry 直接给源地址')
  }
  if (registry === undefined && owner === undefined) {
    throw new Error('registry 与 owner 必须给一个：owner 走 gitea 的简便写法（拼源地址、取 gitea.token），registry 直接给源地址')
  }

  const notes: string[] = []
  let resolvedRegistry: string
  if (owner !== undefined) {
    assertGiteaOwnerShape(owner)
    const gitea = await giteaSourceOf(deps, owner)
    if (!gitea.ok) {
      deps.log.warn(`${scope} 的源没加上：${gitea.error}`)
      return { ok: false, error: gitea.error }
    }
    resolvedRegistry = gitea.registry
    if (token === undefined) {
      if (gitea.token === undefined) {
        const error = '取不到 gitea.token（设置里没配，或没装设置插件）。私有源没有凭据装不了——显式传 token，或者先把 token 配进设置的 gitea 分区'
        deps.log.warn(`${scope} 的源没加上：${error}`)
        return { ok: false, error }
      }
      token = gitea.token
    }
  } else {
    resolvedRegistry = registryWithTrailingSlash(registry)
  }

  const applied = upsertSourceLines(await readNpmrc(deps.userNpmrc), {
    scope,
    registry: resolvedRegistry,
    ...(token === undefined ? {} : { token }),
  })
  await writeNpmrc(deps.userNpmrc, applied.text)

  if (!(await userNpmrcRoutes(deps, scope, resolvedRegistry))) {
    const error = `写完重读没读到 ${scope} → ${resolvedRegistry}（写盘异常？）`
    deps.log.warn(error)
    return { ok: false, error }
  }

  const overrideNote = await homeNpmrcOverrideNote(deps, scope, resolvedRegistry)
  if (overrideNote !== undefined) notes.push(overrideNote)

  deps.log.info(`${scope} 的源${applied.replaced ? '换成了' : '加上了'} ${resolvedRegistry}${token === undefined ? '' : '（带凭据）'}，写在机器级 ${deps.userNpmrc}`)
  return {
    ok: true,
    data: {
      scope,
      registry: resolvedRegistry,
      tokenWritten: token !== undefined,
      replaced: applied.replaced,
      lines: applied.wrote.map(maskLine),
      ...noteOf(notes),
    },
  }
}

export async function listSources(deps: PackageSourcesDeps): Promise<SourceListResult> {
  const sources = mergeSources([
    { file: 'user', text: await readNpmrc(deps.userNpmrc) },
    { file: 'home', text: await readNpmrc(deps.homeNpmrc) },
  ])
  return {
    user: deps.userNpmrc,
    home: deps.homeNpmrc,
    // token 只报有没有，值不出去
    sources: sources.map(({ scope, registry, file, token }) => ({ scope, registry, file, token: token !== undefined })),
  }
}

export async function removeSource(deps: PackageSourcesDeps, scope: string): Promise<Outcome<SourceRemoved>> {
  assertScopeShape(scope)
  if (scope === BOOTSTRAP_SCOPE) {
    throw new Error(`${BOOTSTRAP_SCOPE} 是本机所有 home 与源码仓安装、发版用的源，删了它安装和发版都会失败。本命令不删它`)
  }

  const applied = removeSourceLines(await readNpmrc(deps.userNpmrc), scope)
  if (!applied.removed) {
    const onlyInHomeNpmrc = parseSources(await readNpmrc(deps.homeNpmrc)).some((source) => source.scope === scope)
    const error = onlyInHomeNpmrc
      ? `机器级 ${deps.userNpmrc} 里没有 ${scope}——它在 home 级 .npmrc 里（手工加的），本命令只改机器级，那一行要手工删`
      : `机器级 ${deps.userNpmrc} 里没有 ${scope} 这条 scope 路由`
    return { ok: false, error }
  }
  await writeNpmrc(deps.userNpmrc, applied.text)
  deps.log.info(`${scope} 的源从机器级删掉了${applied.registry === undefined ? '' : `（原来指向 ${applied.registry}）`}`)
  return { ok: true, data: { scope, ...(applied.registry === undefined ? {} : { registry: applied.registry }) } }
}

/**
 * owner → 源地址与 token，都从设置的 `gitea` 分区取，经 `settings.get` 命令读（设置服务只读得到调用方自己的分区）。
 * 取不到 http(s) 的 base-url（gitea 插件没装、设置插件没装、没配）就回失败；取不到 token 只是没有 token，由调用方决定
 */
async function giteaSourceOf(deps: PackageSourcesDeps, owner: string): Promise<{ ok: true; registry: string; token?: string } | { ok: false; error: string }> {
  const baseUrlSetting = await deps.runCommand('settings.get', { section: 'gitea', key: 'base-url' })
  if (!baseUrlSetting.ok || typeof baseUrlSetting.data !== 'string' || !isRegistryUrl(baseUrlSetting.data)) {
    const seen = baseUrlSetting.ok ? `读到的是 ${JSON.stringify(baseUrlSetting.data)}` : (baseUrlSetting.error ?? '没说原因')
    return {
      ok: false,
      error: `取不到 http(s) 的设置 gitea.base-url（${seen}），owner 写法拼不出源地址。装上 gitea 插件并配好 base-url，或者改给 registry 直接写源地址`,
    }
  }
  const registry = `${baseUrlSetting.data.replace(/\/+$/, '')}/api/packages/${owner}/npm/`
  let token: string | undefined
  const tokenSetting = await deps.runCommand('settings.get', { section: 'gitea', key: 'token' })
  if (tokenSetting.ok && typeof tokenSetting.data === 'string' && tokenSetting.data !== '') token = tokenSetting.data
  return { ok: true, registry, ...(token === undefined ? {} : { token }) }
}

/** 两层 npmrc 合起来看，home 级同名行优先，和 pnpm 读的顺序一致。只给检索用，值不出这条调用链 */
async function tokenForScope(deps: PackageSourcesDeps, scope: string): Promise<string | undefined> {
  for (const file of [deps.homeNpmrc, deps.userNpmrc]) {
    const source = parseSources(await readNpmrc(file)).find((entry) => entry.scope === scope)
    if (source !== undefined) return source.token
  }
  return undefined
}
