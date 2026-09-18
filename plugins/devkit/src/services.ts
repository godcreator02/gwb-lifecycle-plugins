/**
 * 「这个 home 里有哪些服务、各是谁提供的」——现问 cordis 自己，不读任何清单。
 *
 * 数据是 `ctx.reflect.store`：服务名 → `Impl { name, fiber, value, check }`（cordis 4.0.0-rc.9
 * 的形状）。fiber 上挂着挂载条目 `entry`——`entry.id` 是 cordis.yml 里的条目名、
 * `entry.options.name` 是包名。**跟 shell / skills 从「调用方的 fiber」取身份是同一个办法**，
 * 反过来用在这儿：遍历表，把每个服务的注册者捞出来。
 *
 * 这是 cordis 的内部面（`Context.root` 标着 `@experimental`），所以：
 * **拿不到就当没有**——`reflect` 不在、`store` 换了形状、host 不是 cordis，一律回空表，
 * 由调用方加一句 note 说清。绝不抛：这条命令的用处是给人/agent 一个线索，不是契约判据。
 */

/** 一条：某个服务是谁提供的 */
export interface ServiceOwner {
  /** 服务名，如 `gwbShell` */
  service: string
  /** cordis.yml 里的条目名（`home:shell` 这种）；内核自己挂的服务没有 */
  entryId?: string
  /** 提供它的包名；取不到不写 */
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

/** 从一条 `Impl` 上把「谁提供的」读出来：fiber → entry → id / 包名 */
function ownerOf(impl: unknown, fallbackName: string): ServiceOwner {
  const record = asRecord(impl)
  const service = asString(record?.['name']) ?? fallbackName
  const fiber = asRecord(record?.['fiber'])
  const entry = asRecord(fiber?.['entry'])
  const options = asRecord(entry?.['options'])
  const entryId = asString(entry?.['id'])
  const pkg = asString(options?.['name'])
  return {
    service,
    ...(entryId === undefined ? {} : { entryId }),
    ...(pkg === undefined ? {} : { pkg }),
  }
}

/** 这一趟问出来的全部服务 → 提供者。按包名、服务名排，读回执的人好对 */
export function serviceOwners(reflect: unknown): ServiceOwner[] {
  const store = asRecord(asRecord(reflect)?.['store'])
  if (store === undefined) return []
  const out: ServiceOwner[] = []
  for (const [key, impl] of Object.entries(store)) out.push(ownerOf(impl, key))
  out.sort((a, b) => (a.pkg ?? '').localeCompare(b.pkg ?? '') || a.service.localeCompare(b.service))
  return out
}
