import os from 'node:os'
import type { GwbContext } from '@godcreator/gwb-kernel-desktop'
import { isRecord, noteOf, requireKernel, type Outcome } from './vocab.js'
// 这几条 type import 只为引入对方的 `declare module 'cordis'`（commands 另取一个类型）；这些插件写在 peer 里，数据、设置、说明书标 optional，都经嵌套注入使用
import type { GwbCommands } from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-data'
import type {} from '@godcreator/gwb-settings'
import type {} from '@godcreator/gwb-skills'
import { installedPackageRealpath, npmrcFiles, readHomeDependencies, readInstalledPackageManifest } from './home.js'
import { assertId, assertIdUsable, assertPkgName, bareId, installSpec, isPkgName, pickId, type IdOwners } from './ids.js'
import { installedVersionOf, readEntries, reconcile, type PluginPackageView } from './inventory.js'
import { describeAddFailure, describePnpm, runPnpm, runPnpmCapture, type PnpmResult } from './pnpm.js'
import { locatePnpm } from './pnpm-location.js'
import { parseOutdated, type UpdateInfo } from './outdated.js'
import { entriesForPackage } from './uninstall.js'
import { ownEntryId, treeOf, type EntryTreeLike } from './tree.js'
import { BusyGate } from './busy.js'
import { fiberStateOf } from './fiber.js'
import {
  assertOnlyNotKernelManaged,
  assertOnlyPackagesInHome,
  packagesToRemount,
  planOutdatedUpdate,
  planSpecsUpdate,
  versionChangesAfterAdd,
  type InstalledDirectories,
  type InstalledVersions,
  type PackageEntries,
  type PlannedEntry,
  type SpecsUpdatePlan,
  type UpdateArgs,
  type VersionChangesAfterAdd,
} from './update.js'
import { remountNow, remountOne, remountSelfLater, type RemountedEntry } from './remount.js'
import { KERNEL_PACKAGE } from './kernel-compat.js'
import { CORDIS_PACKAGE, installedVersionMismatch, KERNEL_MANAGED_PACKAGES, kernelStatusInList, kernelUpgradeTargetOf, pluginsOutsideKernelRange, versionChangeOf, type VersionChange } from './kernel-upgrade.js'
import { declaredPluginPeers, peerStatusOf } from './peers.js'
import { addSource, listSources, removeSource, searchPlugins, type PackageSourcesDeps } from './package-sources.js'

// 开发套件复用的规则：它 import 这几个，不另存一份
export { locatePnpm } from './pnpm-location.js'
export { isCaretRange, KERNEL_PACKAGE, kernelRangeCovers } from './kernel-compat.js'
export { homePnpmEnv, tailLines } from './pnpm.js'

const NAME = 'gwb-plugin-manager'

/** 登记命令时填的所属插件：包名 */
const PKG = '@godcreator/gwb-plugin-manager'

/** 经过 BUSY 检查的那几条命令的 usage 末尾都带这一句 */
const BUSY_USAGE_NOTE = '同一时刻只允许一个变更，重入回 { ok:false, error:"BUSY…" }'

export const LIST_COMMAND = 'plugin-manager.list'
export const INSTALL_COMMAND = 'plugin-manager.install'
export const UPDATE_COMMAND = 'plugin-manager.update'
const ADD_ENTRY_COMMAND = 'plugin-manager.add-entry'
const REMOVE_ENTRY_COMMAND = 'plugin-manager.remove-entry'
const ENABLE_COMMAND = 'plugin-manager.enable'
const DISABLE_COMMAND = 'plugin-manager.disable'
const REMOUNT_COMMAND = 'plugin-manager.remount'
const OUTDATED_COMMAND = 'plugin-manager.outdated'
const UNINSTALL_COMMAND = 'plugin-manager.uninstall'
const TRANSFER_OWNER_COMMAND = 'plugin-manager.transfer-owner'
const SEARCH_COMMAND = 'plugin-manager.search'
const SOURCE_ADD_COMMAND = 'plugin-manager.source.add'
const SOURCE_LIST_COMMAND = 'plugin-manager.source.list'
const SOURCE_REMOVE_COMMAND = 'plugin-manager.source.remove'

/** 数据插件与设置插件的包名：转移归属时两个都要装着 */
const DATA_PACKAGE = '@godcreator/gwb-data'
const SETTINGS_PACKAGE = '@godcreator/gwb-settings'

/**
 * 服务 `gwbPluginManager` 的值：只表示插件管理装了（别的插件 inject 它，跟着它一起加载、卸载），上面没有字段。
 * 命令有没有破坏性变化看插件管理的版本号
 */
export type PluginManagerPresence = Record<string, never>

const PRESENCE: PluginManagerPresence = {}

/** `update` 装了的一个包 */
interface UpdatedPackage {
  pkg: string
  /** 装之前 home 里的版本号；`specs` 装之前 node_modules 里读不到它的清单时没有这个字段 */
  from?: string
  /** 装上的版本号（`specs` 也是装完读到的版本号，不是写法原文） */
  to: string
  /** 它的每条条目各自的处理结果；装了内核包、不重新加载时是空数组 */
  entries: RemountedEntry[]
}

/** `update` 中没升级、但 pnpm add 前后真实目录变了，跟着重新加载的一个包 */
interface DependentPackage {
  pkg: string
  /** 它的每条条目各自的处理结果 */
  entries: RemountedEntry[]
}

/** `update` 成功的回执 */
interface Updated {
  /** 装了的包；specs 里有内核包时末尾还有插件管理自己对齐的 cordis */
  updated: UpdatedPackage[]
  /** 跟着重新加载的包，在 `updated` 之后处理 */
  dependents: DependentPackage[]
  /** 本插件自己在升级或跟着重新加载的包里：它的条目在回执发出后才重新加载 */
  selfDeferred: boolean
  /** 只在 specs 里有内核包时出现：装上的内核版本与正在运行的不同，重启工作台后才生效 */
  restartRequired?: boolean
  /** 只在 specs 里有内核包时出现：home 里 peer 范围不包含新内核（或没写范围）的插件，按包名排 */
  pluginsOutsideRange?: string[]
  /** 需要提醒的情况：全都最新、only 里列出但已是最新的包、要不要重启 */
  note?: string
}

/** specs 里有内核包、内核包已经装上而 cordis 没对齐时的失败回执：`data.kernel` 是已经装上的内核版本 */
type KernelInstalledButCordisNot = { ok: false; error: string; data: { kernel: VersionChange } }

/** 数据插件与设置插件各有一份的归属记录（id → 包），`ctx.gwbData` 与 `ctx.gwbSettings` 都满足它 */
interface OwnerBook {
  owners(): Promise<Record<string, string>> | Record<string, string>
  transferOwner(id: string, pkg: string): Promise<void>
}

type CommandHandler = (args?: unknown) => unknown
type RegisterCommand = (name: string, description: string, usage: string, handler: CommandHandler) => void

export const name = NAME

export function apply(ctx: GwbContext): void {
  const manager = new PluginManager(ctx)
  ctx.effect(() => ctx.provide('gwbPluginManager', PRESENCE))
  manager.wire()
  ctx.logger(NAME).info(`插件管理已就绪，自己那条条目是 ${ownEntryId(ctx)}，查看列表调用 ${LIST_COMMAND}`)
}

class PluginManager {
  private readonly ctx: GwbContext
  /** pnpm 的工作目录，也是 home 的 package.json 所在的目录 */
  private readonly homeDir: string
  /** 运行中的内核版本号，`list` 拿它和各包 peer 里内核包的范围比对 */
  private readonly kernelVersion: string
  /** 机器级是包源路由的正本（`source.add` / `source.remove` 改它），home 级只读 */
  private readonly npmrc: { user: string; home: string }
  private readonly tree: EntryTreeLike
  /** 事先拿到的 logger：最后重新加载本插件那一步运行时，本插件的 fiber 已经卸载，ctx 上什么都不能访问 */
  private readonly log: { info(message: string): void; warn(message: string): void }

  /** 装了数据插件才有 */
  private dataOwnerBook: OwnerBook | undefined
  /** 装了设置插件才有 */
  private settingsOwnerBook: OwnerBook | undefined

  private readonly busyGate = new BusyGate()

  constructor(ctx: GwbContext) {
    this.ctx = ctx
    const kernel = requireKernel(ctx)
    this.homeDir = kernel.dataDir
    this.kernelVersion = kernel.version
    this.npmrc = npmrcFiles(os.homedir(), this.homeDir)
    this.tree = treeOf(ctx)
    this.log = ctx.logger(NAME)
  }

  wire(): void {
    this.wireData()
    this.wireSettings()
    this.wireCommands()
    this.wireSkills()
  }

  /** skills/ 目录要列进 package.json 的 files */
  private wireSkills(): void {
    this.ctx.inject(['gwbSkills'], (ctx) => {
      ctx.effect(() => ctx.gwbSkills.register(new URL('../skills/', import.meta.url)))
    })
  }

  /** 只用数据插件的归属记录：分配 id 时避开别的包的数据目录，转移归属时一起改 */
  private wireData(): void {
    this.ctx.inject(['gwbData'], (ctx) => {
      this.dataOwnerBook = ctx.gwbData
      ctx.effect(() => () => {
        this.dataOwnerBook = undefined
      })
    })
  }

  /** 只用设置插件的归属记录：分配 id 时避开别的包的设置分区，转移归属时一起改 */
  private wireSettings(): void {
    this.ctx.inject(['gwbSettings'], (ctx) => {
      this.settingsOwnerBook = ctx.gwbSettings
      ctx.effect(() => () => {
        this.settingsOwnerBook = undefined
      })
    })
  }

  /** 命令插件是可选的，但没有它插件管理就没有任何对外接口 */
  private wireCommands(): void {
    this.ctx.inject(['gwbCommands'], (ctx) => {
      const commandBus = ctx.gwbCommands
      // inject 保证了它在，这句只是把类型收窄
      if (commandBus === undefined) return
      const registerCommand: RegisterCommand = (name, description, usage, handler) => {
        commandBus.register({ name, description, usage, plugin: PKG }, handler)
      }
      const registerBusyGuardedCommand: RegisterCommand = (name, description, usage, handler) => {
        commandBus.register({ name, description, usage, plugin: PKG }, (args) => this.busyGate.run(() => handler(args) as Promise<{ ok: boolean }> | { ok: boolean }))
      }
      this.registerHomeCommands(registerCommand, registerBusyGuardedCommand)
      this.registerSourceCommands(registerCommand, commandBus)
    })
  }

  /** 改 home 里的包与条目的命令；安装、卸载、升级、重新加载经过 BUSY 检查 */
  private registerHomeCommands(registerCommand: RegisterCommand, registerBusyGuardedCommand: RegisterCommand): void {
    registerCommand(
      LIST_COMMAND,
      'home 里装了哪些包（内核包与 cordis 除外）、各有哪些条目、有没有 peer 范围不包含当前内核或 peer 里写的别的包没满足的',
      `回执按包列，不列内核包 ${KERNEL_PACKAGE} 与 ${CORDIS_PACKAGE}（它们没有条目；内核包经 ${UPDATE_COMMAND} 的 specs 换，cordis 随它对齐）：包名、spec、条目（id、entryId、启停、是否 ACTIVE）、kernelRange（包的 package.json 里 peerDependencies["${KERNEL_PACKAGE}"] 写的范围，没写时没有这个字段）、kernelUntested（只标插件——keywords 含 gwb-plugin 的包：范围不包含运行中的内核就是 true，没写、写的不是 ^x.y.z 也算；别的包与清单读不到的包一律 false；^x.y.z 在主版本号为 0 时要求次版本号相同，≥1 时要求主版本号相同，并且不低于 x.y.z）、unmetPeers（只看插件 peer 里除了内核包与 ${CORDIS_PACKAGE} 之外的包，home 里没满足的列成 [{ pkg, range, installed? }]：没装（没有 installed 字段；peerDependenciesMeta 里 optional: true 的没装不算）、装着的版本不在范围里、或范围不是 ^x.y.z，range 原样照抄，范围规则同上；每个包都有这个字段，不是插件、清单读不到、全都满足时是空数组）。只报告，不拦加载。无参数`,
      () => this.list(),
    )

    registerBusyGuardedCommand(
      INSTALL_COMMAND,
      '往 home 装一个还没装的包并加一条条目',
      `一次 pnpm add 把包装进 home（home 的 package.json 里照 pnpm 默认写 ^ 范围），再加一条条目（默认启用）。包已在 home 的 dependencies 里直接报错：再加一条条目用 ${ADD_ENTRY_COMMAND}，换版本用 ${UPDATE_COMMAND} {"specs":{…}}。不装它的 peer，也不判断是不是库：装了没有 apply 的包，条目加载失败，在 ${LIST_COMMAND} 里看得到。回执 data { pkg, entryId }；失败时 error 里带 pnpm 输出的最后几行。参数 { pkg, spec? }（spec 是版本或 tag）；${BUSY_USAGE_NOTE}`,
      async (args) => {
        const argsObject = argsObjectOf(args, ['pkg', 'spec'])
        return this.install(requiredString(argsObject, 'pkg'), optionalString(argsObject, 'spec'))
      },
    )

    registerCommand(ADD_ENTRY_COMMAND, '给已装的包再加一条条目', '参数 { pkg, id? }。不给 id 就自动生成（磁盘上有本包留下的旧 id 时优先沿用）；给的 id 在条目树上已被占用、或磁盘上的数据与设置属于别的包，直接拒绝。回执 data { entryId }', async (args) => {
      const argsObject = argsObjectOf(args, ['pkg', 'id'])
      const entryId = await this.addEntry(requiredString(argsObject, 'pkg'), optionalString(argsObject, 'id'))
      return { ok: true, data: { entryId } }
    })

    registerCommand(
      TRANSFER_OWNER_COMMAND,
      '把一个 id 的数据与设置的归属转给另一个包',
      `同一个插件改了包名、要继续用旧数据与设置时调用它；数据目录与设置分区的归属一起改。数据插件（${DATA_PACKAGE}）与设置插件（${SETTINGS_PACKAGE}）都要装着，缺一个直接报错、哪一份都不转。参数 { id, pkg }：id 是条目 id（不带前缀的 id 或完整 entryId，条目树上不必有这条），pkg 是新的所属包名。回执 data { id, pkg }`,
      async (args) => {
        const argsObject = argsObjectOf(args, ['id', 'pkg'])
        return { ok: true, data: await this.transferOwner(requiredString(argsObject, 'id'), requiredString(argsObject, 'pkg')) }
      },
    )

    registerCommand(REMOVE_ENTRY_COMMAND, '删一条条目（不删包）', '参数 { entryId }', (args) => {
      this.removeEntry(requiredString(argsObjectOf(args, ['entryId']), 'entryId'))
      return { ok: true }
    })

    registerCommand(ENABLE_COMMAND, '启用一条条目', '参数 { entryId }', async (args) => {
      await this.enable(requiredString(argsObjectOf(args, ['entryId']), 'entryId'))
      return { ok: true }
    })

    registerCommand(DISABLE_COMMAND, '停用一条条目', '参数 { entryId }', async (args) => {
      await this.disable(requiredString(argsObjectOf(args, ['entryId']), 'entryId'))
      return { ok: true }
    })

    registerBusyGuardedCommand(
      REMOUNT_COMMAND,
      '重新加载一条条目：停用→等卸载完→启用→等加载完，一条命令做完',
      `参数 { entryId }（完整 entryId 或不带前缀的 id）。回执 { id, action, state }：action 是 remounted（在这条命令里做完，state 是重新加载后的 fiber 状态，ACTIVE 才算加载成功）或 deferred（目标是插件管理自己：先返回回执，下一个宏任务才重新加载，state 是动手前的状态，之后用 ${LIST_COMMAND} 核对 active）；操作条目树时抛错则回 ok: false，data 里 action 是 failed。原本停用的条目重新加载后是启用的；重新加载命令插件（gwb-commands）也在这条命令里做完；${BUSY_USAGE_NOTE}`,
      async (args) => {
        const result = await this.remount(requiredString(argsObjectOf(args, ['entryId']), 'entryId'))
        if (result.action === 'failed') return { ok: false, error: `条目 ${result.id} 重新加载失败：${result.state}`, data: result }
        return { ok: true, data: result }
      },
    )

    registerCommand(
      OUTDATED_COMMAND,
      '查已装的包哪些有新版本',
      `pnpm outdated。回执 data { updates: { 包名: { current, latest } } }，空对象表示全都最新；不含内核包 ${KERNEL_PACKAGE} 与 ${CORDIS_PACKAGE}（热升级不了，内核包用 ${UPDATE_COMMAND} 的 specs 换）。无参数`,
      () => this.outdated(),
    )

    registerBusyGuardedCommand(
      UPDATE_COMMAND,
      '升级 home 里已装的包（全部过期的、点名的几个、或按给定写法装，内核包也走这条），不重启、不整页重新加载',
      `${UPDATE_ARGS_USAGE}。home 的 package.json 里照 pnpm 默认写 ^ 范围（只有 ${CORDIS_PACKAGE} 写精确版本号）；清单里已有的 ^ 范围会挡住往回退版本，specs 退回旧版会在核对时回 ok: false。all 与 only：一次 pnpm add 把过期包升到 outdated 返回的精确版本；specs：一次 pnpm add 每项 <包名>@<写法>，不查 outdated，写法是准确版本号的，装完读 node_modules 里的清单核对，装上的不是那个号就回 ok: false、一条条目都不重新加载（tag 与 file: 不核对）。pnpm add 前后 home 里 node_modules/<包名> 指向的真实目录变了的包，条目在同一条命令里逐条停用→启用、重新加载成新版本（原本停用的跳过；插件管理自己那条在回执发出后才重新加载）：点了名的包归 updated（装的就是原来那一版、目录没变的也列出，entries 为空），没点名的（多半是 peer 写了被装的包的插件）归 dependents。不整页重新加载：界面要换成新代码，由调用方拿到回执后自己调 shell.reload。内核包 ${KERNEL_PACKAGE} 与 ${CORDIS_PACKAGE} 不在过期清单里，only 点了它们直接报错。specs 里有内核包时：内核包与其余包一次 pnpm add，再读装上的内核包 peerDependencies.cordis（必须是精确版本号）pnpm add ${CORDIS_PACKAGE}@<那个版本>，不重新加载任何条目——主进程里的内核换不掉，重启工作台后才生效，重启由人决定；回执另带 restartRequired（装上的内核版本与正在运行的不同时是 true）与 pluginsOutsideRange（keywords 含 gwb-plugin、peer 里内核包的范围不包含新内核或没写范围的插件）；内核包装上了而 cordis 没对齐时回 ok: false，data 带 { kernel: { from?, to } }，error 说明先别重启。specs 里写 ${CORDIS_PACKAGE} 直接报错。回执 data { updated: [{ pkg, from?, to, entries: [{ id, action, state }] }], dependents: [{ pkg, entries: [{ id, action, state }] }], selfDeferred, restartRequired?, pluginsOutsideRange?, note? }：specs 的 from 是装之前 node_modules 里清单的 version（读不到就没有），to 是装完读到的 version；失败时 error 里带 pnpm 输出的最后几行；${BUSY_USAGE_NOTE}`,
      (args) => this.update(updateArgsOf(args)),
    )

    registerBusyGuardedCommand(
      UNINSTALL_COMMAND,
      '卸载一个包：删除它的全部条目，再卸载包',
      `设置与数据留在磁盘上（只删一条条目调用 ${REMOVE_ENTRY_COMMAND}）。内核包与 ${CORDIS_PACKAGE} 不许卸载，直接报错。回执 data { pkg }；pnpm 失败时 error 说明条目已删几条、包还在，并带 pnpm 输出的最后几行。参数 { pkg }；${BUSY_USAGE_NOTE}`,
      (args) => this.uninstall(requiredString(argsObjectOf(args, ['pkg']), 'pkg')),
    )
  }

  /** 找插件与配包源的四条命令：不改 home，不经 BUSY 检查 */
  private registerSourceCommands(registerCommand: RegisterCommand, commandBus: GwbCommands): void {
    const deps: PackageSourcesDeps = {
      userNpmrc: this.npmrc.user,
      homeNpmrc: this.npmrc.home,
      runCommand: (name, args) => commandBus.run(name, args),
      log: this.log,
    }

    registerCommand(
      SEARCH_COMMAND,
      '列出全部配好的源上的插件（npm 标准检索）',
      `无参数。从哪条源装就在哪条源搜：${SOURCE_LIST_COMMAND} 列出的两层 npmrc 里的每条源（@godcreator 在前、其余按名字排）并发查，查成的并进 packages，没查成的在 note 里点名，一条失败不影响别的；全都没查成才 ok:false。只列插件：包自己的 keywords 里有 gwb-plugin 的。回执 data { packages: [{ pkg, version?, description? }], note? }`,
      async (args) => {
        argsObjectOf(args ?? {}, [])
        return searchPlugins(deps)
      },
    )

    registerCommand(
      SOURCE_ADD_COMMAND,
      '往机器级 npmrc 写一条包源（scope 路由），装第三方插件用',
      '已有同 scope 就原地替换。写的是 ~/.npmrc（机器级）：@godcreator 的路由本来就在那里，不许经这条命令改。参数 { scope, registry?, owner?, token? }：registry 直接给源地址；owner 走 gitea 的简便写法——拼成 <base>/api/packages/<owner>/npm/（base 取设置 gitea.base-url，取不到 http(s) 地址就回执 ok:false——装 gitea 插件配好它，或改给 registry），token 没给就取设置 gitea 分区的 token，取不到则回执 ok:false。token 行按源地址配对，同一个 token 配多条源不会重复写。回执 data { scope, registry, tokenWritten, replaced, lines（token 已遮掉）, note? }',
      async (args) => {
        const argsObject = argsObjectOf(args, ['scope', 'registry', 'owner', 'token'])
        return addSource(deps, requiredString(argsObject, 'scope'), {
          registry: optionalString(argsObject, 'registry'),
          owner: optionalString(argsObject, 'owner'),
          token: optionalString(argsObject, 'token'),
        })
      },
    )

    registerCommand(
      SOURCE_LIST_COMMAND,
      '列出包源：机器级与 home 级两份 npmrc 合起来看',
      '无参数。回执 { user, home, sources: [{ scope, registry, file, token }] }——file 是出处（user = 机器级 ~/.npmrc，home = <home>/.npmrc），pnpm 把两层合起来读、home 级同名行优先；token 只报有没有，不报值',
      async () => ({ ok: true, data: await listSources(deps) }),
    )

    registerCommand(
      SOURCE_REMOVE_COMMAND,
      '从机器级 npmrc 删掉一条包源',
      '参数 { scope }。token 行没有别的 scope 再指向它时一起删，还有就留着。@godcreator 不许删；机器级没有这条时回 ok:false 说明原因（包括「它在 home 级，要手工删」）。回执 data { scope, registry? }',
      (args) => removeSource(deps, requiredString(argsObjectOf(args, ['scope']), 'scope')),
    )
  }

  async list(): Promise<PluginPackageView[]> {
    const homeDependencies = await readHomeDependencies(this.homeDir)
    const reconciledPackages = reconcile(withoutKernelManaged(homeDependencies), readEntries(this.tree.store))
    const manifestsByPackage = new Map<string, unknown>()
    await this.readInstalledManifests(reconciledPackages.map((view) => view.pkg), manifestsByPackage)
    const installedVersions = await this.installedVersionsFor(manifestsByPackage)
    return reconciledPackages.map((view) => {
      const manifest = manifestsByPackage.get(view.pkg)
      return { ...view, ...kernelStatusInList(view.pkg, manifest, this.kernelVersion), ...peerStatusOf(manifest, installedVersions) }
    })
  }

  /** 没装的包读成 undefined */
  private async readInstalledManifests(pkgs: readonly string[], manifestsByPackage: Map<string, unknown>): Promise<void> {
    const manifests = await Promise.all(pkgs.map((pkg) => readInstalledPackageManifest(this.homeDir, pkg)))
    pkgs.forEach((pkg, index) => manifestsByPackage.set(pkg, manifests[index]))
  }

  /**
   * 包 → 装着的版本号。插件 peer 里点名、而 dependencies 与条目都没提到的包也去 `node_modules` 读一次清单；
   * 不合包名规则的键不拿去拼路径（`..` 之类会读到 `node_modules` 外面），按没装报
   */
  private async installedVersionsFor(manifestsByPackage: Map<string, unknown>): Promise<Map<string, string>> {
    const peeredButUnreadPackages = new Set<string>()
    for (const manifest of manifestsByPackage.values()) {
      for (const { pkg } of declaredPluginPeers(manifest)) if (!manifestsByPackage.has(pkg) && isPkgName(pkg)) peeredButUnreadPackages.add(pkg)
    }
    await this.readInstalledManifests([...peeredButUnreadPackages], manifestsByPackage)
    const installedVersions = new Map<string, string>()
    for (const [pkg, manifest] of manifestsByPackage) {
      const version = installedVersionOf(manifest)
      if (version !== undefined) installedVersions.set(pkg, version)
    }
    return installedVersions
  }

  /** 调用方写错（包名、版本范围不合规、包已经装了）直接抛；pnpm 失败、条目加不进去转成回执 */
  async install(pkg: string, spec?: string): Promise<Outcome<{ pkg: string; entryId: string }>> {
    const packageSpec = installSpec(pkg, spec)
    const installedSpec = (await readHomeDependencies(this.homeDir))[pkg]
    if (installedSpec !== undefined) {
      throw new Error(
        `${pkg} 已经装在 home 里（dependencies 里写的是 ${installedSpec}），install 只装还没装的包。再加一条条目用 ${ADD_ENTRY_COMMAND} {"pkg":"${pkg}"}；换版本用 ${UPDATE_COMMAND} {"specs":{"${pkg}":"<版本号、tag 或 file:路径>"}}`,
      )
    }

    const added = await this.addToHome([packageSpec], '')
    if (!added.ok) return added

    try {
      const entryId = await this.createEntry(pkg)
      // 不等加载，所以日志说「已加进」不说「已加载」
      this.log.info(`${packageSpec} 装上了，条目 ${entryId} 已加进 cordis.yml`)
      return { ok: true, data: { pkg, entryId } }
    } catch (err: unknown) {
      // 不回滚删包：删包比留着危险，而且删除时未必只删掉这一个
      const error = `${packageSpec} 装上了，但条目加不进 cordis.yml：${String(err)}。包留在 home 里，查看列表调用 ${LIST_COMMAND}`
      this.log.warn(error)
      return { ok: false, error }
    }
  }

  /**
   * `pnpm outdated --json` 的退出码 1 表示「存在过期包」，是结果不是失败。它不写文件，和写 home 的 pnpm 同时运行没有影响，所以不经 BUSY。
   * 内核包与 cordis 从结果里拿掉：`all` / `only` 升不了它们
   */
  async outdated(): Promise<Outcome<{ updates: Record<string, UpdateInfo> }>> {
    const pnpmLookup = await locatePnpm()
    if (!pnpmLookup.ok) return { ok: false, error: pnpmLookup.error }

    const pnpmRun = await runPnpmCapture({ pnpm: pnpmLookup.file, cwd: this.homeDir, args: ['outdated', '--json'] })
    const withStderr = (message: string): string =>
      pnpmRun.stderrTail === '' ? message : `${message}\n${pnpmRun.stderrTail}`
    if (pnpmRun.exitCode === null) return { ok: false, error: withStderr(`pnpm 启动失败（退出码 ${String(pnpmRun.exitCode)}）`) }
    if (pnpmRun.exitCode !== 0 && pnpmRun.exitCode !== 1) {
      return { ok: false, error: withStderr(`pnpm outdated 失败（退出码 ${String(pnpmRun.exitCode)}）`) }
    }
    const updates = parseOutdated(pnpmRun.stdout)
    if (updates === undefined) {
      return { ok: false, error: withStderr('pnpm outdated 的输出解析不了（需要的是 JSON）——pnpm 升大版本时输出格式可能变了') }
    }
    return { ok: true, data: { updates: withoutKernelManaged(updates) } }
  }

  /** 参数写错直接抛；下面每一种失败都是正常结果，转成回执 */
  async update(args: UpdateArgs): Promise<Outcome<Updated> | KernelInstalledButCordisNot> {
    if ('specs' in args) return this.updateToSpecs(args.specs)
    return this.updateOutdated('only' in args ? args.only : undefined)
  }

  /** `only` 里包名不合规、不在 home 的 dependencies 里、是内核包或 cordis 直接抛；不给 `only` 就升全部过期包 */
  private async updateOutdated(only: readonly string[] | undefined): Promise<Outcome<Updated>> {
    const homeDependencies = await readHomeDependencies(this.homeDir)
    if (only !== undefined) {
      for (const pkg of only) assertPkgName(pkg)
      assertOnlyPackagesInHome(only, homeDependencies)
      assertOnlyNotKernelManaged(only)
    }

    const checked = await this.outdated()
    if (!checked.ok) return checked

    const plan = planOutdatedUpdate(checked.data.updates, only)
    const notes: string[] = []
    if (plan.alreadyLatest.length > 0) notes.push(`only 里这几个已是最新，没动：${plan.alreadyLatest.join('、')}`)
    if (plan.versionChanges.size === 0) {
      return { ok: true, data: { updated: [], dependents: [], selfDeferred: false, note: ['全都最新', ...notes].join('；') } }
    }

    const versionChanges: VersionChangesAfterAdd = { ok: true, changes: plan.versionChanges }
    return this.addThenRemount(plan.addSpecs, [...plan.versionChanges.keys()], homeDependencies, notes, () => Promise.resolve(versionChanges))
  }

  /** 包名或写法不合规、包不在 home 的 dependencies 里、写了 cordis 直接抛 */
  private async updateToSpecs(specs: Readonly<Record<string, string>>): Promise<Outcome<Updated> | KernelInstalledButCordisNot> {
    const homeDependencies = await readHomeDependencies(this.homeDir)
    const plan = planSpecsUpdate(specs, homeDependencies)
    if (plan.includesKernel) return this.updateWithKernel(plan, specs)
    const versionsBefore = await this.readInstalledVersions(plan.pkgs)
    const versionChangesAfterInstall = async (): Promise<VersionChangesAfterAdd> => versionChangesAfterAdd(specs, versionsBefore, await this.readInstalledVersions(plan.pkgs))
    return this.addThenRemount(plan.addSpecs, plan.pkgs, homeDependencies, [], versionChangesAfterInstall)
  }

  /**
   * specs 里有内核包：一次 pnpm add 装上 specs 里的全部包 → 照装上的内核包 peer 里的 cordis 再 pnpm add 一次 → 核对 cordis。
   * 主进程里的内核换不掉，不重新加载任何条目
   */
  private async updateWithKernel(plan: SpecsUpdatePlan, specs: Readonly<Record<string, string>>): Promise<Outcome<Updated> | KernelInstalledButCordisNot> {
    const pkgs = plan.pkgs
    const versionsBefore = await this.readInstalledVersions([...pkgs, CORDIS_PACKAGE])
    const added = await this.addToHome(plan.addSpecs, '一条条目都没动')
    if (!added.ok) return added

    const versionChanges = versionChangesAfterAdd(specs, versionsBefore, await this.readInstalledVersions(pkgs))
    if (!versionChanges.ok) return this.failed(`${versionChanges.error}。一条条目都没动，cordis 没动，先别重启`)
    const kernel = versionChanges.changes.get(KERNEL_PACKAGE)!

    const target = kernelUpgradeTargetOf(await readInstalledPackageManifest(this.homeDir, KERNEL_PACKAGE))
    if (!target.ok) return this.kernelInstalledButCordisNot(`${KERNEL_PACKAGE} 装上了，但${target.error}。cordis 没动，home 里的内核与 cordis 可能对不上，先别重启`, kernel)
    // cordis 要正好等于内核包 peer 里的那个版本，清单里写精确版本号：它是预发布版，写成 ^ 范围时别的 rc 也算满足
    const cordisAdded = await this.addToHome(
      ['--save-exact', installSpec(CORDIS_PACKAGE, target.cordisVersion)],
      `内核包已经是 ${target.kernelVersion}，home 根上的 cordis 没对齐到它要的 ${target.cordisVersion}，先别重启`,
    )
    if (!cordisAdded.ok) return { ok: false, error: cordisAdded.error, data: { kernel } }
    const cordisInstalled = installedVersionOf(await readInstalledPackageManifest(this.homeDir, CORDIS_PACKAGE))
    const cordisMismatch = installedVersionMismatch(CORDIS_PACKAGE, target.cordisVersion, cordisInstalled)
    if (cordisMismatch !== undefined) return this.kernelInstalledButCordisNot(`${cordisMismatch}。内核包已经是 ${target.kernelVersion}，先别重启`, kernel)

    const updated: UpdatedPackage[] = [
      ...pkgs.map<UpdatedPackage>((pkg) => ({ pkg, ...versionChanges.changes.get(pkg)!, entries: [] })),
      { pkg: CORDIS_PACKAGE, ...versionChangeOf(versionsBefore.get(CORDIS_PACKAGE), target.cordisVersion), entries: [] },
    ]
    const pluginsOutsideRange = pluginsOutsideKernelRange(await this.readHomePackageManifests(), target.kernelVersion)
    const restartRequired = target.kernelVersion !== this.kernelVersion
    this.log.info(
      `装了 ${updated.map(describeVersionChange).join('，')}；有内核包，没有重新加载任何条目` +
        (restartRequired ? '，重启工作台后生效' : '') +
        (pluginsOutsideRange.length === 0 ? '' : `；peer 范围不包含新内核的插件：${pluginsOutsideRange.join('、')}`),
    )
    const note = restartRequired
      ? `装了内核包 ${KERNEL_PACKAGE} ${target.kernelVersion}：主进程里的内核换不掉，这次没有重新加载任何条目，这 ${updated.length} 个包重启工作台后才都换成新装的版本；重启由人决定`
      : `装上的就是正在运行的内核 ${this.kernelVersion}，不用重启；这次没有重新加载任何条目`
    return { ok: true, data: { updated, dependents: [], selfDeferred: false, restartRequired, pluginsOutsideRange, note } }
  }

  private failed(error: string): { ok: false; error: string } {
    this.log.warn(error)
    return { ok: false, error }
  }

  private kernelInstalledButCordisNot(error: string, kernel: VersionChange): KernelInstalledButCordisNot {
    this.log.warn(error)
    return { ok: false, error, data: { kernel } }
  }

  /**
   * 一次 pnpm add → 真实目录变了的包逐条重新加载（点了名的在前、别的在后）；本插件自己推迟到回执之后。不整页重新加载：
   * shell.reload 在主进程里同步重载页面，经页面调用这条命令的调用方收不到回执，所以整页重新加载交给调用方。
   * `versionChangesAfterInstall` 在 pnpm add 成功之后、重新加载之前调用，给出回执里每个包的 from / to
   */
  private async addThenRemount(
    addSpecs: readonly string[],
    requestedPackages: readonly string[],
    homeDependencies: Readonly<Record<string, string>>,
    notes: string[],
    versionChangesAfterInstall: () => Promise<VersionChangesAfterAdd>,
  ): Promise<Outcome<Updated>> {
    const homePackages = Object.keys(homeDependencies).filter(isPkgName)
    const directoriesBefore = await this.readInstalledDirectories(homePackages)
    const added = await this.addToHome(addSpecs, '一条条目都没动')
    if (!added.ok) return added
    const versionChanges = await versionChangesAfterInstall()
    if (!versionChanges.ok) return this.failed(`${versionChanges.error}。一条条目都没动`)

    // 升完不重新加载，运行着的还是旧版本，等于没升；旧版本目录也不会一直留着（pnpm 默认约 7 天后清掉）。所以换了目录的每条条目都在这条命令里重新加载
    const targets = packagesToRemount(directoriesBefore, await this.readInstalledDirectories(homePackages), requestedPackages, this.tree.store, ownEntryId(this.ctx))
    const { updated, dependents, ownEntry } = await this.remountUpgradedEntries(targets.updated, versionChanges.changes, targets.dependents)
    const summary =
      updated.map(describeVersionChange).join('，') +
      (dependents.length === 0 ? '' : `；跟着重新加载 ${dependents.map((d) => d.pkg).join('、')}`)
    if (ownEntry !== undefined) remountSelfLater(this.tree, ownEntry.id, this.log)
    this.log.info(`升级完成：${summary}${ownEntry === undefined ? '' : `；插件管理自己（${ownEntry.id}）在回执之后重新加载`}`)
    return { ok: true, data: { updated, dependents, selfDeferred: ownEntry !== undefined, ...noteOf(notes) } }
  }

  /** home 的 dependencies 里每个包 → 它装在 node_modules 里的清单（没装的是 undefined） */
  private async readHomePackageManifests(): Promise<Map<string, unknown>> {
    const manifestsByPackage = new Map<string, unknown>()
    await this.readInstalledManifests(Object.keys(await readHomeDependencies(this.homeDir)), manifestsByPackage)
    return manifestsByPackage
  }

  /**
   * 包 → `node_modules/<包名>` 指向的真实目录（没装的是 undefined）。`update` 在 `pnpm add` 前后各读一次，
   * 变了的包跟着重新加载
   */
  private async readInstalledDirectories(pkgs: readonly string[]): Promise<InstalledDirectories> {
    const directories = await Promise.all(pkgs.map((pkg) => installedPackageRealpath(this.homeDir, pkg)))
    return new Map(pkgs.map((pkg, index) => [pkg, directories[index]]))
  }

  /** 包 → `node_modules/<包名>/package.json` 里的 version（没装的是 undefined）。`update` 的 specs 在 `pnpm add` 前后各读一次 */
  private async readInstalledVersions(pkgs: readonly string[]): Promise<InstalledVersions> {
    const manifests = await Promise.all(pkgs.map((pkg) => readInstalledPackageManifest(this.homeDir, pkg)))
    return new Map(pkgs.map((pkg, index) => [pkg, installedVersionOf(manifests[index])]))
  }

  /** 逐条重新加载：先点了名的包，再跟着重新加载的包；本插件自己那条（启用着的）只记 deferred，交给调用方在回执之后处理 */
  private async remountUpgradedEntries(
    packages: readonly PackageEntries[],
    versionChanges: ReadonlyMap<string, VersionChange>,
    plannedDependentPackages: readonly PackageEntries[],
  ): Promise<{ updated: UpdatedPackage[]; dependents: DependentPackage[]; ownEntry: PlannedEntry | undefined }> {
    let ownEntry: PlannedEntry | undefined
    const remountEntriesOf = async (plannedEntries: readonly PlannedEntry[]): Promise<RemountedEntry[]> => {
      const entries: RemountedEntry[] = []
      for (const entry of plannedEntries) {
        if (entry.self && !entry.disabled) {
          ownEntry = entry
          entries.push({ id: entry.id, action: 'deferred', state: fiberStateOf(this.tree.store[entry.id]) })
          continue
        }
        entries.push(await this.remountPlanned(entry))
      }
      return entries
    }
    const updated: UpdatedPackage[] = []
    for (const plannedPackage of packages) {
      updated.push({ pkg: plannedPackage.pkg, ...versionChanges.get(plannedPackage.pkg)!, entries: await remountEntriesOf(plannedPackage.entries) })
    }
    const dependents: DependentPackage[] = []
    for (const plannedDependent of plannedDependentPackages) {
      dependents.push({ pkg: plannedDependent.pkg, entries: await remountEntriesOf(plannedDependent.entries) })
    }
    return { updated, dependents, ownEntry }
  }

  /** 本来就停用的跳过（保持停用），修改条目树时抛出的错误转成 failed */
  private async remountPlanned(entry: PlannedEntry): Promise<RemountedEntry> {
    if (entry.disabled) return { id: entry.id, action: 'skipped', state: 'disabled' }
    return remountNow(this.tree, entry.id, this.log)
  }

  async remount(entryId: string): Promise<RemountedEntry> {
    const id = this.existingBareId(entryId)
    return remountOne(this.tree, id, bareId(ownEntryId(this.ctx)), this.log)
  }

  /** 包没装（调用方写错了）、是内核包或 cordis 直接抛；删条目与 pnpm 两步的失败转成回执 */
  async uninstall(pkg: string): Promise<Outcome<{ pkg: string }>> {
    assertPkgName(pkg)
    if (KERNEL_MANAGED_PACKAGES.has(pkg)) {
      throw new Error(`${pkg} 是 home 运行必需的包，不许卸载：卸掉之后 home 启动不了。内核包用 ${UPDATE_COMMAND} {"specs":{"${KERNEL_PACKAGE}":"<版本号>"}} 换，${CORDIS_PACKAGE} 随它对齐`)
    }
    const homeDependencies = await readHomeDependencies(this.homeDir)
    if (homeDependencies[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，无法卸载。只删条目请调用 ${REMOVE_ENTRY_COMMAND}。`)
    }

    // 先删条目：tree.remove 写回 yml 并当场卸载 fiber，依赖这个包的插件随之被 cordis 卸载
    const removedIds = entriesForPackage(this.tree.store, pkg)
    for (const id of removedIds) this.tree.remove(id)

    const pnpmLookup = await locatePnpm()
    if (!pnpmLookup.ok) return this.failed(`卸不了 ${pkg}：${pnpmLookup.error}。条目已删除 ${removedIds.length} 条，包还在 home 里`)
    const pnpmRun = await this.applyToHome(pnpmLookup.file, { remove: [pkg] })
    if (!pnpmRun.ok) {
      // 不回滚：包会出现在「已装、没有条目」那一组里，重试加条目即可
      return this.failed(withTail(`pnpm remove ${pkg} 失败（退出码 ${String(pnpmRun.exitCode)}）。条目已删除 ${removedIds.length} 条，包还在 home 里`, pnpmRun.tail))
    }

    this.log.info(`${pkg} 卸载了：删除 ${removedIds.length} 条条目，包已从 home 移除。设置与数据留在磁盘上`)
    return { ok: true, data: { pkg } }
  }

  /** 包没装、id 已被占用、id 的数据或设置属于别的包，都会抛 */
  async addEntry(pkg: string, id?: string): Promise<string> {
    assertPkgName(pkg)
    const homeDependencies = await readHomeDependencies(this.homeDir)
    if (homeDependencies[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，加不了条目。先调用 ${INSTALL_COMMAND}，或者自己去 home 里 pnpm add。`)
    }
    const entryId = await this.createEntry(pkg, id)
    this.log.info(`条目 ${entryId}（${pkg}）加进 cordis.yml 了`)
    return entryId
  }

  /** 数据插件或设置插件没装就抛错、哪一份都不转；`id` 不要求条目树上有这条 */
  async transferOwner(id: string, pkg: string): Promise<{ id: string; pkg: string }> {
    assertPkgName(pkg)
    const bareEntryId = bareId(id)
    assertId(bareEntryId)
    const dataOwnerBook = this.dataOwnerBook
    const settingsOwnerBook = this.settingsOwnerBook
    if (dataOwnerBook === undefined || settingsOwnerBook === undefined) {
      const missing = [dataOwnerBook === undefined ? DATA_PACKAGE : undefined, settingsOwnerBook === undefined ? SETTINGS_PACKAGE : undefined].filter((one) => one !== undefined)
      throw new Error(`没装 ${missing.join('、')}：数据与设置的归属要一起转，缺一个就哪一份都不转`)
    }
    await dataOwnerBook.transferOwner(bareEntryId, pkg)
    await settingsOwnerBook.transferOwner(bareEntryId, pkg)
    this.log.info(`${bareEntryId} 的数据与设置的归属已转给 ${pkg}`)
    return { id: bareEntryId, pkg }
  }

  /** 两份归属记录合并：id → 登记为其归属的包（每份记录各一个，所以可能有两个） */
  private async idOwners(): Promise<IdOwners> {
    const ownersById: Record<string, string[]> = {}
    for (const ownerBook of [this.dataOwnerBook, this.settingsOwnerBook]) {
      if (ownerBook === undefined) continue
      for (const [id, pkg] of Object.entries(await ownerBook.owners())) (ownersById[id] ??= []).push(pkg)
    }
    return ownersById
  }

  removeEntry(entryId: string): void {
    const id = this.existingBareId(entryId)
    this.tree.remove(id)
    this.log.info(`条目 ${id} 已删（只删这一条，包没动；要连包一起卸载，调用 ${UNINSTALL_COMMAND}）`)
  }

  async enable(entryId: string): Promise<void> {
    // null 表示删掉这个字段，loader 的 update 把 null 当作删除
    const id = this.existingBareId(entryId)
    await this.tree.update(id, { disabled: null })
    this.log.info(`条目 ${id} 已启用`)
  }

  async disable(entryId: string): Promise<void> {
    const id = this.existingBareId(entryId)
    await this.tree.update(id, { disabled: true })
    this.log.info(`条目 ${id} 已停用`)
  }

  /** 完整 entryId 与不带前缀的 id 都接受，返回不带前缀的 id；条目树上没有就抛错 */
  private existingBareId(entryId: string): string {
    const id = bareId(entryId)
    if (this.tree.store[id] === undefined) {
      throw new Error(`cordis.yml 里没有 id 是 ${JSON.stringify(id)} 的条目。查看列表调用 ${LIST_COMMAND}。`)
    }
    return id
  }

  /** id 一定显式给：不给的话 loader 每次启动生成一个新的随机 id，按 id 分区的设置与数据每启动一次就新建一份 */
  private async createEntry(pkg: string, id?: string): Promise<string> {
    // 磁盘上的归属记录在条目删除后仍然保留，只按条目树判断重复会把别的包的数据分给这条条目
    const owners = await this.idOwners()
    const idsInTree = new Set(Object.keys(this.tree.store))
    let chosenId: string
    if (id === undefined) {
      chosenId = pickId(pkg, idsInTree, owners)
    } else {
      assertIdUsable(id, pkg, idsInTree, owners)
      chosenId = id
    }

    // 不 await：create 返回的 promise 包含加载，inject 满足不了的插件永远加载不完；写进 yml 在第一个 await 之前就同步安排好了。
    // 每次传一个新对象：create 会把它原样放进 group.data，共用一个对象等于两条条目共享配置
    void this.tree.create({ id: chosenId, name: pkg }, null).catch((err: unknown) => {
      this.log.warn(`条目 ${chosenId}（${pkg}）加进 cordis.yml 了，但没加载起来：${String(err)}`)
    })
    return this.fullEntryIdOf(chosenId)
  }

  /** `tree.create` 没有被 await，拿不到它返回的完整 id，按本插件条目的前缀自己拼 */
  private fullEntryIdOf(bareEntryId: string): string {
    const ownFullId = ownEntryId(this.ctx)
    const lastSeparator = ownFullId.lastIndexOf(':')
    return lastSeparator === -1 ? bareEntryId : `${ownFullId.slice(0, lastSeparator + 1)}${bareEntryId}`
  }

  /**
   * 找 pnpm、一次 `pnpm add <addArgs…>`。失败回一句说明：退出码那句，接着 `consequence`（这时 home 处在什么状态），
   * 最后是 pnpm 输出的最后几行
   */
  private async addToHome(addArgs: readonly string[], consequence: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const withConsequence = (message: string): string => (consequence === '' ? message : `${message}。${consequence}`)
    const pnpmLookup = await locatePnpm()
    if (!pnpmLookup.ok) return this.failed(withConsequence(pnpmLookup.error))
    // 一次装完：pnpm 读改写 home 的 package.json，逐个包启动进程与并发安装一样会互相覆盖
    this.log.info(`用 ${describePnpm(pnpmLookup)} 安装 ${addArgs.join(' ')}`)
    const pnpmRun = await this.applyToHome(pnpmLookup.file, { add: addArgs })
    if (pnpmRun.ok) return { ok: true }
    const failure = describeAddFailure(`pnpm add ${addArgs.join(' ')}`, pnpmRun)
    return this.failed(withTail(withConsequence(failure.error), failure.tail))
  }

  /**
   * 改 home 的唯一入口：安装、升级、卸载都经这里运行 pnpm。调用它的命令都经过 BUSY 检查——两个写 home 的 pnpm 同时运行会丢改动，
   * 而且都退出码 0。add 照 pnpm 默认在清单里写 `^` 范围（0.x.y 的 y 变了不破坏兼容）；只有对齐 cordis 那一次自己带 `--save-exact`
   */
  private applyToHome(pnpm: string, change: { add: readonly string[] } | { remove: readonly string[] }): Promise<PnpmResult> {
    const args = 'add' in change ? ['add', ...change.add] : ['remove', ...change.remove]
    return runPnpm({ pnpm, cwd: this.homeDir, args })
  }
}

/** pnpm 输出的最后几行接在说明后面，另起一行 */
function withTail(message: string, tail: string | undefined): string {
  return tail === undefined ? message : `${message}\n${tail}`
}

/** 包名作键的表去掉内核包与 cordis：它们不进 `list` 与 `outdated` */
function withoutKernelManaged<T>(byPackage: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(byPackage).filter(([pkg]) => !KERNEL_MANAGED_PACKAGES.has(pkg)))
}

const UPDATE_ARG_KEYS = ['all', 'only', 'specs'] as const

/** 报错与 usage 共用的一句用法 */
const UPDATE_ARGS_USAGE = `参数三选一、恰好给一个：{ "all": true } 把 outdated 查到的过期包全升到精确 latest；{ "only": ["<包名>", …] } 只升这几个过期包（不在 home 的 dependencies 里的名字、内核包与 cordis 直接报错，已是最新的写进 note）；{ "specs": { "<包名>": "<版本号、tag 或 file:<绝对路径>>" } } 给已装的包按给定写法装（包不在 home 的 dependencies 里直接报错，首次安装用 ${INSTALL_COMMAND}；升内核写 { "specs": { "${KERNEL_PACKAGE}": "latest" } }）`

/** 三种参数恰好给一种；不给、给了两种、认不出的键、值的类型不对，都直接抛错并带上用法 */
function updateArgsOf(args: unknown): UpdateArgs {
  if (args === undefined || args === null) throw new Error(`没给参数：要升全部就给 {"all":true}。${UPDATE_ARGS_USAGE}`)
  const argsObject = argsObjectOf(args, UPDATE_ARG_KEYS, UPDATE_ARGS_USAGE)
  const givenKeys = UPDATE_ARG_KEYS.filter((key) => argsObject[key] !== undefined)
  if (givenKeys.length === 0) throw new Error(`没给参数：要升全部就给 {"all":true}。${UPDATE_ARGS_USAGE}`)
  if (givenKeys.length > 1) throw new Error(`all、only、specs 只能给一个，这次给了 ${givenKeys.join('、')}。${UPDATE_ARGS_USAGE}`)

  if (givenKeys[0] === 'all') {
    if (argsObject['all'] !== true) throw new Error(`all 只能是 true。${UPDATE_ARGS_USAGE}`)
    return { all: true }
  }
  if (givenKeys[0] === 'only') {
    const only = argsObject['only']
    if (!Array.isArray(only) || only.some((item) => typeof item !== 'string' || item === '')) {
      throw new Error('only 要是个非空字符串数组，比如 { "only": ["@godcreator/gwb-hello"] }')
    }
    return { only: only as string[] }
  }
  const specs = argsObject['specs']
  if (!isRecord(specs) || Object.keys(specs).length === 0 || Object.values(specs).some((spec) => typeof spec !== 'string' || spec === '')) {
    throw new Error('specs 要是个非空对象，键是包名、值是非空字符串写法，比如 { "specs": { "@godcreator/gwb-hello": "0.3.1" } }')
  }
  return { specs: specs as Record<string, string> }
}

function describeVersionChange(updated: UpdatedPackage): string {
  return `${updated.pkg} ${updated.from ?? '（装之前读不到版本号）'} → ${updated.to}`
}

/** 参数要是对象、只许出现 `allowedKeys` 里的键；认不出的键直接抛错，不静默忽略 */
function argsObjectOf(args: unknown, allowedKeys: readonly string[], usage?: string): Record<string, unknown> {
  if (!isRecord(args)) throw new Error('参数要是一个对象，比如 { "entryId": "commands" }')
  const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.includes(key))
  if (unknownKeys.length > 0) {
    const accepted = allowedKeys.length === 0 ? '这条命令无参数' : `认得的参数是 ${allowedKeys.join('、')}`
    throw new Error(`认不出参数 ${unknownKeys.join('、')}：${accepted}。${usage ?? ''}`)
  }
  return args
}

function requiredString(argsObject: Record<string, unknown>, key: string): string {
  const value = argsObject[key]
  if (typeof value !== 'string' || value === '') throw new Error(`${key} 要是个非空字符串`)
  return value
}

function optionalString(argsObject: Record<string, unknown>, key: string): string | undefined {
  const value = argsObject[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value === '') throw new Error(`${key} 给了就要是个非空字符串`)
  return value
}

declare module 'cordis' {
  interface Context {
    gwbPluginManager: PluginManagerPresence
  }
}
