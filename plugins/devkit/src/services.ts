/**
 * 依赖 cordis 4.0.0-rc.9 的这几个字段（不是文档化接口）：`Fiber.store: Dict<Impl>`，`Impl = { name, fiber, value, check }`；
 * `fiber.parent`、`fiber.entry`（loader 补的，`entry.id` 是条目名、`entry.options.name` 是包名）、`ctx.registry.entries()`、
 * `runtime.fibers`、`runtime.name`。形状对不上就当没有、回空表，不抛
 */

/** 一条：某个服务是谁提供的 */
export interface ServiceOwner {
  /** 服务名，如 `gwbShell` */
  service: string
  /** cordis.yml 里的条目名（`home:shell` 这种）；内核自己提供的、内层注入的都没有 */
  entryId?: string
  /** 提供者的包名（条目上的 `name`）；条目不在时退回插件自报的名字 */
  pkg?: string
  /** 那个包在自己 `package.json` 的 `gwb.provides` 里写的 summary 与 usage；没写的服务照样列出来，只是不带用法 */
  provides?: ServiceProvides
}

/** `gwb.provides` 里一条声明的形状 */
export interface ServiceProvides {
  summary: string
  usage: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 只收这个 fiber 自己提供的：注入作用域的 fiber 里也放着解析来的 impl（它消费的服务），
 * 判据与 cordis 相同，`impl.fiber === fiber` 才算。少了这一道，消费方会被报成提供方
 */
function recordOwnersProvidedBy(fiber: Record<string, unknown>, ownersByKey: Map<string, ServiceOwner>): void {
  const store = asRecord(fiber['store'])
  if (store === undefined) return
  const entry = asRecord(fiber['entry'])
  const options = asRecord(entry?.['options'])
  const runtime = asRecord(fiber['runtime'])
  const entryId = asString(entry?.['id'])
  const pkg = asString(options?.['name']) ?? asString(runtime?.['name'])
  for (const storedImpl of Object.values(store)) {
    const impl = asRecord(storedImpl)
    if (impl === undefined) continue
    if (asRecord(impl['fiber']) !== fiber) continue
    const service = asString(impl['name'])
    if (service === undefined) continue
    const owner: ServiceOwner = {
      service,
      ...(entryId === undefined ? {} : { entryId }),
      ...(pkg === undefined ? {} : { pkg }),
    }
    const dedupeKey = [service, entryId ?? '', pkg ?? ''].join('\u0000')
    if (!ownersByKey.has(dedupeKey)) ownersByKey.set(dedupeKey, owner)
  }
}

/** 沿 parent 往上走的层数上限：正常 home 就几层，防形状认错时绕圈 */
const MAX_DEPTH = 32

/** 这一次查询看见了多少东西：回空表时靠它说清「是没看见，还是看见了但表是空的」 */
export interface ServiceSight {
  /** 从自己的 fiber 沿 parent 往上走了几层 */
  chainDepth: number
  /** `registry.entries()` 里的插件数 */
  runtimes: number
  /** 这些插件的 fiber 数 */
  fibers: number
  /** 看见的服务表张数（`Fiber.store` 存在的 fiber 数量，含链上的） */
  stores: number
}

/** 根上提供的服务（`gwbKernel` 这类没有条目）只在这条链上看得到 */
function walkParentChain(root: Record<string, unknown>, saw: ServiceSight, ownersByKey: Map<string, ServiceOwner>): void {
  let fiber = asRecord(root['fiber'])
  for (let depth = 0; fiber !== undefined && depth < MAX_DEPTH; depth++) {
    saw.chainDepth = depth + 1
    if (asRecord(fiber['store']) !== undefined) saw.stores += 1
    recordOwnersProvidedBy(fiber, ownersByKey)
    fiber = asRecord(asRecord(fiber['parent'])?.['fiber'])
  }
}

function walkRegistryFibers(root: Record<string, unknown>, saw: ServiceSight, ownersByKey: Map<string, ServiceOwner>): void {
  const registry = asRecord(root['registry'])
  const entries = registry?.['entries']
  if (typeof entries !== 'function') return
  for (const row of entries.call(registry) as Iterable<unknown>) {
    const runtime = Array.isArray(row) ? asRecord(row[1]) : asRecord(row)
    if (runtime === undefined) continue
    saw.runtimes += 1
    const fibers = runtime['fibers']
    if (fibers === undefined || fibers === null) continue
    for (const storedFiber of fibers as Iterable<unknown>) {
      const fiber = asRecord(storedFiber)
      if (fiber === undefined) continue
      saw.fibers += 1
      if (asRecord(fiber['store']) !== undefined) saw.stores += 1
      recordOwnersProvidedBy(fiber, ownersByKey)
    }
  }
}

export function serviceSight(ctx: unknown): { owners: ServiceOwner[]; saw: ServiceSight } {
  const root = asRecord(ctx)
  const saw: ServiceSight = { chainDepth: 0, runtimes: 0, fibers: 0, stores: 0 }
  if (root === undefined) return { owners: [], saw }
  const ownersByKey = new Map<string, ServiceOwner>()
  walkParentChain(root, saw, ownersByKey)
  walkRegistryFibers(root, saw, ownersByKey)
  const owners = [...ownersByKey.values()].sort(
    (a, b) => (a.pkg ?? '').localeCompare(b.pkg ?? '') || a.service.localeCompare(b.service),
  )
  return { owners, saw }
}

/** 只要表。回空表时另用 `serviceSight` 拿「看见了多少」 */
export function serviceOwners(ctx: unknown): ServiceOwner[] {
  return serviceSight(ctx).owners
}

/** summary 与 usage 都是非空字符串才算声明了 */
function declaredProvidesOf(manifest: unknown, service: string): ServiceProvides | undefined {
  const declaration = asRecord(asRecord(asRecord(asRecord(manifest)?.['gwb'])?.['provides'])?.[service])
  const summary = typeof declaration?.['summary'] === 'string' ? declaration['summary'] : undefined
  const usage = typeof declaration?.['usage'] === 'string' ? declaration['usage'] : undefined
  return summary !== undefined && summary !== '' && usage !== undefined && usage !== '' ? { summary, usage } : undefined
}

/**
 * 把各包 `package.json` 里的 `gwb.provides` 贴到服务表上。`readManifest` 收包名回解析好的清单（读不到回 undefined），
 * 注入进来让测试不用读磁盘。读不到、形状不对都当没声明，不让整条命令失败
 */
export async function joinProvides(
  owners: readonly ServiceOwner[],
  readManifest: (pkg: string) => Promise<unknown>,
): Promise<ServiceOwner[]> {
  const manifestsByPackage = new Map<string, unknown>()
  const cachedManifestOf = async (pkg: string): Promise<unknown> => {
    if (!manifestsByPackage.has(pkg)) manifestsByPackage.set(pkg, await readManifest(pkg))
    return manifestsByPackage.get(pkg)
  }
  const joined: ServiceOwner[] = []
  for (const owner of owners) {
    if (owner.pkg === undefined) {
      joined.push(owner)
      continue
    }
    const provides = declaredProvidesOf(await cachedManifestOf(owner.pkg), owner.service)
    joined.push(provides === undefined ? owner : { ...owner, provides })
  }
  return joined
}
