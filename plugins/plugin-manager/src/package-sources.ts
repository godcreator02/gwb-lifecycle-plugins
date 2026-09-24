import type { GwbResult } from '@godcreator/gwb-plugin-api'
import { readNpmrc, writeNpmrc } from './home.js'
import { searchRegistry } from './registry.js'
import { mergeScoped, type SearchRow } from './search.js'
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

/**
 * 找插件、配包源：在配好的 npm 源上搜索插件；往机器级 `~/.npmrc` 增删第三方包源（scope 路由）。
 *
 * 从哪装就在哪搜：registry 地址按 scope 从两份 npmrc 里找（`sources.ts` 的 `registryFor`），
 * 和 pnpm 安装时读的是同一批配置行。**包源写在机器级**：`@godcreator` 的路由本来就在 `~/.npmrc`，
 * 新 home 的安装、源码仓的安装与发版都指向它；home 级那份只读。`@godcreator` 本身不许经这里改或删。
 *
 * 这几条都不改 home，不经 BUSY 检查，也不排进 pnpm 的串行队列。
 */

/** 检索的回执 */
export interface SearchReceipt {
  ok: boolean
  /** 成了才有：全部配好的源（或指定的 scope）上的插件。**空数组 = 查成了、一个都没有**，和「没查成」分得开 */
  packages?: SearchRow[]
  /** 没成时的一句话 */
  error?: string
  /** 成了但有源没查成时，点名是哪几条（其余照常） */
  note?: string
}

/**
 * 写一条包源的回执。`lines` 是这次真正写进去的行，**token 一律已遮掉**——回执经命令总线传出去，
 * 凭据的一个字节都不能带出去。
 */
export interface SourceAddResult {
  ok: boolean
  scope: string
  registry: string
  /** token 行写没写（公开源不需要凭据，只写路由行） */
  tokenWritten: boolean
  /** 机器级原来就有这条 scope：这次是原地替换，不是追加 */
  replaced: boolean
  /** 写进去的行（已遮掉 token） */
  lines?: string[]
  /** 值得说一声的：源地址按默认 gitea 实例拼的、home 级有同名 scope 指向别处、pnpm 用的是那一条 */
  note?: string
  /** 没成时的一句话 */
  error?: string
}

/** 列表里的一条包源。`token` 只报有没有，不报值 */
export interface SourceReport {
  scope: string
  registry: string
  /** 来自哪份文件——pnpm 把两层合起来读，只看一层会漏 */
  file: 'user' | 'home'
  token: boolean
}

/** 列包源的回执 */
export interface SourceListResult {
  /** 机器级那份 npmrc 的路径（source.add / source.remove 改的就是它） */
  user: string
  /** home 级那份的路径（只读展示；手工加过行才会存在） */
  home: string
  sources: SourceReport[]
}

/** 删一条包源的回执 */
export interface SourceRemoveResult {
  ok: boolean
  scope: string
  /** 成了才有：被删掉的那条路由指向的源 */
  registry?: string
  /** 没成时的一句话 */
  error?: string
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

/** 与 gitea 插件设置项 `base-url` 的默认值相同；它没配 base-url 时两边拼出同一个地址 */
const DEFAULT_GITEA_BASE = 'https://git.tianshen02.online:28377'

/**
 * 检索。给了 `scope` 只查那一条；**不给就查全部配好的源**（两层 npmrc 里的所有 scope，
 * @godcreator 在前、其余按名字排）——插件管理窗格的「可装」列表要的就是这个。
 *
 * 逐条源**并发**查（总时长约等于最慢的那一条）；**一条失败不影响别的**：查成的照常并进
 * `packages`，没查成的在 `note` 里点名；全都没查成才 `ok: false`。
 */
export async function searchPlugins(deps: PackageSourcesDeps, scope?: string): Promise<SearchReceipt> {
  if (scope !== undefined) return searchOne(deps, scope)

  const scopes = await configuredScopes(deps)
  const settled = await Promise.all(scopes.map((one) => searchOne(deps, one)))
  const merged = mergeScoped(scopes.map((one, index) => ({ scope: one, ...settled[index]! })))
  if (merged.packages.length === 0 && merged.failed.length === scopes.length) {
    const why = merged.failed.map((failure) => `${failure.scope}：${failure.error}`).join('；')
    return { ok: false, error: `一条源都没查成——${why}` }
  }
  return {
    ok: true,
    packages: merged.packages,
    ...(merged.failed.length === 0
      ? {}
      : { note: `这几条源没查成（其余照常）：${merged.failed.map((failure) => `${failure.scope}（${failure.error}）`).join('、')}` }),
  }
}

/** 配好的全部 scope，去重、顺序固定：@godcreator 永远第一（npmrc 里一条都没有时它走全局源），其余按名字排 */
async function configuredScopes(deps: PackageSourcesDeps): Promise<string[]> {
  const seen = new Set<string>()
  for (const text of [await readNpmrc(deps.userNpmrc), await readNpmrc(deps.homeNpmrc)]) {
    for (const { scope } of parseSources(text)) seen.add(scope)
  }
  return [BOOTSTRAP_SCOPE, ...[...seen].filter((scope) => scope !== BOOTSTRAP_SCOPE).sort()]
}

/** 查一条源。地址按 scope 从 npmrc 找 */
async function searchOne(deps: PackageSourcesDeps, scope: string): Promise<SearchReceipt> {
  if (!isScope(scope)) {
    return { ok: false, error: `scope 要写成 @xxx（比如 "@j"），收到的是 ${JSON.stringify(scope)}` }
  }
  const registry = registryFor(scope, { home: await readNpmrc(deps.homeNpmrc), user: await readNpmrc(deps.userNpmrc) })
  return searchRegistry(registry, scope, await tokenForScope(deps, scope))
}

export async function addSource(
  deps: PackageSourcesDeps,
  scope: string,
  opts: { registry?: string; owner?: string; token?: string },
): Promise<SourceAddResult> {
  // 调用方写错的当场抛；下面每一种「没成」都是正常结果，写进回执
  if (!isScope(scope)) {
    throw new Error(`scope 要写成 @xxx（比如 "@j"），收到的是 ${JSON.stringify(scope)}`)
  }
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
  let resolved: string
  if (owner !== undefined) {
    if (!/^[\w.-]+$/.test(owner)) {
      throw new Error(`owner 要是 gitea 上的用户名或组织名（字母、数字、连字符），收到 ${JSON.stringify(owner)}`)
    }
    const gitea = await giteaSourceOf(deps, owner)
    resolved = gitea.registry
    if (token === undefined) {
      if (gitea.token === undefined) {
        const error = '取不到 gitea.token（设置里没配，或没装设置插件）。私有源没有凭据装不了——显式传 token，或者先把 token 配进设置的 gitea 分区'
        deps.log.warn(`${scope} 的源没加上：${error}`)
        return { ok: false, scope, registry: resolved, tokenWritten: false, replaced: false, error }
      }
      token = gitea.token
    }
    if (gitea.note !== undefined) notes.push(gitea.note)
  } else {
    if (!isRegistryUrl(registry)) {
      throw new Error(`registry 要是 http(s) 地址（收到 ${JSON.stringify(registry)}）`)
    }
    resolved = registry.endsWith('/') ? registry : `${registry}/`
  }

  const current = await readNpmrc(deps.userNpmrc)
  const applied = upsertSourceLines(current, {
    scope,
    registry: resolved,
    ...(token === undefined ? {} : { token }),
  })
  await writeNpmrc(deps.userNpmrc, applied.text)

  // 写完重读一遍：写进去的行必须在（原子写之后理论上不会不在，出了就是磁盘的问题）
  const reread = parseSources(await readNpmrc(deps.userNpmrc)).find((hit) => hit.scope === scope)
  if (reread === undefined || reread.registry !== resolved) {
    const error = `写完重读没读到 ${scope} → ${resolved}（写盘异常？）`
    deps.log.warn(error)
    return { ok: false, scope, registry: resolved, tokenWritten: token !== undefined, replaced: applied.replaced, error }
  }

  // home 级有同名 scope 时 pnpm 用的是 home 级那条，机器级这条不起作用
  const shadow = parseSources(await readNpmrc(deps.homeNpmrc)).find((hit) => hit.scope === scope)
  if (shadow !== undefined && shadow.registry !== resolved) {
    notes.push(`home 级 ${deps.homeNpmrc} 里也有 ${scope}（指向 ${shadow.registry}），pnpm 会用那一条；要让这条生效，删掉 home 级那行`)
  }

  deps.log.info(`${scope} 的源${applied.replaced ? '换成了' : '加上了'} ${resolved}${token === undefined ? '' : '（带凭据）'}，写在机器级 ${deps.userNpmrc}`)
  return {
    ok: true,
    scope,
    registry: resolved,
    tokenWritten: token !== undefined,
    replaced: applied.replaced,
    lines: applied.wrote.map(maskLine),
    ...noteOf(notes),
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

export async function removeSource(deps: PackageSourcesDeps, scope: string): Promise<SourceRemoveResult> {
  if (!isScope(scope)) {
    throw new Error(`scope 要写成 @xxx（比如 "@j"），收到的是 ${JSON.stringify(scope)}`)
  }
  if (scope === BOOTSTRAP_SCOPE) {
    throw new Error(`${BOOTSTRAP_SCOPE} 是本机所有 home 与源码仓安装、发版用的源，删了它安装和发版都会失败。本命令不删它`)
  }

  const applied = removeSourceLines(await readNpmrc(deps.userNpmrc), scope)
  if (!applied.removed) {
    const inHome = parseSources(await readNpmrc(deps.homeNpmrc)).some((hit) => hit.scope === scope)
    const error = inHome
      ? `机器级 ${deps.userNpmrc} 里没有 ${scope}——它在 home 级 .npmrc 里（手工加的），本命令只改机器级，那一行要手工删`
      : `机器级 ${deps.userNpmrc} 里没有 ${scope} 这条 scope 路由`
    return { ok: false, scope, error }
  }
  await writeNpmrc(deps.userNpmrc, applied.text)
  deps.log.info(`${scope} 的源从机器级删掉了${applied.registry === undefined ? '' : `（原来指向 ${applied.registry}）`}`)
  return { ok: true, scope, ...(applied.registry === undefined ? {} : { registry: applied.registry }) }
}

/**
 * gitea 的简便写法：owner → 源地址与 token。token 与 base-url 都从设置的 `gitea` 分区取，
 * 经 `settings.get` 命令按位置读（设置服务只读得到调用方自己的分区，读别的分区要走命令）。
 * 设置插件没装、设置里没配，都只是退回默认实例、没有 token，不抛。
 */
async function giteaSourceOf(deps: PackageSourcesDeps, owner: string): Promise<{ registry: string; token?: string; note?: string }> {
  const notes: string[] = []
  let base = DEFAULT_GITEA_BASE
  const got = await deps.runCommand('settings.get', { section: 'gitea', key: 'base-url' })
  if (got.ok && typeof got.data === 'string' && isRegistryUrl(got.data)) base = got.data
  else notes.push('设置里没有 gitea.base-url，源地址按默认实例拼')
  const registry = `${base.replace(/\/+$/, '')}/api/packages/${owner}/npm/`
  let token: string | undefined
  const tokenGot = await deps.runCommand('settings.get', { section: 'gitea', key: 'token' })
  if (tokenGot.ok && typeof tokenGot.data === 'string' && tokenGot.data !== '') token = tokenGot.data
  return { registry, ...(token === undefined ? {} : { token }), ...noteOf(notes) }
}

/**
 * 这条 scope 现在有没有凭据：两层 npmrc 合起来看，home 级同名行优先，和 pnpm 读的顺序一致。
 * 只给检索用，值不出这条调用链
 */
async function tokenForScope(deps: PackageSourcesDeps, scope: string): Promise<string | undefined> {
  for (const file of [deps.homeNpmrc, deps.userNpmrc]) {
    const hit = parseSources(await readNpmrc(file)).find((entry) => entry.scope === scope)
    if (hit !== undefined) return hit.token
  }
  return undefined
}

/** 回执里的 `note`：没话说就没有这一项 */
function noteOf(notes: readonly string[]): { note?: string } {
  return notes.length === 0 ? {} : { note: notes.join('；') }
}
