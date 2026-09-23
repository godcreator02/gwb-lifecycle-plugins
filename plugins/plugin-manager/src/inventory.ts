import { isRecord } from './vocab.js'

/**
 * 磁盘上的清单与条目树对照——零 I/O 纯逻辑（出现 `node:fs` import 就违反了这条约定）。
 * 读磁盘的部分在 `home.ts`，取条目树的部分在 `tree.ts`。
 */

/**
 * cordis 的 `FiberState.ACTIVE`。**那是个 `const enum`**，`isolatedModules` 下 import
 * 不进来，所以照抄字面量（内核的 `host/main.ts` 用同样的写法）。
 */
const FIBER_ACTIVE = 2

/** cordis.yml 里一条条目此刻的样子 */
export interface EntrySnapshot {
  /** 不带前缀的 id。改这条条目要用它——`tree.resolve` 只认这个 */
  id: string
  /** 完整 entryId（`home:commands`）。插件从自己的 ctx 上读到的是这个 */
  entryId: string
  /** 加载的是哪个包。group 这类内建条目是 `cordis:group` */
  pkg: string
  /** cordis.yml 里 `disabled: true` */
  disabled: boolean
  /**
   * 是否真的运行起来了。
   *
   * **判断的是 fiber 的状态，不是 fiber 存不存在**：cordis 创建 fiber 是同步的，inject 没满足的
   * 插件照样有一个 fiber，只是永远到不了 ACTIVE。所以判断「已加载」只能看这个状态。
   */
  active: boolean
  /** `group: true` 的那种条目——它是个分组，不是插件 */
  group: boolean
}

/** 一条条目在 `list()` 里的样子：快照加上显示名 */
export interface PluginEntryView extends EntrySnapshot {
  /** 人给它起的名字。没设过就没有这个字段，界面改为显示 id */
  label?: string
}

/** 一个包在 `list()` 里的样子 */
export interface PluginPackageView {
  pkg: string
  /**
   * home 的 `package.json` 的 dependencies 里它对应的值。
   * 条目引用一个没装的包时没有这个字段（`installed` 同时是 false）。
   */
  spec?: string
  /** home 的 dependencies 里有它 */
  installed: boolean
  /**
   * 它在 cordis.yml 里的条目，按树里的先后。
   *
   * **空数组只表示「一条条目都没有」，不表示「这是个装了没启用的插件」**——home 里还有
   * 共享包（`gwb-shared-react`、`gwb-tokens` 这些），它们不是插件、没有 apply、永远不会
   * 出现在条目树上。要从包清单里把这两类分开，只能读它的 `package.json` 去猜，猜错的
   * 代价是在界面上错误地提示一个包「你没启用」。所以这里如实报条目数，不下结论。
   */
  entries: PluginEntryView[]
}

/**
 * 插件在包清单里写 `"keywords": ["gwb", "gwb-plugin"]`，这个关键词是全生态判断「是不是插件」的唯一依据。
 * 这里用它决定装完要不要往 cordis.yml 加条目（`isLibraryManifest`）；gwb-plugin-sources 用同一个词
 * 筛选「可装」列表，两边的值必须相同
 */
export const PLUGIN_KEYWORD = 'gwb-plugin'

/** 表示属于本生态的关键词。**库**（lib / 共享包 / 词汇表包）只写它，不写 `PLUGIN_KEYWORD` */
const ECOSYSTEM_KEYWORD = 'gwb'

/** 一份清单里 `keywords` 收窄成字符串数组。没有、不是数组、元素不是字符串的一律滤掉 */
export function toKeywords(raw: unknown): string[] {
  if (!isRecord(raw)) return []
  const keywords = raw['keywords']
  if (!Array.isArray(keywords)) return []
  return keywords.filter((one): one is string => typeof one === 'string')
}

/**
 * 这份清单**明确是库**（不是插件）。
 *
 * 判据是「声明属于本生态 + 没声明是插件」：写了 `gwb` 却不写 `gwb-plugin`。本生态的 lib、
 * 共享包、词汇表包都由同一个模板生成、两个关键词写没写很确定，所以这条判得准。
 *
 * **不把「没写 keywords」当成库**：第三方插件（`@j/…` 那类）往往一个关键词都不写，把它们判成库的
 * 代价是「装上了却不建条目」——那比多建一条更难排查。所以只有**明确声明是库**的才不建条目，
 * 其余一律照常建条目。
 *
 * 装库时为什么要判断这个：库没有 `apply`，写进 cordis.yml 以后 loader 加载它必然失败
 * （`invalid plugin, expect function or object with apply`），条目白留一条、日志多一句无用信息
 */
export function isLibraryManifest(raw: unknown): boolean {
  const keywords = toKeywords(raw)
  return keywords.includes(ECOSYSTEM_KEYWORD) && !keywords.includes(PLUGIN_KEYWORD)
}

/** home 的 `package.json` 收窄成一张 包名 → 版本范围 的表。格式不对的部分当作没有，不因此作废整份 */
export function toDependencies(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const deps = raw['dependencies']
  if (!isRecord(deps)) return {}
  const out: Record<string, string> = {}
  for (const [pkg, spec] of Object.entries(deps)) {
    if (typeof spec === 'string') out[pkg] = spec
  }
  return out
}

/**
 * 一个包的清单里 `gwb.shared` 字段收窄成包名 import（bare specifier）的数组。
 *
 * **没有这个字段回 undefined，有但是空对象回空数组**——两者的意思不一样：前者是「这就是
 * 个普通插件」，后者是「我是共享包，只是不提供包名 import」（`gwb-tokens` 就是这种，它只提供一张
 * 令牌表）。界面按「是不是共享包」分栏，靠的正是这个区别。
 */
export function toShared(raw: unknown): string[] | undefined {
  if (!isRecord(raw)) return undefined
  const gwb = raw['gwb']
  if (!isRecord(gwb)) return undefined
  const shared = gwb['shared']
  if (!isRecord(shared)) return undefined
  return Object.keys(shared).filter((bare) => bare !== '' && typeof shared[bare] === 'string')
}

/** 本插件自己的 labels 文档收窄成 不带前缀的 id → 显示名。格式不对的项丢掉，不作废整份 */
export function toLabels(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const [id, label] of Object.entries(raw)) {
    if (typeof label === 'string' && label !== '') out[id] = label
  }
  return out
}

/**
 * loader 条目树的 `store` → 快照数组。
 *
 * `store` 是 `Object.create(null)` 建的不分层的表，键就是不带前缀的 id；`Entry` 不在我们的类型定义里
 * （不依赖 `@cordisjs/plugin-loader`），所以按运行时形状取、不改全局类型声明——
 * `gwb-data` 与 `gwb-settings` 的 `owner()` 用的是同一个写法。
 */
export function readEntries(store: unknown): EntrySnapshot[] {
  if (!isRecord(store)) return []
  const out: EntrySnapshot[] = []
  for (const [id, value] of Object.entries(store)) {
    if (!isRecord(value)) continue
    const options = isRecord(value['options']) ? value['options'] : {}
    const fiber = isRecord(value['fiber']) ? value['fiber'] : undefined
    const entryId = value['id']
    out.push({
      id,
      entryId: typeof entryId === 'string' && entryId !== '' ? entryId : id,
      pkg: typeof options['name'] === 'string' ? options['name'] : '',
      disabled: value['disabled'] === true,
      active: fiber?.['state'] === FIBER_ACTIVE,
      group: options['group'] === true,
    })
  }
  return out
}

/**
 * 包与条目对照。**两边都不丢**：dependencies 里有、条目树上没有的包报成 `entries: []`；
 * 条目引用一个不在 dependencies 里的包（手工改过 cordis.yml、或者包被 `pnpm remove` 删了）
 * 报成 `installed: false`。静默丢掉任何一边都会让界面上少一行，而人在磁盘上明明看得见。
 */
export function reconcile(
  deps: Readonly<Record<string, string>>,
  entries: readonly EntrySnapshot[],
  labels: Readonly<Record<string, string>>,
): PluginPackageView[] {
  const byPkg = new Map<string, PluginEntryView[]>()
  for (const pkg of Object.keys(deps)) byPkg.set(pkg, [])
  for (const entry of entries) {
    const label = labels[entry.id]
    const view: PluginEntryView = label === undefined ? { ...entry } : { ...entry, label }
    const bucket = byPkg.get(entry.pkg)
    if (bucket === undefined) byPkg.set(entry.pkg, [view])
    else bucket.push(view)
  }
  return [...byPkg.entries()]
    .map(([pkg, list]) => {
      const spec = deps[pkg]
      return spec === undefined
        ? { pkg, installed: false, entries: list }
        : { pkg, spec, installed: true, entries: list }
    })
    .sort((a, b) => a.pkg.localeCompare(b.pkg))
}
