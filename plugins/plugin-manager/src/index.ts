import { Service } from 'cordis'
import type { GwbContext, GwbResult } from '@godcreator/gwb-plugin-api'
import { isRecord, requireKernel } from './vocab.js'
// 这几条 type import 只为引入对方的 `declare module 'cordis'`，让 ctx 上有那几个服务名
// （commands 那条另带一个类型：一键热升级要持有命令总线的引用）。这些插件在这里**都是可选的**，
// 所以都用嵌套注入、都写进 devDependencies
import type { GwbCommands } from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-data'
import type {} from '@godcreator/gwb-settings'
import type {} from '@godcreator/gwb-skills'
import { readHomeDependencies, readInstalledManifest, readPeerManifest, readSharedPackages } from './home.js'
import { assertId, assertIdUsable, assertPkgName, bareId, installSpec, pickId, type IdOwners } from './ids.js'
import { isLibraryManifest, readEntries, reconcile, toLabels, type PluginPackageView } from './inventory.js'
import { peerKindOf, planPeers, toPeerDependencies, type PeerKind } from './peers.js'
import type { PeerWarning } from './peer-warnings.js'
import { checkPeers, describeAddFailure, describePnpm, locatePnpm, runPnpm, runPnpmCapture, type PnpmResult } from './pnpm.js'
import { parseOutdated, type UpdateInfo } from './outdated.js'
import { entriesForPackage } from './uninstall.js'
import { ownEntryId, treeOf, type EntryTreeLike } from './tree.js'
import { BusyGate } from './busy.js'
import { fiberStateOf, planUpdateAll, type PlannedEntry } from './update-all.js'
import { remountNow, remountOne, remountSelfLater, type RemountedEntry } from './remount.js'

export type { EntrySnapshot, PluginEntryView, PluginPackageView } from './inventory.js'
export type { PeerKind, PeerPlanItem } from './peers.js'
export type { PeerWarning } from './peer-warnings.js'
export type { RemountedEntry } from './remount.js'

/**
 * 管理 home 里的**包**和 `cordis.yml` 里的**条目**。
 *
 * 包和条目是两回事，这个插件的工作就是让两者对应上：包由 pnpm 装进 home，条目由
 * loader 写进 `cordis.yml`——**只装包、不加条目，插件不会运行**；home 里还有一批
 * 永远不该有条目的共享包。
 *
 * **安装（`install`）还会把该进 home 的 peer 也装成 home 的直接依赖。** 插件依赖一个
 * 会独立升级、只读文件不 import 代码的包时，那个包必须在 home 的 `package.json` 里，才会有
 * `<home>/node_modules/<包名>` 这条由 pnpm 更新指向的 junction——pnpm 自动补装的 peer 只在
 * `.pnpm/` 里，`pnpm outdated` 看不见、`update-all` 也升级不到。判据与实测在 `peers.ts`。
 * **卸载时不动 peer**：代价不对称——残留一个没人用的包只是占磁盘，误删一个还有插件在用的
 * 包是运行时故障。所以 `uninstall` 不检查谁还在用它，这是有意的。
 *
 * **卸载（`uninstall`）= 删除条目并移除包**，设置与数据留在磁盘上。先删条目后卸包，
 * pnpm 失败只报告、不回滚。只删一条条目、保留包，用 `removeEntry`——这是两个不同的操作。
 *
 * **搜索插件、配置包源**（registry 检索与机器级 `~/.npmrc` 的 scope 路由）在 `@godcreator/gwb-plugin-sources`，
 * 这里只管装进 home 之后的事。查新版本（`outdated`）与升到最新（`update`）**不建条目**——条目引用的是
 * 包名，包换了版本条目照样有效。
 *
 * **一键热升级（`updateAll`）= 一次 pnpm 升级全部过期包，再逐条停用→启用重新加载，不重启。**
 * 计划（升级哪些、重新加载哪些、哪条最后）由 `update-all.ts` 里的纯函数算出；这里只按计划执行。升级与
 * 重新加载必须在**同一条命令**里完成：pnpm 会删除旧版本目录，两者之间只要隔着一条命令，旧版插件
 * 读磁盘就读不到文件。本插件自己的条目排在最后、回执发出后才处理——在命令处理函数里停用自己，回执也会一起丢失。
 *
 * 本插件只提供主进程里的服务与命令，操作面板在 `@godcreator/gwb-baseui`。
 */

/** 外壳的整页重载命令。**按命令名查找**，不 import 外壳的常量——那会让 shell 成为运行时依赖 */
const SHELL_RELOAD_COMMAND = 'shell.reload'

const NAME = 'gwb-plugin-manager'

/** 注册命令时填的所属插件：包名——agent 侧的操作键按包名识别，不认短名 */
const PKG = '@godcreator/gwb-plugin-manager'

/** 显示名存在本插件自己的数据里：一份「不带前缀的 id → label」的文档 */
const LABELS_DOC = 'labels'

/**
 * pnpm 的路径。**按 home 设置**——设置没有机器级，每个 home 保存自己的全部配置；换个 home 要重填一次，
 * 或者把旧 home 的 settings.json 里那一行复制过去。
 */
const PNPM_PATH_KEY = 'pnpm-path'

export const LIST_COMMAND = 'plugin-manager.list'
export const INSTALL_COMMAND = 'plugin-manager.install'
export const ADD_ENTRY_COMMAND = 'plugin-manager.add-entry'
export const REMOVE_ENTRY_COMMAND = 'plugin-manager.remove-entry'
export const ENABLE_COMMAND = 'plugin-manager.enable'
export const DISABLE_COMMAND = 'plugin-manager.disable'
export const REMOUNT_COMMAND = 'plugin-manager.remount'
export const SET_LABEL_COMMAND = 'plugin-manager.set-label'
export const OUTDATED_COMMAND = 'plugin-manager.outdated'
export const UPDATE_COMMAND = 'plugin-manager.update'
export const UPDATE_ALL_COMMAND = 'plugin-manager.update-all'
export const UNINSTALL_COMMAND = 'plugin-manager.uninstall'
export const SHARED_COMMAND = 'plugin-manager.shared'
export const TRANSFER_OWNER_COMMAND = 'plugin-manager.transfer-owner'

/** 转移归属的回执。`data` / `settings` 是 false 说明对应的插件没装、那部分没有处理 */
export interface TransferOwnerResult {
  id: string
  pkg: string
  data: boolean
  settings: boolean
}

/** 安装插件时一并处理的一条 peer。判据与理由在 `peers.ts` */
export interface PeerResult {
  pkg: string
  /** 插件清单里给它写的版本范围。**实际装的是 latest**，两者不一致时一眼就能看出 */
  range: string
  /**
   * `installed` 这次装成了 home 的直接依赖；`present` 本来就在 home 的 `package.json` 里、
   * 版本没有改动；`skipped` 由本生态自己提供，不该由这里安装；`failed` 没装上——
   * **插件本身已经装好了**，这一条要人手动处理
   */
  action: 'installed' | 'present' | 'skipped' | 'failed'
  /** present 时是 home 里那条 spec；skipped 时是跳过的理由；failed 时是错误信息（带 pnpm 输出的最后几行） */
  note?: string
}

/** 安装的回执 */
export interface InstallResult {
  ok: boolean
  pkg: string
  /**
   * 安装成功才有：新加条目的完整 entryId。**装的是库（keywords 里有 `gwb`、没有 `gwb-plugin`）
   * 时没有这个字段**——库没有 apply，不会建条目，原因写在 `note` 里
   */
  entryId?: string
  /**
   * 这个插件声明了 peer 才有：每条 peer 各自的处理结果。**没有这个字段 = 它一条 peer 都没声明**，
   * 与「声明了但全部跳过」区分开
   */
  peers?: PeerResult[]
  /** 需要提醒的情况：有 peer 没装上，或者 peer 这一步整个没有执行成功。**插件本身仍然是装上了的** */
  note?: string
  /** 失败时的原因 */
  error?: string
  /** pnpm 失败时输出的最后几行，失败原因在里面 */
  tail?: string
  /**
   * 安装后 home 里每一处 peer 版本不匹配（整个依赖树，不只这次新加的）。**安装本身是成功的**，
   * 这只是提醒；没有不匹配就没有这个字段。`pnpm peers check` 的结果读不出来时也没有这个字段，原因写在 `note` 里
   */
  peerWarnings?: PeerWarning[]
}

/** 查新版本的回执 */
export interface OutdatedReceipt {
  ok: boolean
  /** 成功才有：包名 → 新旧版本信息。**空对象 = 全都最新**，与「查询失败」区分开 */
  updates?: Record<string, UpdateInfo>
  /** 失败时的原因 */
  error?: string
}

/** 更新的回执。结构同 `InstallResult`，只是没有条目 */
export interface UpdateResult {
  ok: boolean
  pkg: string
  /** 失败时的原因 */
  error?: string
  /** pnpm 失败时输出的最后几行，失败原因在里面 */
  tail?: string
  /** 升级后 home 里每一处 peer 版本不匹配，同 `InstallResult.peerWarnings` */
  peerWarnings?: PeerWarning[]
  /** `pnpm peers check` 的结果读不出来时的说明 */
  note?: string
}


/** 一键热升级中升级了的一个包 */
export interface UpdatedPackage {
  pkg: string
  from: string
  to: string
  /** 它的每条条目各自的处理结果 */
  entries: RemountedEntry[]
}

/** 一键热升级的回执 */
export interface UpdateAllResult {
  ok: boolean
  /** 升级了的包。pnpm 失败时为空——没有升级任何包、没有改动任何条目 */
  updated: UpdatedPackage[]
  /** 本插件自己在升级清单里：它的条目在回执发出后才重新加载，重新加载完再整页重载 */
  selfDeferred: boolean
  /**
   * 整页重载是否执行：`done` 表示 `shell.reload` 已经执行；`deferred` 表示等本插件自己重新加载完再执行；
   * `unavailable` 表示命令表里没有它（或它执行失败），界面要手动刷新——原因在 `note` 里。
   * 没有升级任何包或整体失败时，没有这个字段
   */
  reload?: 'done' | 'deferred' | 'unavailable'
  /** 需要提醒的情况：全都最新、only 里列出但不在过期清单里的包、界面要手动刷新、peer 检查失败 */
  note?: string
  /** 失败时的原因 */
  error?: string
  /** pnpm 失败时输出的最后几行，失败原因在里面 */
  tail?: string
  /** 升级后 home 里每一处 peer 版本不匹配，同 `InstallResult.peerWarnings` */
  peerWarnings?: PeerWarning[]
}

/** 卸载的回执 */
export interface UninstallResult {
  ok: boolean
  pkg: string
  /** 成功才有：这次随包一起删除的条目（不带前缀的 id），供界面显示数量 */
  removedEntries?: string[]
  /** 失败时的原因 */
  error?: string
  /** pnpm 失败时输出的最后几行，失败原因在里面 */
  tail?: string
}

/**
 * 保存 label 的存储。只保留用得到的两个方法——`ctx.gwbData` 满足它。
 *
 * **显示名不存进 cordis.yml，也不存进设置，而是存在这个插件自己的数据目录里。** 理由：id 是身份标识、
 * 固定不可改，但人需要给条目起个看得懂的名字（尤其是中文名，而 id 只能是 ASCII
 * kebab-case）。存在自己的数据目录里，这个插件就不必为了显示名去依赖设置插件。
 */
interface LabelStore {
  readDoc(doc: string): Promise<unknown>
  writeDoc(doc: string, value: unknown): Promise<void>
}

/** 读设置的接口。只保留用得到的一个方法 */
interface SettingsSlot {
  get(key: string): unknown
}

/**
 * 归属记录：数据插件与设置插件各有一份，记录每个 id 属于哪个包。只保留用得到的两个方法——
 * `ctx.gwbData` 与 `ctx.gwbSettings` 都满足它。分配 id 时用它避开别的包留在磁盘上的数据
 */
interface OwnerBook {
  owners(): Promise<Record<string, string>> | Record<string, string>
  transferOwner(id: string, pkg: string): Promise<void>
}

/** 使用方拿到的服务接口。声明 `inject: ['gwbPluginManager']` 才能拿到 */
export interface GwbPluginManagerApi {
  /** 已装的包 → 各自的条目。包和条目两边都不遗漏，判据见 `reconcile` */
  list(): Promise<PluginPackageView[]>
  /**
   * home 里哪些包是共享包（清单里有 `gwb.shared`），各自提供哪些可以直接按名字 import 的模块。
   *
   * 界面用它把共享包从「装了但没有条目」那一组里移出来——共享包不是插件，永远不该有条目。
   * 内核为页面部分计算 importmap 时读的是同一批声明。
   */
  shared(): Promise<Record<string, string[]>>
  /**
   * `pnpm add` 装进 home → **把该进 home 的 peer 也装成 home 的直接依赖** → 再自动加一条
   * 条目（**默认启用**）。
   *
   * **peer 这一步**（判据与理由在 `peers.ts`）：读刚装进来那个包的 `peerDependencies`，
   * 还不在 home `package.json` 里的，逐条 `pnpm add <包>`（latest）。已经在的**完全
   * 不动**——不降级、不改写别人写明的版本。宿主提供的（`cordis`）与本生态的插件跳过，
   * 共享包与生态外的包安装。**装不上不会让整个 install 失败**：插件本身照样装上了，
   * 没装上的那几条在回执的 `peers` 与 `note` 里列出。
   *
   * **卸载不动 peer**（`uninstall` 同样如此）：代价不对称——残留一个没人用的包只是占
   * 磁盘，误删一个还有插件在用的包是运行时故障。
   *
   * **不抛异常**——pnpm 失败、找不到 pnpm，都转成一份 `ok: false` 的回执并带上原因；
   * 只有包名不合规这类调用方写错的情况才抛。
   *
   * **peer 版本不匹配不拦截**：调 pnpm 不带任何 peer 参数，pnpm 照常安装。装完运行一次 `pnpm peers check`，
   * 每一处不匹配写进回执的 `peerWarnings`（`peer-warnings.ts`）。`update` / `updateAll` 也一样。
   *
   * **同一个包 install 两次会得到两条条目**（第二条 id 带数字后缀）。不做「已经装过就
   * 跳过」的判断：同一个包对应多条条目本来就是合法的，替调用方猜意图只会猜错。
   */
  install(pkg: string, spec?: string): Promise<InstallResult>
  /**
   * 查 home 里已装的包哪些有新版本。**不抛异常**——找不到 pnpm、输出无法解析，都转成一份
   * `ok: false` 的回执：界面上它只显示一句提示，不该当成错误处理。
   */
  outdated(): Promise<OutdatedReceipt>
  /**
   * 把一个已装的包升到最新（`pnpm add <pkg>@latest`）。**与 install 唯一的差别是不建条目**
   * ——条目引用的是包名，包换版本后条目照样有效。**正在运行的 fiber 仍持有旧代码，重启内核后才
   * 换成新的**，调用方（界面）要把这一点告诉用户。
   *
   * 包没装（调用方写错了）直接抛；pnpm 失败转成 `ok: false` 的回执，带 pnpm 输出的最后几行。
   */
  update(pkg: string): Promise<UpdateResult>
  /**
   * 一键热升级：`outdated()` 拿到清单 → **一次** `pnpm add a@x b@y …`（精确版本）→ 升级了的每个包
   * 的每条条目**各自**停用再启用（重新 import 新版本；本来就停用的跳过）→ `shell.reload`
   * 整页重载。**不重启内核。** 给了 `only` 就只升级列出的那几个。
   *
   * **本插件自己排最后、回执发出后才重新加载**（`selfDeferred: true`）：在命令处理函数里停用自己，回执就
   * 丢了。这时整页重载也推迟到自己重新加载完之后（`reload: 'deferred'`）。
   *
   * **不抛异常**（`only` 里包名不合规这类调用方写错的情况除外）：查不到清单、找不到 pnpm、
   * pnpm 失败，都转成 `ok: false` 的回执；pnpm 失败时不改动任何条目。
   */
  updateAll(only?: readonly string[]): Promise<UpdateAllResult>
  /**
   * 卸载一个包：先把它在 `cordis.yml` 里的**全部条目**删除（fiber 随条目立即卸载），
   * 再 `pnpm remove` 移除包本身。设置与数据留在磁盘上——重新安装后还是那一份。
   *
   * **先删条目后卸包**：反过来的话，条目会引用一个不在 home 里的包，`list()` 里
   * 出现一排 ghost。**pnpm 失败不回滚**：条目已删是可以接受的结果（包出现在「已装、没有条目」
   * 那一组里，重试加条目即可），回执带 pnpm 输出的最后几行。
   *
   * **`install` 替它装进来的 peer 一条都不动，也不检查谁还在用**——这是有意的决定：
   * 代价不对称，残留一个没人用的包只是占磁盘，误删一个还有插件在用的包是运行时故障。
   * 真要清理，人自己在 home 里 `pnpm remove`。
   *
   * 包没装（调用方写错了）直接抛；删条目与 pnpm 两步的失败转成回执。
   */
  uninstall(pkg: string): Promise<UninstallResult>
  /** 给已装的包再加一条条目，返回新条目的完整 entryId。包没装、id 已被占用、id 的数据或设置属于别的包，都会抛 */
  addEntry(pkg: string, id?: string, config?: unknown): Promise<string>
  /**
   * 把一个 id 的数据目录与设置分区一起转移归属给 `pkg`。同一个插件改了包名、要继续使用旧数据时用它。
   * `id` 接受完整 entryId 也接受不带前缀的 id，不要求条目树上有这条条目。数据插件、设置插件没装的那部分跳过
   */
  transferOwner(id: string, pkg: string): Promise<TransferOwnerResult>
  /** 删一条条目。**不删包**——包留在 home 里，`list()` 里仍能看到 */
  removeEntry(entryId: string): void
  enable(entryId: string): Promise<void>
  disable(entryId: string): Promise<void>
  /**
   * 重新加载一条条目：停用 → 等旧 fiber 卸载完 → 启用 → 等新 fiber 启动完，**一次完成**（本来停用的，
   * 最终是启用）。返回 `remounted` 带重新加载后的状态；目标是**本插件自己**时返回 `deferred`（带操作前的
   * 状态），重新加载排到下一个宏任务——在命令处理函数里停用自己，回执就丢了。目标是命令总线时也在这一次里
   * 完成。条目不存在直接抛；修改条目树时抛出的错误转成 `failed`
   */
  remount(entryId: string): Promise<RemountedEntry>
  /** 改显示名，给空串就是清除。没装数据插件时返回 `ok: false`，不抛异常 */
  setLabel(entryId: string, label: string): Promise<GwbResult>
}

export default class GwbPluginManager extends Service implements GwbPluginManagerApi {
  /**
   * 提供方自己的 ctx。方法里的 `this.ctx` 是**使用方**的，而这个插件做的每件事都以
   * **自己**的身份进行（改的是整个条目树、写的是自己的数据），所以一律用这一份。
   *
   * **用 TS 的 `private` 不用 `#`**：cordis 给每个使用方派生一份 `Object.create(this)`，
   * 而 `#` 私有字段的内部存储不在原型链上，在派生对象上读取就会抛错。
   */
  private readonly own: GwbContext
  /** 这个 home 的目录：pnpm 的 cwd，也是 home 的 package.json 所在的目录 */
  private readonly home: string
  /** cordis.yml 对应的条目树。在构造时获取——那时 this.ctx 还是提供方自己的 */
  private readonly tree: EntryTreeLike
  private readonly warn: (message: string) => void
  private readonly info: (message: string) => void
  /**
   * logger 本身。上面两个每次都经 `ctx.logger()` 获取，而一键热升级里最后重新加载本插件那一步，
   * 运行时本插件的 fiber 已经卸载——那时 ctx 上什么都不能访问，只能用事先持有的这个 logger
   */
  private readonly log: { info(message: string): void; warn(message: string): void }

  /** 装了数据插件才有。没装时只显示 id，`setLabel` 返回「没装数据插件」 */
  private labelStore: LabelStore | undefined
  /** 装了设置插件才有。没装时不读设置，pnpm 只靠自动查找 */
  private settings: SettingsSlot | undefined
  /** 数据插件、设置插件各自的归属记录，装了才有 */
  private dataBook: OwnerBook | undefined
  private settingsBook: OwnerBook | undefined
  /** 命令总线存在才有。一键热升级用它查找并执行 `shell.reload`——包括本插件自己重新加载之后那一次 */
  private cli: GwbCommands | undefined

  /** 变更互斥（实施 Spec §3）：同一 home 同一时刻最多一个安装/卸载/升级操作，重入时返回 BUSY */
  private readonly gate = new BusyGate()
  /** 不带前缀的 id → 显示名。以内存里这份为准，磁盘上那份是它的副本 */
  private labels: Record<string, string> = {}
  /** 第一次读取 labels 是否完成。setLabel 要等它——不等的话第一次改名会被读磁盘的结果覆盖 */
  private labelsReady: Promise<void> = Promise.resolve()

  /**
   * pnpm 排队执行，同一时刻只运行一个。两个 install 同时运行的话，pnpm 读-改-写 home 的
   * `package.json`，后写的会把前一个加进去的依赖覆盖掉——而且没有任何报错。
   */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(ctx: GwbContext) {
    super(ctx, 'gwbPluginManager')
    this.own = ctx
    this.home = requireKernel(ctx).dataDir
    this.tree = treeOf(ctx)
    // 构造时 this.ctx 还是**提供方**自己的，logger 绑定的是本插件
    this.warn = (message: string): void => ctx.logger(NAME).warn(message)
    this.info = (message: string): void => ctx.logger(NAME).info(message)
    this.log = ctx.logger(NAME)
  }

  [Service.init](): void {
    this.wireData()
    this.wireSettings()
    this.wireCommands()
    this.wireSkills()
    this.info(`件管理就绪（ctx.gwbPluginManager），自己那条条目是 ${ownEntryId(this.own)}，看表走 ${LIST_COMMAND}`)
  }

  /** 说明书用局部注入：没有 skills 插件时本插件照常加载。skills/ 目录必须列进 package.json 的 files */
  private wireSkills(): void {
    this.own.inject(['gwbSkills'], (ctx) => {
      ctx.effect(() => ctx.gwbSkills.register(new URL('../skills/', import.meta.url)))
    })
  }

  /** 数据插件是**可选**的：用嵌套注入，它存在时才连接，卸载时自动断开，之后才加载也能连接上 */
  private wireData(): void {
    this.own.inject(['gwbData'], (ctx) => {
      const store: LabelStore = ctx.gwbData
      this.labelStore = store
      this.dataBook = ctx.gwbData
      this.labelsReady = store.readDoc(LABELS_DOC).then(
        (raw) => {
          this.labels = toLabels(raw)
        },
        (err: unknown) => {
          this.warn(`显示名读不出来，先当没有：${String(err)}`)
        },
      )
      ctx.effect(() => () => {
        this.labelStore = undefined
        this.dataBook = undefined
      })
    })
  }

  /** 设置插件也是可选的。声明 pnpm 路径这一项设置，并保存读取设置的接口 */
  private wireSettings(): void {
    this.own.inject(['gwbSettings'], (ctx) => {
      this.settings = ctx.gwbSettings
      this.settingsBook = ctx.gwbSettings
      // 先注册清理：分区属于别的包时 define 会抛，抛了这两个引用也要清掉
      ctx.effect(() => () => {
        this.settings = undefined
        this.settingsBook = undefined
      })
      // define 自己会注册到调用方的 effect 上，不需要再包一层
      ctx.gwbSettings.define({
        key: PNPM_PATH_KEY,
        title: 'pnpm 路径',
        type: 'string',
        description:
          '装机用哪份 pnpm（只支持 pnpm 12 起的原生可执行）。不填就自动找（PATH 上的 pnpm.exe，或 npm 全局装出来的布局）。要手填时认这几种：pnpm 可执行文件（npm 全局装的在 node_modules\\pnpm\\pnpm.exe）、pnpm.cmd 垫片或它所在的目录、pnpm 包目录。',
      })
    })
  }

  /** 命令总线也是可选的：没有它服务接口照样完整，只是界面调用不到 */
  private wireCommands(): void {
    this.own.inject(['gwbCommands'], (ctx) => {
      const cli = ctx.gwbCommands
      // inject 保证了它在，这句只是把类型收窄
      if (cli === undefined) return
      this.cli = cli
      ctx.effect(() => () => {
        this.cli = undefined
      })
      const on = (name: string, description: string, usage: string, handler: (args?: unknown) => unknown): void => {
        ctx.effect(() => cli.register({ name, description, usage, plugin: PKG }, handler))
      }
      /** 变更互斥（实施 Spec §3）：安装、卸载、升级、重新加载这五条命令都经过互斥检查，重入时返回 BUSY */
      const onGuarded = (name: string, description: string, usage: string, handler: (args?: unknown) => unknown): void => {
        ctx.effect(() => cli.register({ name, description, usage, plugin: PKG }, (args) => this.gate.run(() => handler(args) as Promise<{ ok: boolean }> | { ok: boolean })))
      }

      on(LIST_COMMAND, 'home 里装了哪些包、各挂了哪些条目', '回执按包列：包名、spec、条目（id、entryId、启停、是否 ACTIVE）。无参数', () => this.list())

      on(SHARED_COMMAND, '哪些包是共享包、各自提供哪些裸名', '清单里有 gwb.shared 的就是。无参数', async () => ({
        ok: true,
        data: { packages: await this.shared() },
      }))

      onGuarded(
        INSTALL_COMMAND,
        '往 home 装一个包并自动加条目',
        'pnpm add 一个包进 home，把它还没在 home 的 peer 也装成直接依赖（cordis 与本生态的件跳过；已在的版本不动；装不上不影响件本身），再自动加一条条目——**装的是库就不加**（清单 keywords 自报 gwb、不自报 gwb-plugin 的那种：lib / 共享包 / 词汇表包没有 apply，条目落下去也挂不上），回执里 `note` 说清、没有 `entryId`。回执 { ok, pkg, entryId?, peers?: [{ pkg, range, action, note? }], note?, peerWarnings?: [{ peer, installed?, wanted, by }] }，action 是 installed / present / skipped / failed。peer 对不上不拦、照装：装完 home 里 peer 对不上的每一处（整棵树）进 peerWarnings——installed 是 home 里那一版，wanted 是 by 那个包要的范围；没有就没有这一格。参数 { pkg, spec? }（spec 是版本或 tag）；同一时刻只跑一趟变更，重入回 { ok:false, error:"BUSY…" }',
        async (args) => {
          const raw = asRecord(args)
          const result = await this.install(text(raw, 'pkg'), optional(raw, 'spec'))
          if (result.ok) return { ok: true, data: result }
          // pnpm 输出的最后几行既拼进 error（给人看），也原样留在 data 里（界面要单独排版时用）
          const tail = result.tail === undefined ? '' : `\n${result.tail}`
          return { ok: false, error: `${result.error ?? '没说原因'}${tail}`, data: result }
        },
      )

      on(ADD_ENTRY_COMMAND, '给已装的包再加一条条目', '参数 { pkg, id?, config? }。id 不给由这边编（盘上有本包留下的旧 id 优先接回）；给了的 id 树上被占、或盘上的数据与设置归别的包，当场拒', async (args) => {
        const raw = asRecord(args)
        const entryId = await this.addEntry(text(raw, 'pkg'), optional(raw, 'id'), raw['config'])
        return { ok: true, data: { entryId } }
      })

      on(
        TRANSFER_OWNER_COMMAND,
        '把一个 id 的数据与设置过户给另一个包',
        '同一个件改了包名、要接着用旧数据与设置时走它；数据目录与设置分区一起换章。参数 { id, pkg }：id 是条目 id（裸 id 或完整 entryId，树上不必有这条），pkg 是新户主的包名。回执 { id, pkg, data, settings }，data / settings 是 false 说明那个件没装、那一半没动',
        async (args) => {
          const raw = asRecord(args)
          return { ok: true, data: await this.transferOwner(text(raw, 'id'), text(raw, 'pkg')) }
        },
      )

      on(REMOVE_ENTRY_COMMAND, '删一条条目（不删包）', '参数 { entryId }', (args) => {
        this.removeEntry(text(asRecord(args), 'entryId'))
        return { ok: true }
      })

      on(ENABLE_COMMAND, '启用一条条目', '参数 { entryId }', async (args) => {
        await this.enable(text(asRecord(args), 'entryId'))
        return { ok: true }
      })

      on(DISABLE_COMMAND, '停用一条条目', '参数 { entryId }', async (args) => {
        await this.disable(text(asRecord(args), 'entryId'))
        return { ok: true }
      })

      onGuarded(
        REMOUNT_COMMAND,
        '重挂一条条目：停用→等拆完→启用→等挂上，一次做完',
        '参数 { entryId }（完整 entryId 或裸 id）。回执 { id, action, state }：action 是 remounted（这条命令里做完，state 是重挂后的 fiber 状态，ACTIVE 才算挂上）或 deferred（目标是本件自己：回执先发出、下一个宏任务才重挂，state 是动手前的状态，之后用 plugin-manager.list 核对 active）；动条目树时抛了回 ok: false，data 里 action 是 failed。本来停用的条目重挂后是启用的；重挂命令总线也在这条命令里做完；同一时刻只跑一趟变更，重入回 { ok:false, error:"BUSY…" }',
        async (args) => {
          const result = await this.remount(text(asRecord(args), 'entryId'))
          if (result.action === 'failed') return { ok: false, error: `条目 ${result.id} 重挂没成：${result.state}`, data: result }
          return { ok: true, data: result }
        },
      )

      on(SET_LABEL_COMMAND, '改一条条目的显示名', '参数 { entryId, label }（label 给空串就是抹掉）', async (args) => {
        const raw = asRecord(args)
        return this.setLabel(text(raw, 'entryId'), label(raw))
      })

      on(OUTDATED_COMMAND, '查已装的包哪些有新版本', 'pnpm outdated，不联网到公网。无参数', async () => {
        const result = await this.outdated()
        if (result.ok) return { ok: true, data: result }
        return { ok: false, error: result.error ?? '没说原因' }
      })

      onGuarded(UPDATE_COMMAND, '把一个已装的包升到最新', '不建条目、不重挂；跑着的件重启内核后才换新——要热生效走 plugin-manager.update-all。回执 { ok, pkg, peerWarnings?, note? }：peer 对不上不拦，升完 home 里对不上的每一处进 peerWarnings（形状同 install）。参数 { pkg }；同一时刻只跑一趟变更，重入回 { ok:false, error:"BUSY…" }', async (args) => {
        const result = await this.update(text(asRecord(args), 'pkg'))
        if (result.ok) return { ok: true, data: result }
        const tail = result.tail === undefined ? '' : `\n${result.tail}`
        return { ok: false, error: `${result.error ?? '没说原因'}${tail}`, data: result }
      })

      onGuarded(
        UPDATE_ALL_COMMAND,
        '一键热升全部过期包，不重启',
        '一趟 pnpm add 把全部过期包升到 outdated 回的精确版本，再逐条停用→启用重挂新版本（本来就停用的跳过；本件自己排最后、回执发出后才重挂），最后 shell.reload 整页重载。回执 { updated: [{ pkg, from, to, entries: [{ id, action, state }] }], selfDeferred, reload, note?, peerWarnings? }。peer 对不上不拦、照升：升完 home 里对不上的每一处进 peerWarnings（形状同 install）——多半是有插件没跟上上游的破坏版，该去追那个下游。参数 { only?: string[] }（限定包名；不给或不传参数就全升）；同一时刻只跑一趟变更，重入回 { ok:false, error:"BUSY…" }',
        async (args) => {
          const result = await this.updateAll(onlyList(args))
          if (result.ok) return { ok: true, data: result }
          const tail = result.tail === undefined ? '' : `\n${result.tail}`
          return { ok: false, error: `${result.error ?? '没说原因'}${tail}`, data: result }
        },
      )

      onGuarded(UNINSTALL_COMMAND, '卸载一个包：条目与包一起拿掉', '设置与数据留盘（只删一条条目走 plugin-manager.remove-entry）。参数 { pkg }；同一时刻只跑一趟变更，重入回 { ok:false, error:"BUSY…" }', async (args) => {
        const result = await this.uninstall(text(asRecord(args), 'pkg'))
        if (result.ok) return { ok: true, data: result }
        const tail = result.tail === undefined ? '' : `\n${result.tail}`
        return { ok: false, error: `${result.error ?? '没说原因'}${tail}`, data: result }
      })
    })
  }

  async list(): Promise<PluginPackageView[]> {
    const deps = await readHomeDependencies(this.home)
    return reconcile(deps, readEntries(this.tree.store), this.labels)
  }

  async shared(): Promise<Record<string, string[]>> {
    return readSharedPackages(this.home)
  }

  async install(pkg: string, spec?: string): Promise<InstallResult> {
    // 调用方写错的情况直接抛；下面每一种失败都是正常结果，转成回执
    const target = installSpec(pkg, spec)

    const found = locatePnpm(this.pnpmPath())
    if (!found.ok) {
      this.warn(`装不了 ${target}：${found.error}`)
      return { ok: false, pkg, error: found.error }
    }

    this.info(`用 ${describePnpm(found)} 装 ${target}`)
    const run = await this.applyToHome(found.file, { add: [target] })
    if (!run.ok) {
      const failure = describeAddFailure(`pnpm add ${target}`, run)
      this.warn(`${failure.error}\n${failure.tail ?? ''}`)
      return { ok: false, pkg, ...failure }
    }

    /**
     * **peer 排在建条目之前**：条目一加进去 loader 就立即加载它，而插件加载后第一件事很可能就是
     * 查 `<home>/node_modules/<peer>`。先装好 peer，插件启动时那条路径就已经存在。
     */
    const settled = await this.settlePeers(pkg, found.file)
    // 等 peer 也装完再检查：检查的是这次安装全部完成后的 home
    const checked = await this.peerWarningsOf(found.file)
    const notes = [settled.note, checked.note].filter((note): note is string => note !== undefined)
    const peers = {
      ...(settled.peers === undefined ? {} : { peers: settled.peers }),
      ...noteOf(notes),
      ...(checked.peerWarnings === undefined ? {} : { peerWarnings: checked.peerWarnings }),
    }

    // 装的是库不是插件：**不建条目**。库没有 apply，条目加进去后 loader 加载它必然失败
    // （invalid plugin, expect function or object with apply）——白白留下一条无用条目，日志里还多一条报错。
    // 判据是「keywords 里有 gwb 却没有 gwb-plugin」，只跳过明确是库的包；没写 keywords 的第三方插件照常建条目
    const manifest = await readInstalledManifest(this.home, pkg).catch(() => undefined)
    if (isLibraryManifest(manifest)) {
      const note = `${pkg} 是库不是件（清单 keywords 里只有 gwb、没有 gwb-plugin），没建条目——它没有 apply，落进 cordis.yml 也挂不上。要用它的件自己 inject 它提供的面`
      this.info(`${target} 装上了（库，没建条目）`)
      return { ok: true, pkg, note, ...peers }
    }

    try {
      // 直接建条目，不再重新检查清单：pnpm 刚报告成功，再查一次只会多一条失败路径
      const entryId = await this.createEntry(pkg)
      // 日志说「已加进」而不说「已加载」——这里不等待加载，是否加载成功看 list() 的 active
      this.info(`${target} 装上了，条目 ${entryId} 已加进 cordis.yml`)
      return { ok: true, pkg, entryId, ...peers }
    } catch (err: unknown) {
      // **不回滚删包**：留下的包会出现在 list() 的「没有条目」那一组里，用户看得到；
      // 删包比留着危险，而且删除时未必只删掉这一个
      const error = `${target} 装上了，但条目加不进 cordis.yml：${String(err)}。包留在 home 里，看表走 ${LIST_COMMAND}`
      this.warn(error)
      return { ok: false, pkg, error, ...peers }
    }
  }

  /**
   * 运行一次 `pnpm peers check`，填回执的两个字段：有版本不匹配时是 `peerWarnings`（没有就不带这个字段），
   * 结果读不出来时是 `note` 里的说明。有不匹配时记一条 warn 日志
   */
  private async peerWarningsOf(pnpm: string): Promise<{ peerWarnings?: PeerWarning[]; note?: string }> {
    const checked = await this.queue(() => checkPeers({ pnpm, home: this.home }))
    if ('error' in checked) {
      this.warn(checked.error)
      return { note: checked.error }
    }
    if (checked.warnings.length === 0) return {}
    const lines = checked.warnings.map((w) => `${w.peer} ${w.installed ?? '没装'}，${w.by} 要 ${w.wanted}`)
    this.warn(`home 里 peer 对不上 ${String(lines.length)} 处（照装了）：${lines.join('；')}`)
    return { peerWarnings: checked.warnings }
  }

  /**
   * 把这个插件声明的 peer 里**该进 home 的**装成 home 的直接依赖（与插件同级）。
   *
   * **为什么要装、为什么 pnpm 自动补装的那份不够用**，判据与实测数据在 `peers.ts` 的头注释。
   * 这里只讲执行上的三个取舍：
   *
   * **一、装的是 latest，不是清单上那条 range。** 这里装的 peer 是共享包与生态外的包，
   * latest 通常都满足清单上的 range；而按 range 装会把 `^1.2.3` 这种范围原样写进 home 的
   * `package.json`，与这里每条依赖都是精确版本的格式不一致。range 原样写进回执；latest
   * 真不满足时照样安装，那一处会出现在回执的 `peerWarnings` 里。
   *
   * **二、每条 peer 单独运行一次 pnpm，不批量。** 一次 `add a b c` 里只要有一个包在包源上不存在，
   * pnpm 就整体失败，其他正常的包也一个都装不上，而且它不说明是哪个包出错。peer 数量是个位数，
   * 多启动几个进程换来「能指出装不上的是哪一个」，值得。
   *
   * **三、永不抛异常、永不让安装失败。** 插件本身已经装上了，peer 这一步的每一种失败都只是
   * 回执里的一行——这条命令是所有 home 安装插件的必经之路，它多一条抛出的路径就多一种
   * 「什么都装不了」的情况。
   */
  private async settlePeers(pkg: string, pnpm: string): Promise<{ peers?: PeerResult[]; note?: string }> {
    let plan: ReturnType<typeof planPeers>
    try {
      const declared = toPeerDependencies(await readInstalledManifest(this.home, pkg))
      const names = Object.keys(declared)
      if (names.length === 0) return {}
      // 种类只对本生态的包有意义，但读一份清单只要几微秒，不值得为此单独区分处理
      const kinds: Record<string, PeerKind | undefined> = {}
      for (const peer of names) kinds[peer] = peerKindOf(await readPeerManifest(this.home, pkg, peer))
      plan = planPeers(declared, await readHomeDependencies(this.home), kinds)
    } catch (err: unknown) {
      const note = `${pkg} 装好了，但它的 peer 清单没读成（${String(err)}），一条都没装。要的话自己在 home 里 pnpm add`
      this.warn(note)
      return { note }
    }

    const peers: PeerResult[] = []
    for (const item of plan) {
      if (item.decision !== 'install') {
        const stay: PeerResult = { pkg: item.pkg, range: item.range, action: item.decision }
        peers.push(item.note === undefined ? stay : { ...stay, note: item.note })
        continue
      }
      const run = await this.applyToHome(pnpm, { add: [item.pkg] })
      if (run.ok) {
        this.info(`${pkg} 的 peer ${item.pkg}（清单写 ${item.range}）装成了 home 的直接依赖`)
        peers.push({ pkg: item.pkg, range: item.range, action: 'installed' })
        continue
      }
      const failure = describeAddFailure(`pnpm add ${item.pkg}`, run)
      const why = `${failure.error}${failure.tail === undefined ? '' : `\n${failure.tail}`}`
      this.warn(`${pkg} 的 peer ${item.pkg} 没装上：${why}`)
      peers.push({ pkg: item.pkg, range: item.range, action: 'failed', note: why })
    }

    const failed = peers.filter((peer) => peer.action === 'failed').map((peer) => peer.pkg)
    if (failed.length === 0) return { peers }
    return {
      peers,
      note: `${pkg} 装好了，但这几条 peer 没装上：${failed.join('、')}。件跑起来现查 <home>/node_modules/<包名> 会扑空——自己在 home 里 pnpm add 一趟，或者先看它在不在源上`,
    }
  }

  /**
   * 查 home 里已装的包哪些有新版本（`pnpm outdated --json`）。
   *
   * **退出码 1 表示「存在过期包」，是结果不是失败**；0 且 stdout 为空才是「全都最新」。
   * 与 install 共用同一个串行队列——它只读不写，排队等待无妨，省得另外处理并发。
   */
  async outdated(): Promise<OutdatedReceipt> {
    const found = locatePnpm(this.pnpmPath())
    if (!found.ok) return { ok: false, error: found.error }

    const run = await this.queue(() =>
      runPnpmCapture({ pnpm: found.file, cwd: this.home, args: ['outdated', '--json'] }),
    )
    // pnpm 给人看的说明都在 stderr 上，两种失败情况都把它带上
    const say = (message: string): string =>
      run.stderrTail === '' ? message : `${message}\n${run.stderrTail}`
    if (run.exitCode === null) return { ok: false, error: say(`pnpm 起不来（退出码 ${String(run.exitCode)}）`) }
    if (run.exitCode !== 0 && run.exitCode !== 1) {
      return { ok: false, error: say(`pnpm outdated 没成（退出码 ${String(run.exitCode)}）`) }
    }
    const updates = parseOutdated(run.stdout)
    if (updates === undefined) {
      return { ok: false, error: say('pnpm outdated 的输出认不出来（要的是一份 JSON）——pnpm 大版本间形状可能变了') }
    }
    return { ok: true, updates }
  }

  async update(pkg: string): Promise<UpdateResult> {
    // 调用方写错的情况直接抛；下面每一种失败都是正常结果，转成回执
    assertPkgName(pkg)
    const deps = await readHomeDependencies(this.home)
    if (deps[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，谈不上更新。装走 ${INSTALL_COMMAND}。`)
    }

    const found = locatePnpm(this.pnpmPath())
    if (!found.ok) {
      this.warn(`升不了 ${pkg}：${found.error}`)
      return { ok: false, pkg, error: found.error }
    }

    this.info(`用 ${describePnpm(found)} 把 ${pkg} 升到最新`)
    const run = await this.applyToHome(found.file, { add: [`${pkg}@latest`] })
    if (!run.ok) {
      const failure = describeAddFailure(`pnpm add ${pkg}@latest`, run)
      this.warn(`${failure.error}\n${failure.tail ?? ''}`)
      return { ok: false, pkg, ...failure }
    }

    // 条目不动（引用的是包名，包换版本后条目照样有效）。正在运行的 fiber 仍持有旧代码，重启后才换成新的
    this.info(`${pkg} 升到最新了。跑着的件还持旧代码，重启内核后才换成新的（要热生效走 ${UPDATE_ALL_COMMAND}）`)
    return { ok: true, pkg, ...(await this.peerWarningsOf(found.file)) }
  }

  async updateAll(only?: readonly string[]): Promise<UpdateAllResult> {
    // 调用方写错的情况直接抛；下面每一种失败都是正常结果，转成回执
    for (const pkg of only ?? []) assertPkgName(pkg)
    const bare = (extra?: string): UpdateAllResult => ({ ok: false, updated: [], selfDeferred: false, ...(extra === undefined ? {} : { error: extra }) })

    const checked = await this.outdated()
    if (!checked.ok || checked.updates === undefined) return bare(checked.error ?? '查不出过期清单')

    const plan = planUpdateAll(checked.updates, this.tree.store, ownEntryId(this.own), only)
    const notes: string[] = []
    if (plan.ignored.length > 0) notes.push(`only 里这几个不在过期清单里，没动：${plan.ignored.join('、')}`)
    if (plan.packages.length === 0) {
      return { ok: true, updated: [], selfDeferred: false, note: ['全都最新', ...notes].join('；') }
    }

    const found = locatePnpm(this.pnpmPath())
    if (!found.ok) {
      this.warn(`升不了：${found.error}`)
      return bare(found.error)
    }
    // 一次装完：pnpm 读-改-写 home 的 package.json，逐个包启动进程与并发 install 一样会互相覆盖
    const specs = plan.pnpmArgs.slice(1)
    this.info(`用 ${describePnpm(found)} 一趟装 ${specs.join(' ')}`)
    const run = await this.applyToHome(found.file, { add: specs })
    if (!run.ok) {
      const failure = describeAddFailure(`pnpm ${plan.pnpmArgs.join(' ')}`, run)
      // 失败发生在重新加载之前：没有改动任何条目
      const error = `${failure.error}。一条条目都没动`
      this.warn(`${error}\n${failure.tail ?? ''}`)
      return { ...bare(error), ...(failure.tail === undefined ? {} : { tail: failure.tail }) }
    }
    // 在重新加载之前检查：检查的是磁盘上的状态，与重新加载无关；放在前面，本插件自己重新加载之前回执内容就已齐全
    const peerCheck = await this.peerWarningsOf(found.file)
    if (peerCheck.note !== undefined) notes.push(peerCheck.note)
    const warned = peerCheck.peerWarnings === undefined ? {} : { peerWarnings: peerCheck.peerWarnings }

    // 从这里开始旧版本目录已经删除：升级了的每条条目都必须在**这条命令里**重新加载，中间不留间隔
    const updated: UpdatedPackage[] = []
    let deferred: PlannedEntry | undefined
    for (const pkg of plan.packages) {
      const entries: RemountedEntry[] = []
      for (const entry of pkg.entries) {
        if (entry.self && !entry.disabled) {
          deferred = entry
          entries.push({ id: entry.id, action: 'deferred', state: fiberStateOf(this.tree.store[entry.id]) })
          continue
        }
        entries.push(await this.remountPlanned(entry))
      }
      updated.push({ pkg: pkg.pkg, from: pkg.from, to: pkg.to, entries })
    }
    const summary = updated.map((p) => `${p.pkg} ${p.from} → ${p.to}`).join('，')
    const cli = this.cli

    if (deferred === undefined) {
      const reload = await reloadVia(cli)
      if (reload.note !== undefined) notes.push(reload.note)
      this.info(`一键热升完成：${summary}${reload.reload === 'done' ? '；界面已整页重载' : ''}`)
      return { ok: true, updated, selfDeferred: false, reload: reload.reload, ...noteOf(notes), ...warned }
    }

    /**
     * **本插件自己最后处理，而且在回执之后。** 在命令处理函数里停用自己，await 链随 fiber 一起卸载，回执永远
     * 到不了调用方。所以先返回回执，下一个宏任务再处理——那时命令的应答早已发出。
     * 闭包**只持有 tree、id、命令总线的引用与 logger**：本插件的 fiber 卸载之后，ctx 上的
     * 东西都不能访问（获取服务会报「inactive context」）；闭包里也不调用 `this` 上的其他方法
     */
    const id = deferred.id
    const log = this.log
    remountSelfLater(this.tree, id, log, async () => {
      const reload = await reloadVia(cli)
      if (reload.note !== undefined) log.warn(reload.note)
    })
    const canReload = hasCommand(cli, SHELL_RELOAD_COMMAND)
    if (!canReload) notes.push(`命令表里没有 ${SHELL_RELOAD_COMMAND}，界面要手动刷新`)
    this.info(`一键热升：${summary}；本件自己（${id}）回执之后重挂${canReload ? '，随后整页重载' : ''}`)
    return { ok: true, updated, selfDeferred: true, reload: canReload ? 'deferred' : 'unavailable', ...noteOf(notes), ...warned }
  }

  /** 按计划重新加载一条：本来就停用的跳过（保持停用），修改条目树时抛出的错误转成 failed */
  private async remountPlanned(entry: PlannedEntry): Promise<RemountedEntry> {
    if (entry.disabled) return { id: entry.id, action: 'skipped', state: 'disabled' }
    return remountNow(this.tree, entry.id, this.log)
  }

  async remount(entryId: string): Promise<RemountedEntry> {
    const id = this.locate(entryId)
    return remountOne(this.tree, id, bareId(ownEntryId(this.own)), this.log)
  }

  async uninstall(pkg: string): Promise<UninstallResult> {
    // 调用方写错的情况直接抛；下面每一种失败都是正常结果，转成回执
    assertPkgName(pkg)
    const deps = await readHomeDependencies(this.home)
    if (deps[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，谈不上卸载。只删条目走 ${REMOVE_ENTRY_COMMAND}。`)
    }

    // 第一步：删除条目。逐条 tree.remove——它一次做两件事（写回 yml、立即卸载 fiber），
    // 依赖这个包的其他插件会随 fiber 一起被 cordis 卸载，停在「未加载」状态
    const ids = entriesForPackage(this.tree.store, pkg)
    for (const id of ids) this.tree.remove(id)

    // 第二步：卸载包。排进现有的串行队列，与 install/update 共用
    const found = locatePnpm(this.pnpmPath())
    if (!found.ok) {
      this.warn(`卸不了 ${pkg}：条目已摘（${ids.length} 条），${found.error}`)
      return { ok: false, pkg, removedEntries: ids, error: found.error }
    }
    const run = await this.applyToHome(found.file, { remove: [pkg] })
    if (!run.ok) {
      // 不回滚：条目已删是可以接受的结果，包会出现在「已装、没有条目」那一组里，重试加条目即可
      const error = `pnpm remove ${pkg} 没成（退出码 ${String(run.exitCode)}）。条目已摘 ${ids.length} 条，包还在 home 里`
      this.warn(`${error}\n${run.tail ?? ''}`)
      return run.tail === undefined
        ? { ok: false, pkg, removedEntries: ids, error }
        : { ok: false, pkg, removedEntries: ids, error, tail: run.tail }
    }

    this.info(`${pkg} 卸载了：${ids.length} 条条目摘掉，包从 home 移除。设置与数据留在盘上`)
    return { ok: true, pkg, removedEntries: ids }
  }

  async addEntry(pkg: string, id?: string, config?: unknown): Promise<string> {
    assertPkgName(pkg)
    const deps = await readHomeDependencies(this.home)
    if (deps[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，加不了条目。先走 ${INSTALL_COMMAND}，或者自己去 home 里 pnpm add。`)
    }
    const entryId = await this.createEntry(pkg, id, config)
    // install 有自己的「装上了」日志，这条日志只针对单独加条目的情况
    this.info(`条目 ${entryId}（${pkg}）加进 cordis.yml 了`)
    return entryId
  }

  async transferOwner(id: string, pkg: string): Promise<TransferOwnerResult> {
    assertPkgName(pkg)
    const bare = bareId(id)
    assertId(bare)
    const data = this.dataBook
    const settings = this.settingsBook
    if (data !== undefined) await data.transferOwner(bare, pkg)
    if (settings !== undefined) await settings.transferOwner(bare, pkg)
    this.info(`${bare} 的数据与设置过户给 ${pkg}`)
    return { id: bare, pkg, data: data !== undefined, settings: settings !== undefined }
  }

  /** 把两份归属记录合并成一张表：id → 登记为其归属的包（每份记录各一个，所以可能有两个） */
  private async idOwners(): Promise<IdOwners> {
    const out: Record<string, string[]> = {}
    for (const book of [this.dataBook, this.settingsBook]) {
      if (book === undefined) continue
      for (const [id, pkg] of Object.entries(await book.owners())) (out[id] ??= []).push(pkg)
    }
    return out
  }

  removeEntry(entryId: string): void {
    const id = this.locate(entryId)
    this.tree.remove(id)
    // 显示名保留不清除：id 是确定性的，同一个包重新安装后还是这个 id，那时旧名字能继续使用——
    // 与设置和数据的规则相同（删条目不删它的设置与数据）
    this.info(`条目 ${id} 已删（只删这一条，包没动；要连包一起拿掉走 ${UNINSTALL_COMMAND}）`)
  }

  async enable(entryId: string): Promise<void> {
    // **null 表示「删掉这个字段」**，不是「设成 null」——loader 的 update 把 null 当作删除
    const id = this.locate(entryId)
    await this.tree.update(id, { disabled: null })
    this.info(`条目 ${id} 已启用`)
  }

  async disable(entryId: string): Promise<void> {
    const id = this.locate(entryId)
    await this.tree.update(id, { disabled: true })
    this.info(`条目 ${id} 已停用`)
  }

  async setLabel(entryId: string, label: string): Promise<GwbResult> {
    const id = this.locate(entryId)
    const store = this.labelStore
    if (store === undefined) {
      return {
        ok: false,
        error: '没装数据件（@godcreator/gwb-data），显示名存不下来。装上它、在 cordis.yml 里加一条条目，再改一次。',
      }
    }
    // 等第一次读取完成再改，不然这次写入会被读磁盘的结果覆盖
    await this.labelsReady
    const trimmed = label.trim()
    const next = { ...this.labels }
    if (trimmed === '') delete next[id]
    else next[id] = trimmed
    await store.writeDoc(LABELS_DOC, next)
    this.labels = next
    this.info(trimmed === '' ? `条目 ${id} 的显示名已抹掉` : `条目 ${id} 的显示名改成「${trimmed}」`)
    return { ok: true }
  }

  /** 设置里填写的 pnpm 路径。设置插件没装时为 undefined，改用自动查找 */
  private pnpmPath(): string | undefined {
    const value = this.settings?.get(PNPM_PATH_KEY)
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  /**
   * 完整 entryId 与不带前缀的 id 都接受，返回不带前缀的 id。
   *
   * 插件从 ctx 上读到的是完整的 `home:commands`，而 `tree` 上的每个方法接受的是不带前缀的 id
   * （见 `ids.ts` 的 `bareId`）。两边不转换的话，`resolve` 会直接报「cannot resolve entry」。
   */
  private locate(entryId: string): string {
    const id = bareId(entryId)
    if (this.tree.store[id] === undefined) {
      throw new Error(`cordis.yml 里没有 id 是 ${JSON.stringify(id)} 的条目。看表走 ${LIST_COMMAND}。`)
    }
    return id
  }

  /**
   * 往 `cordis.yml` 里加一条。`tree.create` 一次做两件事——写回 yml、立即加载，
   * 所以这里不用再手动 `ctx.plugin`。
   *
   * **id 一定要显式给。** 不给的话 loader 生成一个 8 位随机 hex，而且每次启动都换一个：
   * 那条条目的设置与数据（都按 id 的末段分区）从此每启动一次就新建一份。
   */
  private async createEntry(pkg: string, id?: string, config?: unknown): Promise<string> {
    // 先读取磁盘上的归属记录：数据与设置在条目删除后仍然保留，只按条目树判断重复会把别的包的数据分给这条条目
    const owners = await this.idOwners()
    // 在**整个条目树**范围内判断 id 是否重复：id 在 cordis.yml 里全局唯一，loader 的 store 就是一张平表
    const taken = new Set(Object.keys(this.tree.store))
    let final: string
    if (id === undefined) {
      final = pickId(pkg, taken, owners)
    } else {
      assertIdUsable(id, pkg, taken, owners)
      final = id
    }
    // 每次传一个新对象：create 会把它原样放进 group.data，共用一个对象等于两条条目共享配置
    const options: Record<string, unknown> = { id: final, name: pkg }
    if (config !== undefined) options['config'] = config

    /**
     * **只等它把条目写进去，不等它加载完成。**
     *
     * `tree.create` 一次做两件事，而它返回的 promise 里**包含加载过程**——加载可能永远不
     * 完成：`inject` 永远满足不了的插件，它的 fiber 按设计会一直等待。真 await 的话，
     * 安装一个依赖还没装的插件就会让这条命令**永远没有回执**（实机遇到过：加载同一服务的第二个提供方
     * 的条目，cordis 抛 `service ... has been registered`，整个 install 卡死）。
     *
     * 写入磁盘那部分是**同步**发生的：`create` 的函数体在第一个 await 之前就把 options
     * 放进了 group、安排好了写回。所以不 await 也不影响条目写入磁盘。
     *
     * 是否加载成功是另一回事，看 `list()` 的 `active`；加载失败的原因在日志里。
     */
    void this.tree.create(options, null).catch((err: unknown) => {
      this.warn(`条目 ${final}（${pkg}）加进 cordis.yml 了，但没挂起来：${String(err)}`)
    })
    return this.fullId(final)
  }

  /**
   * 不带前缀的 id → 完整 entryId。
   *
   * `tree.create` 没有被 await，拿不到它返回的完整 id，所以在这里自己拼。前缀是**本插件条目的前缀**——
   * 同一个条目树上的条目共用它。
   */
  private fullId(bare: string): string {
    const own = ownEntryId(this.own)
    const cut = own.lastIndexOf(':')
    return cut === -1 ? bare : `${own.slice(0, cut + 1)}${bare}`
  }

  /**
   * 改 home 的唯一入口：安装、升级、卸载都经这里运行 pnpm，排进同一个串行队列。
   * pnpm 每次都读-改-写 home 的 package.json，两次同时运行，后写的会覆盖前一次加进去的依赖
   */
  private applyToHome(pnpm: string, change: { add: readonly string[] } | { remove: readonly string[] }): Promise<PnpmResult> {
    const args = 'add' in change ? ['add', ...change.add] : ['remove', ...change.remove]
    return this.queue(() => runPnpm({ pnpm, cwd: this.home, args }))
  }

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    // 前一个任务失败不应导致后面排队的任务也失败
    this.chain = next.catch(() => undefined)
    return next
  }
}


function hasCommand(cli: GwbCommands | undefined, name: string): boolean {
  return cli !== undefined && cli.list().some((command) => command.name === name)
}

/** 经命令总线执行 `shell.reload`。没有命令总线、命令表里没有这条、执行失败，都返回「界面要手动刷新」 */
async function reloadVia(cli: GwbCommands | undefined): Promise<{ reload: 'done' | 'unavailable'; note?: string }> {
  if (!hasCommand(cli, SHELL_RELOAD_COMMAND) || cli === undefined) {
    return { reload: 'unavailable', note: `命令表里没有 ${SHELL_RELOAD_COMMAND}（外壳没装或版本太旧），界面要手动刷新` }
  }
  const result = await cli.run(SHELL_RELOAD_COMMAND)
  if (result.ok) return { reload: 'done' }
  return { reload: 'unavailable', note: `${SHELL_RELOAD_COMMAND} 没成（${result.error ?? '没说原因'}），界面要手动刷新` }
}

/** 回执里的 `note` 字段：没有要说明的就不带这个字段 */
function noteOf(notes: readonly string[]): { note?: string } {
  return notes.length === 0 ? {} : { note: notes.join('；') }
}

/** `plugin-manager.update-all` 的参数：不传、传空对象都表示「全部升级」；给了 only 就必须是非空字符串数组 */
function onlyList(args: unknown): string[] | undefined {
  if (args === undefined || args === null) return undefined
  const only = asRecord(args)['only']
  if (only === undefined || only === null) return undefined
  if (!Array.isArray(only) || only.some((item) => typeof item !== 'string' || item === '')) {
    throw new Error('only 给了就要是个非空字符串数组，比如 { "only": ["@godcreator/gwb-hello"] }')
  }
  return only as string[]
}

/** 命令按参数对象调用，不经过调用者身份——界面不是插件，没有身份可绑定 */
function asRecord(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) throw new Error('参数要是一个对象，比如 { "entryId": "commands" }')
  return args
}

function text(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (typeof value !== 'string' || value === '') throw new Error(`${key} 要是个非空字符串`)
  return value
}

function optional(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value === '') throw new Error(`${key} 给了就要是个非空字符串`)
  return value
}

/** 显示名单独处理：**空串是合法的**，表示「清除这个名字」 */
function label(raw: Record<string, unknown>): string {
  const value = raw['label']
  if (typeof value !== 'string') throw new Error('label 要是个字符串（空串就是抹掉）')
  return value
}

declare module 'cordis' {
  interface Context {
    gwbPluginManager: GwbPluginManagerApi
  }
}
