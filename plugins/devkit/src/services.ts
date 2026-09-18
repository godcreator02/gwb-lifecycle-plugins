/**
 * 「这个 home 里有哪些服务、各是谁提供的」——现问 cordis 自己，不读任何清单。
 *
 * 数据是 cordis 的 fiber 表（4.0.0-rc.9 的公开字段）：`Fiber.store: Dict<Impl>`，
 * `Impl = { name, fiber, value, check }`——**每个 fiber 记着它提供了哪些服务**，
 * 服务解析就是沿 fiber 链往上找（reflect 的 `get` 实现如此）。所以这儿走两条腿：
 *
 * 1. 从自己的 fiber 沿 `parent` 往上：捞到根上挂的那几个（`gwbKernel` 这类，没有挂载条目）
 * 2. `ctx.registry.entries()` 里每个件的 `runtime.fibers`：件提供的服务都在这儿
 *
 * 「谁提供的」优先读挂载条目：fiber 上由 loader 挂的 `entry`，`entry.id` 是 cordis.yml 里的
 * 条目名、`entry.options.name` 是包名。条目不在（内核自己、或内层注入出来的 fiber）时退回
 * `runtime.name`——那是件在自己源码里报的名字，多数时候等于包名，但不保证。
 *
 * **拿不到就当没有**：`store` 换了形状、宿主不是 cordis，一律回空表，由调用方加 note 说清。
 * 绝不抛——这条命令给人/agent 一个线索，不是契约判据。
 */

/** 一条：某个服务是谁提供的 */
export interface ServiceOwner {
  /** 服务名，如 `gwbShell` */
  service: string
  /** cordis.yml 里的条目名（`home:shell` 这种）；内核自己挂的、内层注入的都没有 */
  entryId?: string
  /** 提供者的包名（挂载条目上的 `name`）；条目不在时退回件自报的名字 */
  pkg?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 一个 fiber 上挂着的那几张服务表 → 提供者。条目优先，退回件自报的名字 */
function ownersOf(fiber: Record<string, unknown>, into: Map<string, ServiceOwner>): void {
  const store = asRecord(fiber['store'])
  if (store === undefined) return
  const entry = asRecord(fiber['entry'])
  const options = asRecord(entry?.['options'])
  const runtime = asRecord(fiber['runtime'])
  const entryId = asString(entry?.['id'])
  const pkg = asString(options?.['name']) ?? asString(runtime?.['name'])
  for (const impl of Object.values(store)) {
    const record = asRecord(impl)
    if (record === undefined) continue
    const service = asString(record['name'])
    if (service === undefined) continue
    const owner: ServiceOwner = {
      service,
      ...(entryId === undefined ? {} : { entryId }),
      ...(pkg === undefined ? {} : { pkg }),
    }
    const key = [service, entryId ?? '', pkg ?? ''].join('\u0000')
    if (!into.has(key)) into.set(key, owner)
  }
}

/** 链往上走的层数上限——正常 home 就几层，防形状认错时转圈 */
const MAX_DEPTH = 32

/** 这一趟问出来的全部服务 → 提供者。按包名、服务名排，读回执的人好对 */
export function serviceOwners(ctx: unknown): ServiceOwner[] {
  const root = asRecord(ctx)
  if (root === undefined) return []
  const out = new Map<string, ServiceOwner>()

  let fiber = asRecord(root['fiber'])
  for (let depth = 0; fiber !== undefined && depth < MAX_DEPTH; depth++) {
    ownersOf(fiber, out)
    fiber = asRecord(asRecord(fiber['parent'])?.['fiber'])
  }

  const registry = asRecord(root['registry'])
  const entries = registry?.['entries']
  if (typeof entries === 'function') {
    for (const row of entries.call(registry) as Iterable<unknown>) {
      const runtime = Array.isArray(row) ? asRecord(row[1]) : asRecord(row)
      const fibers = runtime?.['fibers']
      if (fibers === undefined || fibers === null) continue
      for (const one of fibers as Iterable<unknown>) {
        const record = asRecord(one)
        if (record !== undefined) ownersOf(record, out)
      }
    }
  }

  return [...out.values()].sort(
    (a, b) => (a.pkg ?? '').localeCompare(b.pkg ?? '') || a.service.localeCompare(b.service),
  )
}
