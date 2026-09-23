import { isRecord } from './vocab.js'

/**
 * 盘上那份清单与条目树对起来——零 I/O 纯逻辑（出现 `node:fs` import 即越界）。
 * 读盘的那一半在 `home.ts`，取树的那一半在 `tree.ts`。
 */

/**
 * cordis 的 `FiberState.ACTIVE`。**那是个 `const enum`**，`isolatedModules` 下 import
 * 不进来，所以照抄字面量（内核的 `host/main.ts` 里同一个绕法）。
 */
const FIBER_ACTIVE = 2

/** cordis.yml 里一条条目此刻的样子 */
export interface EntrySnapshot {
  /** 裸 id。改这条条目要用它——`tree.resolve` 认的是这个 */
  id: string
  /** 完整 entryId（`home:commands`）。件从自己的 ctx 上读到的是这一个 */
  entryId: string
  /** 挂的是哪个包。group 这类内建条目是 `cordis:group` */
  pkg: string
  /** cordis.yml 里 `disabled: true` */
  disabled: boolean
  /**
   * 真的跑起来了没有。
   *
   * **判的是 fiber 的状态，不是 fiber 在不在**：cordis 建 fiber 是同步的，inject 没满足的
   * 件照样有一个 fiber 挂着，只是永远到不了 ACTIVE。所以「挂上了」只有这一种问法。
   */
  active: boolean
  /** `group: true` 的那种条目——它是个分组，不是件 */
  group: boolean
}

/** 一条条目在 `list()` 里的样子：快照加上显示名 */
export interface PluginEntryView extends EntrySnapshot {
  /** 人给它起的名字。没设过就没有这一格，界面回落到 id */
  label?: string
}

/** 一个包在 `list()` 里的样子 */
export interface PluginPackageView {
  pkg: string
  /**
   * home 的 `package.json` 里 dependencies 那格的值。
   * 条目引着一个没装的包时没有这一格（`installed` 同时是 false）。
   */
  spec?: string
  /** home 的 dependencies 里有它 */
  installed: boolean
  /**
   * 它在 cordis.yml 里的条目们，按树里的先后。
   *
   * **空数组只说「一条条目都没有」，不说「这是个装了没启用的件」**——home 里还躺着
   * 共享包（`gwb-shared-react`、`gwb-tokens` 这些），它们不是件、没有 apply、永远不会
   * 出现在条目树上。要从包清单里把这两类分开，只能去读它的 `package.json` 猜，猜错的
   * 代价是在界面上诬告一个包「你没启用」。所以这儿如实报条目数，不下结论。
   */
  entries: PluginEntryView[]
}

/**
 * 插件在包清单里写 `"keywords": ["gwb", "gwb-plugin"]`，这个关键词是全生态判断「是不是插件」的唯一依据。
 * 这里用它决定装完要不要往 cordis.yml 加条目（`isLibraryManifest`）；gwb-plugin-sources 用同一个词
 * 筛选「可装」列表，两边的值必须相同
 */
export const PLUGIN_KEYWORD = 'gwb-plugin'

/** 本生态的归属词。**库**（lib / 共享包 / 词汇表包）只写它，不写 `PLUGIN_KEYWORD` */
const ECOSYSTEM_KEYWORD = 'gwb'

/** 一份清单里 `keywords` 收窄成字符串数组。没有、不是数组、元素不是字符串的一律滤掉 */
export function toKeywords(raw: unknown): string[] {
  if (!isRecord(raw)) return []
  const keywords = raw['keywords']
  if (!Array.isArray(keywords)) return []
  return keywords.filter((one): one is string => typeof one === 'string')
}

/**
 * 这份清单**明确是库**（不是件）。
 *
 * 判据是「自报本生态 + 没自报是件」：写了 `gwb` 却不写 `gwb-plugin`。本生态的 lib、
 * 共享包、词汇表包都由同一个模板生成、两枚词齐全与否很确定，所以这条认得准。
 *
 * **不认「没写 keywords」**：第三方件（`@j/…` 那类）往往一枚词都不写，把它们判成库的
 * 代价是「装上了却不挂条目」——那是比多挂一条更难查的坏。所以只对**明确自报是库**的
 * 松手，其余一律照旧建条目。
 *
 * 装库时为什么要管这一格：库没有 `apply`，落进 cordis.yml 以后 loader 挂它必然失败
 * （`invalid plugin, expect function or object with apply`），条目白留一条、日志多一句噪声
 */
export function isLibraryManifest(raw: unknown): boolean {
  const keywords = toKeywords(raw)
  return keywords.includes(ECOSYSTEM_KEYWORD) && !keywords.includes(PLUGIN_KEYWORD)
}

/** home 的 `package.json` 收窄成一张 包名 → 版本范围 的表。坏了当没有，不整份不认 */
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
 * 一个包的清单里 `gwb.shared` 那格收窄成裸名数组。
 *
 * **没有这个字段回 undefined，有但是空对象回空数组**——两者的意思不一样：前者是「这就是
 * 个普通的件」，后者是「我是共享包，只是不提供裸名」（`gwb-tokens` 就是这种，它只出一张
 * 令牌表）。界面按「是不是共享包」分栏，靠的正是这条区别。
 */
export function toShared(raw: unknown): string[] | undefined {
  if (!isRecord(raw)) return undefined
  const gwb = raw['gwb']
  if (!isRecord(gwb)) return undefined
  const shared = gwb['shared']
  if (!isRecord(shared)) return undefined
  return Object.keys(shared).filter((bare) => bare !== '' && typeof shared[bare] === 'string')
}

/** 本件自己那份 labels 文档收窄成 裸 id → 显示名。坏的那格丢掉，不废掉整份 */
export function toLabels(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const [id, label] of Object.entries(raw)) {
    if (typeof label === 'string' && label !== '') out[id] = label
  }
  return out
}

/**
 * loader 那棵树的 `store` → 快照数组。
 *
 * `store` 是 `Object.create(null)` 建的平表，键就是裸 id；`Entry` 不在我们的类型面上
 * （不依赖 `@cordisjs/plugin-loader`），所以按运行时形状取、不动全局类型声明——
 * `gwb-data` 与 `gwb-settings` 的 `owner()` 是同一个手法。
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
 * 包与条目对起来。**两边都不丢**：dependencies 里有、条目树上没有的包报成 `entries: []`；
 * 条目引着一个不在 dependencies 里的包（手工改过 cordis.yml、或者包被 `pnpm remove` 掉了）
 * 报成 `installed: false`。静默丢掉任何一边都会让界面上少一行、而人在盘上明明看得见。
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
