/**
 * 子路径 `@godcreator/gwb-plugin-manager/receipts` 的入口：各条命令回执的类型，给界面的浏览器侧 `import type`。
 * 这个文件只有类型，不许有任何 import（包名、`node:` 与相对路径都不行）：调用方的浏览器侧 tsconfig 只有 DOM 类型，
 * 引进来的每个包都得由调用方列进 dev；`tests/receipts.test.ts` 查源码与构建产物
 */

/** 命令回执：成功只带 `data`，失败只带 `error`（pnpm 失败时输出的最后几行拼在里面）。经命令总线原样传出去 */
export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string }

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
  /** fiber 的状态是 ACTIVE。看状态不看 fiber 在不在：inject 没满足的插件也有 fiber，只是到不了 ACTIVE */
  active: boolean
  /** `group: true` 的那种条目——它是个分组，不是插件 */
  group: boolean
}

/** home 的 dependencies 与条目树对照出的一个包 */
export interface ReconciledPackage {
  pkg: string
  /** home 的 `package.json` 的 dependencies 里它对应的值。条目引用一个没装的包时没有这个字段 */
  spec?: string
  /** home 的 dependencies 里有它 */
  installed: boolean
  /** 它在 cordis.yml 里的条目，按树里的先后。空数组只表示「一条条目都没有」，不推断原因 */
  entries: EntrySnapshot[]
}

/** 一条没满足的 peer */
export interface UnmetPeer {
  pkg: string
  /** peerDependencies 里写的范围，原样照抄；不是 `^x.y.z` 也照抄，并算作没满足 */
  range: string
  /** home 里装着的版本号，内核包是正在运行的内核版本；没装时没有这个字段 */
  installed?: string
}

/** 一个包在 `list` 回执里和 peer 有关的字段 */
export interface PeerStatus {
  /**
   * 插件（keywords 含 gwb-plugin）peer 里除了 cordis 之外、没满足的包：没装（可选的 peer 没装不算）、
   * 或版本不在范围里。内核包对照正在运行的内核，别的包对照 home 里装着的版本。
   * 每个包都有这个字段，不是插件的包、清单读不到的包、全都满足时是空数组
   */
  unmetPeers: UnmetPeer[]
}

/** `plugin-manager.list` 的 `data` 是它的数组：一个包的对照结果加上它 peer 里写的包（含内核包）满没满足 */
export interface PluginPackageView extends ReconciledPackage, PeerStatus {}

/** `plugin-manager.install` 成功时的 `data` */
export interface Installed {
  pkg: string
  /** 新加的那条条目的完整 entryId */
  entryId: string
}

/** `plugin-manager.add-entry` 成功时的 `data` */
export interface EntryAdded {
  /** 新加的那条条目的完整 entryId */
  entryId: string
}

/** `plugin-manager.uninstall` 成功时的 `data` */
export interface Uninstalled {
  pkg: string
}

/** 一个包的版本差距 */
export interface UpdateInfo {
  /** home 里装着的版本 */
  current: string
  /** registry 上的最新版 */
  latest: string
}

/** 包名 → 版本差距。空对象是全都最新 */
export type OutdatedMap = Record<string, UpdateInfo>

/** `plugin-manager.outdated` 成功时的 `data` */
export interface OutdatedFound {
  updates: OutdatedMap
}

/** `search` 回执里的一行：包名、registry 上的最新版本、一句简介。是不是插件已在检索时按 keywords 筛过 */
export interface PluginRow {
  pkg: string
  version?: string
  description?: string
}

/** `plugin-manager.search` 成功时的 `data` */
export interface SearchFound {
  /** 全部配好的源上的插件。**空数组 = 查成了、一个都没有**，和「没查成」分得开 */
  packages: PluginRow[]
  /** 有源没查成时，点名是哪几条（其余照常） */
  note?: string
}

/** 升级回执里一个包的新旧版本。装之前 home 里没有这个包时没有 `from` */
export interface VersionChange {
  from?: string
  to: string
}

/** `update` 回执里一条条目重新加载的结果 */
export interface RemountedEntry {
  /** 不带前缀的 id */
  id: string
  /**
   * `remounted`：停用再启用，重新 import 了新版本；`skipped`：本来就停用，保持停用；
   * `deferred`：本插件自己那条，回执发出之后才重新加载；`failed`：操作条目树时抛错，`state` 里是那句错误
   */
  action: 'remounted' | 'skipped' | 'deferred' | 'failed'
  /** 重新加载之后 fiber 到哪一步（ACTIVE / PENDING / FAILED…）。skipped 是 disabled，deferred 是动手前的状态 */
  state: string
}

/** `update` 装了的一个包 */
export interface UpdatedPackage {
  pkg: string
  /** 装之前 home 里的版本号；`specs` 装之前 node_modules 里读不到它的清单时没有这个字段 */
  from?: string
  /** 装上的版本号（`specs` 也是装完读到的版本号，不是写法原文） */
  to: string
  /** 它的每条条目各自的处理结果；装了内核包、不重新加载时是空数组 */
  entries: RemountedEntry[]
}

/** `update` 中没升级、但 pnpm add 前后真实目录变了，跟着重新加载的一个包 */
export interface DependentPackage {
  pkg: string
  /** 它的每条条目各自的处理结果 */
  entries: RemountedEntry[]
}

/** `plugin-manager.update` 成功时的 `data` */
export interface Updated {
  /** 装了的包；specs 里有内核包时末尾还有插件管理自己对齐的 cordis */
  updated: UpdatedPackage[]
  /** 跟着重新加载的包，在 `updated` 之后处理 */
  dependents: DependentPackage[]
  /** 本插件自己在升级或跟着重新加载的包里：它的条目在回执发出后才重新加载 */
  selfDeferred: boolean
  /** 只在 specs 里有内核包时出现：装上的内核版本与正在运行的不同，重启工作台后才生效 */
  restartRequired?: boolean
  /** 需要提醒的情况：全都最新、only 里列出但已是最新的包、要不要重启 */
  note?: string
}

/** specs 里有内核包、内核包已经装上而 cordis 没对齐时 `plugin-manager.update` 的失败回执：`data.kernel` 是已经装上的内核版本 */
export type KernelInstalledButCordisNot = { ok: false; error: string; data: { kernel: VersionChange } }
