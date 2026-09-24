import os from 'node:os'
import type { GwbContext, GwbResult } from '@godcreator/gwb-kernel-desktop'
import { isRecord, noteOf, requireKernel } from './vocab.js'
// 这几条 type import 只为引入对方的 `declare module 'cordis'`（commands 另取一个类型）；这些插件写在 peer 里，数据、设置、说明书标 optional，都经嵌套注入使用
import type { GwbCommands } from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-data'
import type {} from '@godcreator/gwb-settings'
import type {} from '@godcreator/gwb-skills'
import { npmrcFiles, readHomeDependencies, readInstalledPackageManifest } from './home.js'
import { assertId, assertIdUsable, assertPkgName, bareId, installSpec, isPkgName, pickId, type IdOwners } from './ids.js'
import { installedVersionOf, readEntries, reconcile, type PluginPackageView } from './inventory.js'
import { describeAddFailure, describePnpm, locatePnpm, runPnpm, runPnpmCapture, type PnpmResult } from './pnpm.js'
import { parseOutdated, type UpdateInfo } from './outdated.js'
import { entriesForPackage } from './uninstall.js'
import { ownEntryId, treeOf, type EntryTreeLike } from './tree.js'
import { BusyGate } from './busy.js'
import { fiberStateOf } from './fiber.js'
import { planUpdateAll, type KernelManagedPackage, type PlannedEntry, type UpdateAllPlan } from './update-all.js'
import { remountNow, remountOne, remountSelfLater, type RemountedEntry } from './remount.js'
import { KERNEL_PACKAGE } from './kernel-compat.js'
import { CORDIS_PACKAGE, installedVersionMismatch, kernelStatusInList, kernelUpgradeTargetOf, pluginsOutsideKernelRange, versionChangeOf, type VersionChange } from './kernel-upgrade.js'
import { declaredPluginPeers, peerStatusOf } from './peers.js'
import { addSource, listSources, removeSource, searchPlugins, type PackageSourcesDeps } from './package-sources.js'

export type { EntrySnapshot, PluginPackageView } from './inventory.js'
export type { RemountedEntry } from './remount.js'
export type { KernelCompatStatus } from './kernel-compat.js'
export type { VersionChange } from './kernel-upgrade.js'
export type { KernelManagedPackage } from './update-all.js'
export type { PeerStatus, UnmetPeer } from './peers.js'
export type { SearchReceipt, SourceAddResult, SourceListResult, SourceRemoveResult, SourceReport } from './package-sources.js'
export type { SearchRow } from './search.js'

// 开发套件复用的规则：它 import 这几个，不另存一份
export { locatePnpm } from './pnpm-location.js'
export { declaredKernelRange, isCaretRange, KERNEL_PACKAGE, kernelRangeCovers } from './kernel-compat.js'
export { tailLines } from './pnpm.js'

/** 外壳的整页重载命令。按命令名查找，不 import 外壳的常量：那会让外壳成为运行时依赖 */
const SHELL_RELOAD_COMMAND = 'shell.reload'

const NAME = 'gwb-plugin-manager'

/** 登记命令时填的所属插件：包名 */
const PKG = '@godcreator/gwb-plugin-manager'

/** 经过 BUSY 检查的那几条命令的 usage 末尾都带这一句 */
const BUSY_USAGE_NOTE = '同一时刻只允许一个变更，重入回 { ok:false, error:"BUSY…" }'

export const LIST_COMMAND = 'plugin-manager.list'
export const INSTALL_COMMAND = 'plugin-manager.install'
export const ADD_ENTRY_COMMAND = 'plugin-manager.add-entry'
export const REMOVE_ENTRY_COMMAND = 'plugin-manager.remove-entry'
export const ENABLE_COMMAND = 'plugin-manager.enable'
export const DISABLE_COMMAND = 'plugin-manager.disable'
export const REMOUNT_COMMAND = 'plugin-manager.remount'
export const OUTDATED_COMMAND = 'plugin-manager.outdated'
export const UPDATE_ALL_COMMAND = 'plugin-manager.update-all'
export const UPDATE_KERNEL_COMMAND = 'plugin-manager.update-kernel'
export const UNINSTALL_COMMAND = 'plugin-manager.uninstall'
export const TRANSFER_OWNER_COMMAND = 'plugin-manager.transfer-owner'
export const SEARCH_COMMAND = 'plugin-manager.search'
export const SOURCE_ADD_COMMAND = 'plugin-manager.source.add'
export const SOURCE_LIST_COMMAND = 'plugin-manager.source.list'
export const SOURCE_REMOVE_COMMAND = 'plugin-manager.source.remove'

/**
 * 服务 `gwbPluginManager` 的值：只表示插件管理装了（别的插件 inject 它，跟着它一起加载、卸载），上面没有字段。
 * 命令有没有破坏性变化看插件管理的版本号
 */
export type PluginManagerPresence = Record<string, never>

const PRESENCE: PluginManagerPresence = {}

/** 转移归属的回执。`data` / `settings` 是 false 说明对应的插件没装、那部分没有处理 */
export interface TransferOwnerResult {
  id: string
  pkg: string
  data: boolean
  settings: boolean
}

/** 安装的回执 */
export interface InstallResult {
  ok: boolean
  pkg: string
  /** 成功才有：新加条目的完整 entryId */
  entryId?: string
  /** 失败时的原因 */
  error?: string
  /** pnpm 失败时输出的最后几行，失败原因在里面 */
  tail?: string
}

/** 查新版本的回执 */
export interface OutdatedReceipt {
  ok: boolean
  /** 成功才有：包名 → 新旧版本信息。**空对象 = 全都最新**，与「查询失败」区分开 */
  updates?: Record<string, UpdateInfo>
  /** 失败时的原因 */
  error?: string
}

/** 一键热升级中升级了的一个包 */
export interface UpdatedPackage {
  pkg: string
  from: string
  to: string
  /** 它的每条条目各自的处理结果 */
  entries: RemountedEntry[]
}

/** 一键热升级中没升级、但 peer 里写了换了目录的包，跟着重新加载的一个包 */
export interface DependentPackage {
  pkg: string
  /** 它 peer 里写了的、这次换了目录的包（升级了的，或同样跟着重新加载的），按包名排 */
  because: string[]
  /** 它的每条条目各自的处理结果 */
  entries: RemountedEntry[]
}

/** 一键热升级的回执 */
export interface UpdateAllResult {
  ok: boolean
  /** 升级了的包。pnpm 失败时为空——没有升级任何包、没有改动任何条目 */
  updated: UpdatedPackage[]
  /** 跟着重新加载的包，在 `updated` 之后处理。没有、或 pnpm 失败时为空 */
  dependents: DependentPackage[]
  /** 本插件自己在升级或跟着重新加载的包里：它的条目在回执发出后才重新加载，重新加载完再整页重载 */
  selfDeferred: boolean
  /**
   * 整页重载是否执行：`done` 表示 `shell.reload` 已经执行；`deferred` 表示等本插件自己重新加载完再执行；
   * `unavailable` 表示命令表里没有它（或它执行失败），界面要手动刷新——原因在 `note` 里。
   * 没有升级任何包或整体失败时，没有这个字段
   */
  reload?: 'done' | 'deferred' | 'unavailable'
  /** 过期了、但版本由内核决定而没升的内核包与 cordis；过期清单里没有它们时没有这个字段 */
  kernelManaged?: KernelManagedPackage[]
  /** 需要提醒的情况：全都最新、only 里列出但不在过期清单里的包、内核管的包要用哪条命令升、界面要手动刷新 */
  note?: string
  /** 失败时的原因 */
  error?: string
  /** pnpm 失败时输出的最后几行，失败原因在里面 */
  tail?: string
}

/** 升内核的回执 */
export interface UpdateKernelResult {
  ok: boolean
  /** 成功时有；装 cordis 失败时也有（内核包已经装上了） */
  kernel?: VersionChange
  /** 成功才有 */
  cordis?: VersionChange
  /** 成功才有：主进程里的内核换不掉，重启工作台后才生效 */
  restartRequired?: boolean
  /** 成功才有：home 里 peer 范围不包含新内核（或没写范围）的插件，按包名排 */
  pluginsOutsideRange?: string[]
  note?: string
  /** 失败时的原因 */
  error?: string
  /** pnpm 失败时输出的最后几行，失败原因在里面 */
  tail?: string
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
  /** 命令插件存在才有。一键热升级用它执行 `shell.reload`，包括本插件自己重新加载之后那一次 */
  private commandBus: GwbCommands | undefined

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
      this.commandBus = commandBus
      ctx.effect(() => () => {
        this.commandBus = undefined
      })
      const registerCommand: RegisterCommand = (name, description, usage, handler) => {
        ctx.effect(() => commandBus.register({ name, description, usage, plugin: PKG }, handler))
      }
      const registerBusyGuardedCommand: RegisterCommand = (name, description, usage, handler) => {
        ctx.effect(() => commandBus.register({ name, description, usage, plugin: PKG }, (args) => this.busyGate.run(() => handler(args) as Promise<{ ok: boolean }> | { ok: boolean })))
      }
      this.registerHomeCommands(registerCommand, registerBusyGuardedCommand)
      this.registerSourceCommands(registerCommand, commandBus)
    })
  }

  /** 改 home 里的包与条目的命令；安装、卸载、一键热升级、升内核、重新加载经过 BUSY 检查 */
  private registerHomeCommands(registerCommand: RegisterCommand, registerBusyGuardedCommand: RegisterCommand): void {
    registerCommand(
      LIST_COMMAND,
      'home 里装了哪些包、各有哪些条目、有没有 peer 范围不包含当前内核或 peer 里写的别的包没满足的',
      `回执按包列：包名、spec、条目（id、entryId、启停、是否 ACTIVE）、kernelRange（包的 package.json 里 peerDependencies["${KERNEL_PACKAGE}"] 写的范围，没写时没有这个字段）、kernelUntested（只标插件——keywords 含 gwb-plugin、不是内核包与 cordis 的包：范围不包含运行中的内核就是 true，没写、写的不是 ^x.y.z 也算；别的包与清单读不到的包一律 false；^x.y.z 在主版本号为 0 时要求次版本号相同，≥1 时要求主版本号相同，并且不低于 x.y.z）、unmetPeers（只看插件 peer 里除了内核包与 ${CORDIS_PACKAGE} 之外的包，home 里没满足的列成 [{ pkg, range, installed? }]：没装（没有 installed 字段；peerDependenciesMeta 里 optional: true 的没装不算）、装着的版本不在范围里、或范围不是 ^x.y.z，range 原样照抄，范围规则同上；每个包都有这个字段，不是插件、清单读不到、全都满足时是空数组）。只报告，不拦加载。无参数`,
      () => this.list(),
    )

    registerBusyGuardedCommand(
      INSTALL_COMMAND,
      '往 home 装一个包并加一条条目',
      `一次 pnpm add 把包装进 home，再加一条条目（默认启用）。不装它的 peer，也不判断是不是库：装了没有 apply 的包，条目加载失败，在 plugin-manager.list 里看得到。回执 { ok, pkg, entryId?, error?, tail? }。参数 { pkg, spec? }（spec 是版本或 tag）；${BUSY_USAGE_NOTE}`,
      async (args) => {
        const argsObject = argsObjectOf(args)
        const result = await this.install(requiredString(argsObject, 'pkg'), optionalString(argsObject, 'spec'))
        return receiptWithPnpmTail(result)
      },
    )

    registerCommand(ADD_ENTRY_COMMAND, '给已装的包再加一条条目', '参数 { pkg, id?, config? }。不给 id 就自动生成（磁盘上有本包留下的旧 id 时优先沿用）；给的 id 在条目树上已被占用、或磁盘上的数据与设置属于别的包，直接拒绝', async (args) => {
      const argsObject = argsObjectOf(args)
      const entryId = await this.addEntry(requiredString(argsObject, 'pkg'), optionalString(argsObject, 'id'), argsObject['config'])
      return { ok: true, data: { entryId } }
    })

    registerCommand(
      TRANSFER_OWNER_COMMAND,
      '把一个 id 的数据与设置的归属转给另一个包',
      '同一个插件改了包名、要继续用旧数据与设置时调用它；数据目录与设置分区的归属一起改。参数 { id, pkg }：id 是条目 id（不带前缀的 id 或完整 entryId，条目树上不必有这条），pkg 是新的所属包名。回执 { id, pkg, data, settings }，data / settings 是 false 说明对应的插件（gwb-data / gwb-settings）没装、那一半没改',
      async (args) => {
        const argsObject = argsObjectOf(args)
        return { ok: true, data: await this.transferOwner(requiredString(argsObject, 'id'), requiredString(argsObject, 'pkg')) }
      },
    )

    registerCommand(REMOVE_ENTRY_COMMAND, '删一条条目（不删包）', '参数 { entryId }', (args) => {
      this.removeEntry(requiredString(argsObjectOf(args), 'entryId'))
      return { ok: true }
    })

    registerCommand(ENABLE_COMMAND, '启用一条条目', '参数 { entryId }', async (args) => {
      await this.enable(requiredString(argsObjectOf(args), 'entryId'))
      return { ok: true }
    })

    registerCommand(DISABLE_COMMAND, '停用一条条目', '参数 { entryId }', async (args) => {
      await this.disable(requiredString(argsObjectOf(args), 'entryId'))
      return { ok: true }
    })

    registerBusyGuardedCommand(
      REMOUNT_COMMAND,
      '重新加载一条条目：停用→等卸载完→启用→等加载完，一条命令做完',
      `参数 { entryId }（完整 entryId 或不带前缀的 id）。回执 { id, action, state }：action 是 remounted（在这条命令里做完，state 是重新加载后的 fiber 状态，ACTIVE 才算加载成功）或 deferred（目标是插件管理自己：先返回回执，下一个宏任务才重新加载，state 是动手前的状态，之后用 plugin-manager.list 核对 active）；操作条目树时抛错则回 ok: false，data 里 action 是 failed。原本停用的条目重新加载后是启用的；重新加载命令插件（gwb-commands）也在这条命令里做完；${BUSY_USAGE_NOTE}`,
      async (args) => {
        const result = await this.remount(requiredString(argsObjectOf(args), 'entryId'))
        if (result.action === 'failed') return { ok: false, error: `条目 ${result.id} 重新加载失败：${result.state}`, data: result }
        return { ok: true, data: result }
      },
    )

    registerCommand(OUTDATED_COMMAND, '查已装的包哪些有新版本', 'pnpm outdated。回执 { ok, updates: { 包名: { current, latest } } }，空对象表示全都最新。无参数', async () => {
      const result = await this.outdated()
      if (result.ok) return { ok: true, data: result }
      return { ok: false, error: result.error ?? '没有给出原因' }
    })

    registerBusyGuardedCommand(
      UPDATE_ALL_COMMAND,
      '一键热升级过期包，不重启',
      `一次 pnpm add 把过期包升到 outdated 返回的精确版本，再逐条停用→启用，重新加载成新版本（原本停用的跳过；插件管理自己排最后、回执发出后才重新加载），最后 shell.reload 整页重新加载。peer 里写了被升级包的插件被 pnpm 装进了新目录，它们的条目在同一条命令里跟着重新加载（peer 写了这些插件的，一层层往外同样处理）。内核包 ${KERNEL_PACKAGE} 与 ${CORDIS_PACKAGE} 不升（only 点了名也不升），用 ${UPDATE_KERNEL_COMMAND} 升。回执 { updated: [{ pkg, from, to, entries: [{ id, action, state }] }], dependents: [{ pkg, because: [它 peer 里写了的、换了目录的包], entries: [{ id, action, state }] }], selfDeferred, reload, kernelManaged?: [{ pkg, from, to }]（过期了但没升的内核包与 cordis，过期清单里没有它们时没有这个字段）, note? }。参数 { only?: string[] }（只升这几个包；不给就全升）；${BUSY_USAGE_NOTE}`,
      async (args) => {
        const result = await this.updateAll(onlyPackagesArgOf(args))
        return receiptWithPnpmTail(result)
      },
    )

    registerBusyGuardedCommand(
      UPDATE_KERNEL_COMMAND,
      '升级 home 里的内核包，并把 home 根上的 cordis 对齐到内核要的版本；重启工作台后生效',
      `先 pnpm add ${KERNEL_PACKAGE}@<version，不给就是 latest>，再读装上的内核包 peerDependencies 里的 cordis（必须是精确版本号）pnpm add ${CORDIS_PACKAGE}@<那个版本>，两个都按精确版本号写进 home 的 package.json。不重新加载任何条目：主进程里的内核换不掉，重启工作台后才生效，重启由人决定。回执 { ok, kernel: { from?, to }, cordis: { from?, to }, restartRequired（装上的版本与正在运行的内核不同时是 true）, pluginsOutsideRange: [包名…]（keywords 含 gwb-plugin、peer 里内核包的范围不包含新内核或没写范围的插件）, note }，装之前 home 里没有的包没有 from；失败回 { ok: false, error, kernel?, tail? }，内核包已装上而 cordis 没对齐时带 kernel、error 说明先别重启。参数 { version? }；${BUSY_USAGE_NOTE}`,
      async (args) => {
        const result = await this.updateKernel(versionArgOf(args))
        return receiptWithPnpmTail(result)
      },
    )

    registerBusyGuardedCommand(UNINSTALL_COMMAND, '卸载一个包：删除它的全部条目，再卸载包', `设置与数据留在磁盘上（只删一条条目调用 plugin-manager.remove-entry）。参数 { pkg }；${BUSY_USAGE_NOTE}`, async (args) => {
      const result = await this.uninstall(requiredString(argsObjectOf(args), 'pkg'))
      return receiptWithPnpmTail(result)
    })
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
      '列出 registry 上的插件（npm 标准检索）：默认查全部配好的源',
      `从哪条源装就在哪条源搜：逐条源并发查（查成的并进 packages，没查成的在 note 里点名，一条失败不影响别的；全都没查成才 ok:false）。回执 packages 每行带 pkg / version / description / keywords，「是不是插件」看包自己的 keywords 里有没有 gwb-plugin。参数 { scope? }——不给就查全部配好的源（${SOURCE_LIST_COMMAND} 列出的两层 npmrc，@godcreator 在前、其余按名字排），给了只查那一条（如 "@j"）`,
      async (args) => {
        const result = await searchPlugins(deps, scopeArgOf(args))
        if (result.ok) return { ok: true, data: result }
        return { ok: false, error: result.error ?? '没说原因' }
      },
    )

    registerCommand(
      SOURCE_ADD_COMMAND,
      '往机器级 npmrc 写一条包源（scope 路由），装第三方插件用',
      '已有同 scope 就原地替换。写的是 ~/.npmrc（机器级）：@godcreator 的路由本来就在那里，不许经这条命令改。参数 { scope, registry?, owner?, token? }：registry 直接给源地址；owner 走 gitea 的简便写法——拼成 <base>/api/packages/<owner>/npm/（base 取设置 gitea.base-url，没配就用 git.tianshen02.online:28377），token 没给就取设置 gitea 分区的 token，取不到则回执 ok:false。token 行按源地址配对，同一个 token 配多条源不会重复写。回执 { ok, scope, registry, tokenWritten, replaced, lines?（token 已遮掉）, note? }',
      async (args) => {
        const argsObject = argsObjectOf(args)
        const result = await addSource(deps, requiredString(argsObject, 'scope'), {
          registry: optionalString(argsObject, 'registry'),
          owner: optionalString(argsObject, 'owner'),
          token: optionalString(argsObject, 'token'),
        })
        if (result.ok) return { ok: true, data: result }
        return { ok: false, error: result.error ?? '没说原因', data: result }
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
      '参数 { scope }。token 行没有别的 scope 再指向它时一起删，还有就留着。@godcreator 不许删；机器级没有这条时说明原因（包括「它在 home 级，要手工删」）。回执 { ok, scope, registry? }',
      async (args) => {
        const result = await removeSource(deps, requiredString(argsObjectOf(args), 'scope'))
        if (result.ok) return { ok: true, data: result }
        return { ok: false, error: result.error ?? '没说原因', data: result }
      },
    )
  }

  async list(): Promise<PluginPackageView[]> {
    const homeDependencies = await readHomeDependencies(this.homeDir)
    const reconciledPackages = reconcile(homeDependencies, readEntries(this.tree.store))
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

  /** 调用方写错（包名、版本范围不合规）直接抛；下面每一种失败都是正常结果，转成回执 */
  async install(pkg: string, spec?: string): Promise<InstallResult> {
    const packageSpec = installSpec(pkg, spec)

    const pnpmLookup = await locatePnpm()
    if (!pnpmLookup.ok) {
      this.log.warn(`装不了 ${packageSpec}：${pnpmLookup.error}`)
      return { ok: false, pkg, error: pnpmLookup.error }
    }

    this.log.info(`用 ${describePnpm(pnpmLookup)} 装 ${packageSpec}`)
    const pnpmRun = await this.applyToHome(pnpmLookup.file, { add: [packageSpec] })
    if (!pnpmRun.ok) {
      const failure = describeAddFailure(`pnpm add ${packageSpec}`, pnpmRun)
      this.log.warn(`${failure.error}\n${failure.tail ?? ''}`)
      return { ok: false, pkg, ...failure }
    }

    try {
      const entryId = await this.createEntry(pkg)
      // 不等加载，所以日志说「已加进」不说「已加载」
      this.log.info(`${packageSpec} 装上了，条目 ${entryId} 已加进 cordis.yml`)
      return { ok: true, pkg, entryId }
    } catch (err: unknown) {
      // 不回滚删包：删包比留着危险，而且删除时未必只删掉这一个
      const error = `${packageSpec} 装上了，但条目加不进 cordis.yml：${String(err)}。包留在 home 里，查看列表调用 ${LIST_COMMAND}`
      this.log.warn(error)
      return { ok: false, pkg, error }
    }
  }

  /** `pnpm outdated --json` 的退出码 1 表示「存在过期包」，是结果不是失败。它不写文件，和写 home 的 pnpm 同时运行没有影响，所以不经 BUSY */
  async outdated(): Promise<OutdatedReceipt> {
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
    return { ok: true, updates }
  }

  /** `only` 里包名不合规直接抛；下面每一种失败都是正常结果，转成回执 */
  async updateAll(only?: readonly string[]): Promise<UpdateAllResult> {
    for (const pkg of only ?? []) assertPkgName(pkg)

    const checked = await this.outdated()
    if (!checked.ok || checked.updates === undefined) return failedUpdateAll(checked.error ?? '查不出过期清单')

    // 升级前读清单就够了：跟着重新加载的包本身不升级，它的 peer 在这次安装前后不变
    const plan = planUpdateAll(checked.updates, this.tree.store, ownEntryId(this.ctx), await this.readHomePackageManifests(), only)
    const notes: string[] = []
    if (plan.ignored.length > 0) notes.push(`only 里这几个不在过期清单里，没动：${plan.ignored.join('、')}`)
    if (plan.kernelManaged.length > 0) notes.push(kernelManagedNoteOf(plan.kernelManaged))
    const kernelManagedField = plan.kernelManaged.length === 0 ? {} : { kernelManaged: plan.kernelManaged }
    if (plan.packages.length === 0) {
      const everythingUpToDate = plan.kernelManaged.length === 0
      return { ok: true, updated: [], dependents: [], selfDeferred: false, ...kernelManagedField, note: [...(everythingUpToDate ? ['全都最新'] : []), ...notes].join('；') }
    }

    const pnpmLookup = await locatePnpm()
    if (!pnpmLookup.ok) {
      this.log.warn(`升不了：${pnpmLookup.error}`)
      return failedUpdateAll(pnpmLookup.error)
    }
    // 一次装完：pnpm 读改写 home 的 package.json，逐个包启动进程与并发安装一样会互相覆盖
    const specs = plan.pnpmArgs.slice(1)
    this.log.info(`用 ${describePnpm(pnpmLookup)} 一次安装 ${specs.join(' ')}`)
    const pnpmRun = await this.applyToHome(pnpmLookup.file, { add: specs })
    if (!pnpmRun.ok) {
      const failure = describeAddFailure(`pnpm ${plan.pnpmArgs.join(' ')}`, pnpmRun)
      const error = `${failure.error}。一条条目都没动`
      this.log.warn(`${error}\n${failure.tail ?? ''}`)
      return { ...failedUpdateAll(error), ...(failure.tail === undefined ? {} : { tail: failure.tail }) }
    }

    // 旧版本目录随时可能被 pnpm 清掉（home 设了 modulesCacheMaxAge: 0 时同一次安装就删）：换了目录的每条条目都在这条命令里重新加载，中间不留间隔
    const { updated, dependents, ownEntry } = await this.remountUpgradedEntries(plan)
    const summary =
      updated.map((p) => `${p.pkg} ${p.from} → ${p.to}`).join('，') +
      (dependents.length === 0 ? '' : `；跟着重新加载 ${dependents.map((d) => d.pkg).join('、')}`)
    const commandBus = this.commandBus

    if (ownEntry === undefined) {
      const reload = await runShellReload(commandBus)
      if (reload.note !== undefined) notes.push(reload.note)
      this.log.info(`一键热升级完成：${summary}${reload.reload === 'done' ? '；界面已整页重载' : ''}`)
      return { ok: true, updated, dependents, selfDeferred: false, reload: reload.reload, ...kernelManagedField, ...noteOf(notes) }
    }

    // 本插件自己在回执之后重新加载：闭包只持有 tree、id、命令插件的引用与 logger，不调 this 上的其他方法
    const id = ownEntry.id
    const log = this.log
    remountSelfLater(this.tree, id, log, async () => {
      const reload = await runShellReload(commandBus)
      if (reload.note !== undefined) log.warn(reload.note)
    })
    const canReload = hasCommand(commandBus, SHELL_RELOAD_COMMAND)
    if (!canReload) notes.push(`命令表里没有 ${SHELL_RELOAD_COMMAND}，界面要手动刷新`)
    this.log.info(`一键热升级：${summary}；插件管理自己（${id}）在回执之后重新加载${canReload ? '，随后整页重载' : ''}`)
    return { ok: true, updated, dependents, selfDeferred: true, reload: canReload ? 'deferred' : 'unavailable', ...kernelManagedField, ...noteOf(notes) }
  }

  /** 版本写法不合规直接抛；pnpm 失败、内核包 peer 里的 cordis 不是精确版本号都转成回执。不重新加载任何条目 */
  async updateKernel(version?: string): Promise<UpdateKernelResult> {
    const kernelSpec = installSpec(KERNEL_PACKAGE, version ?? 'latest')

    const pnpmLookup = await locatePnpm()
    if (!pnpmLookup.ok) {
      this.log.warn(`升不了内核：${pnpmLookup.error}`)
      return { ok: false, error: pnpmLookup.error }
    }

    const kernelBefore = installedVersionOf(await readInstalledPackageManifest(this.homeDir, KERNEL_PACKAGE))
    const cordisBefore = installedVersionOf(await readInstalledPackageManifest(this.homeDir, CORDIS_PACKAGE))

    this.log.info(`用 ${describePnpm(pnpmLookup)} 装 ${kernelSpec}`)
    // 内核包与 cordis 都写精确版本号：home 根上的 cordis 必须等于内核包 peer 里的那个版本，写成 ^ 以后重装会解析到别的版本
    const kernelRun = await this.applyToHome(pnpmLookup.file, { add: [kernelSpec], saveExact: true })
    if (!kernelRun.ok) {
      const failure = describeAddFailure(`pnpm add ${kernelSpec}`, kernelRun)
      this.log.warn(`${failure.error}\n${failure.tail ?? ''}`)
      return { ok: false, ...failure }
    }

    const target = kernelUpgradeTargetOf(await readInstalledPackageManifest(this.homeDir, KERNEL_PACKAGE))
    if (!target.ok) {
      const error = `${kernelSpec} 装上了，但${target.error}。cordis 没动，home 里的内核与 cordis 可能对不上，先别重启`
      this.log.warn(error)
      return { ok: false, error }
    }
    const kernelMismatch = version === undefined ? undefined : installedVersionMismatch(KERNEL_PACKAGE, version, target.kernelVersion)
    if (kernelMismatch !== undefined) {
      const error = `${kernelMismatch}。cordis 没动，先别重启`
      this.log.warn(error)
      return { ok: false, error }
    }
    const kernel = versionChangeOf(kernelBefore, target.kernelVersion)

    const cordisSpec = installSpec(CORDIS_PACKAGE, target.cordisVersion)
    const cordisRun = await this.applyToHome(pnpmLookup.file, { add: [cordisSpec], saveExact: true })
    if (!cordisRun.ok) {
      const failure = describeAddFailure(`pnpm add ${cordisSpec}`, cordisRun)
      const error = `${failure.error}。内核包已经是 ${target.kernelVersion}，home 根上的 cordis 没对齐到它要的 ${target.cordisVersion}，先别重启`
      this.log.warn(`${error}\n${failure.tail ?? ''}`)
      return { ok: false, kernel, error, ...(failure.tail === undefined ? {} : { tail: failure.tail }) }
    }
    const cordisMismatch = installedVersionMismatch(
      CORDIS_PACKAGE,
      target.cordisVersion,
      installedVersionOf(await readInstalledPackageManifest(this.homeDir, CORDIS_PACKAGE)),
    )
    if (cordisMismatch !== undefined) {
      const error = `${cordisMismatch}。内核包已经是 ${target.kernelVersion}，先别重启`
      this.log.warn(error)
      return { ok: false, kernel, error }
    }

    const pluginsOutsideRange = pluginsOutsideKernelRange(await this.readHomePackageManifests(), target.kernelVersion)
    const cordis = versionChangeOf(cordisBefore, target.cordisVersion)
    this.log.info(
      `内核包装成 ${target.kernelVersion}、cordis 对齐到 ${target.cordisVersion}，重启工作台后生效` +
        (pluginsOutsideRange.length === 0 ? '' : `；peer 范围不包含新内核的插件：${pluginsOutsideRange.join('、')}`),
    )
    const restartRequired = target.kernelVersion !== this.kernelVersion
    return {
      ok: true,
      kernel,
      cordis,
      restartRequired,
      pluginsOutsideRange,
      note: restartRequired ? '主进程里的内核换不掉，重启工作台后才生效；重启由人决定' : `装上的就是正在运行的内核 ${this.kernelVersion}，不用重启`,
    }
  }

  /** home 的 dependencies 里每个包 → 它装在 node_modules 里的清单（没装的是 undefined） */
  private async readHomePackageManifests(): Promise<Map<string, unknown>> {
    const manifestsByPackage = new Map<string, unknown>()
    await this.readInstalledManifests(Object.keys(await readHomeDependencies(this.homeDir)), manifestsByPackage)
    return manifestsByPackage
  }

  /** 按计划逐条重新加载：先升级了的包，再跟着重新加载的包；本插件自己那条（启用着的）只记 deferred，交给调用方在回执之后处理 */
  private async remountUpgradedEntries(
    plan: UpdateAllPlan,
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
    for (const plannedPackage of plan.packages) {
      updated.push({ pkg: plannedPackage.pkg, from: plannedPackage.from, to: plannedPackage.to, entries: await remountEntriesOf(plannedPackage.entries) })
    }
    const dependents: DependentPackage[] = []
    for (const plannedDependent of plan.dependents) {
      dependents.push({ pkg: plannedDependent.pkg, because: plannedDependent.because, entries: await remountEntriesOf(plannedDependent.entries) })
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

  /** 包没装（调用方写错了）直接抛；删条目与 pnpm 两步的失败转成回执 */
  async uninstall(pkg: string): Promise<UninstallResult> {
    assertPkgName(pkg)
    const homeDependencies = await readHomeDependencies(this.homeDir)
    if (homeDependencies[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，无法卸载。只删条目请调用 ${REMOVE_ENTRY_COMMAND}。`)
    }

    // 先删条目：tree.remove 写回 yml 并当场卸载 fiber，依赖这个包的插件随之被 cordis 卸载
    const removedIds = entriesForPackage(this.tree.store, pkg)
    for (const id of removedIds) this.tree.remove(id)

    const pnpmLookup = await locatePnpm()
    if (!pnpmLookup.ok) {
      this.log.warn(`卸不了 ${pkg}：条目已删除（${removedIds.length} 条），${pnpmLookup.error}`)
      return { ok: false, pkg, removedEntries: removedIds, error: pnpmLookup.error }
    }
    const pnpmRun = await this.applyToHome(pnpmLookup.file, { remove: [pkg] })
    if (!pnpmRun.ok) {
      // 不回滚：包会出现在「已装、没有条目」那一组里，重试加条目即可
      const error = `pnpm remove ${pkg} 失败（退出码 ${String(pnpmRun.exitCode)}）。条目已删除 ${removedIds.length} 条，包还在 home 里`
      this.log.warn(`${error}\n${pnpmRun.tail ?? ''}`)
      return pnpmRun.tail === undefined
        ? { ok: false, pkg, removedEntries: removedIds, error }
        : { ok: false, pkg, removedEntries: removedIds, error, tail: pnpmRun.tail }
    }

    this.log.info(`${pkg} 卸载了：删除 ${removedIds.length} 条条目，包已从 home 移除。设置与数据留在磁盘上`)
    return { ok: true, pkg, removedEntries: removedIds }
  }

  /** 包没装、id 已被占用、id 的数据或设置属于别的包，都会抛 */
  async addEntry(pkg: string, id?: string, config?: unknown): Promise<string> {
    assertPkgName(pkg)
    const homeDependencies = await readHomeDependencies(this.homeDir)
    if (homeDependencies[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，加不了条目。先调用 ${INSTALL_COMMAND}，或者自己去 home 里 pnpm add。`)
    }
    const entryId = await this.createEntry(pkg, id, config)
    this.log.info(`条目 ${entryId}（${pkg}）加进 cordis.yml 了`)
    return entryId
  }

  /** 数据插件、设置插件没装的那部分跳过；`id` 不要求条目树上有这条 */
  async transferOwner(id: string, pkg: string): Promise<TransferOwnerResult> {
    assertPkgName(pkg)
    const bareEntryId = bareId(id)
    assertId(bareEntryId)
    const dataOwnerBook = this.dataOwnerBook
    const settingsOwnerBook = this.settingsOwnerBook
    if (dataOwnerBook !== undefined) await dataOwnerBook.transferOwner(bareEntryId, pkg)
    if (settingsOwnerBook !== undefined) await settingsOwnerBook.transferOwner(bareEntryId, pkg)
    this.log.info(`${bareEntryId} 的数据与设置的归属已转给 ${pkg}`)
    return { id: bareEntryId, pkg, data: dataOwnerBook !== undefined, settings: settingsOwnerBook !== undefined }
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
  private async createEntry(pkg: string, id?: string, config?: unknown): Promise<string> {
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
    // 每次传一个新对象：create 会把它原样放进 group.data，共用一个对象等于两条条目共享配置
    const options: Record<string, unknown> = { id: chosenId, name: pkg }
    if (config !== undefined) options['config'] = config

    // 不 await：create 返回的 promise 包含加载，inject 满足不了的插件永远加载不完；写进 yml 在第一个 await 之前就同步安排好了
    void this.tree.create(options, null).catch((err: unknown) => {
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
   * 改 home 的唯一入口：安装、升级、卸载都经这里运行 pnpm。调用它的命令都经过 BUSY 检查——两个写 home 的 pnpm 同时运行会丢改动，
   * 而且都退出码 0。`saveExact` 让 home 的清单写精确版本号，不写 `^`
   */
  private applyToHome(pnpm: string, change: { add: readonly string[]; saveExact?: true } | { remove: readonly string[] }): Promise<PnpmResult> {
    const args = 'add' in change ? ['add', ...change.add, ...(change.saveExact ? ['--save-exact'] : [])] : ['remove', ...change.remove]
    return runPnpm({ pnpm, cwd: this.homeDir, args })
  }
}

function failedUpdateAll(error?: string): UpdateAllResult {
  return { ok: false, updated: [], dependents: [], selfDeferred: false, ...(error === undefined ? {} : { error }) }
}

function hasCommand(commandBus: GwbCommands | undefined, name: string): boolean {
  return commandBus !== undefined && commandBus.list().some((command) => command.name === name)
}

/** 没有命令插件、命令表里没有这条、执行失败，都返回「界面要手动刷新」 */
async function runShellReload(commandBus: GwbCommands | undefined): Promise<{ reload: 'done' | 'unavailable'; note?: string }> {
  if (!hasCommand(commandBus, SHELL_RELOAD_COMMAND) || commandBus === undefined) {
    return { reload: 'unavailable', note: `命令表里没有 ${SHELL_RELOAD_COMMAND}（外壳没装或版本太旧），界面要手动刷新` }
  }
  const result = await commandBus.run(SHELL_RELOAD_COMMAND)
  if (result.ok) return { reload: 'done' }
  return { reload: 'unavailable', note: `${SHELL_RELOAD_COMMAND} 失败（${result.error ?? '没有给出原因'}），界面要手动刷新` }
}

function kernelManagedNoteOf(kernelManaged: readonly KernelManagedPackage[]): string {
  const listed = kernelManaged.map((p) => `${p.pkg} ${p.from} → ${p.to}`).join('、')
  return `这几个由内核决定版本，没升：${listed}。内核包用 ${UPDATE_KERNEL_COMMAND} 升，cordis 随它对齐`
}

/** 失败时 pnpm 输出的最后几行既拼进 error（给人看），也原样留在 data 里（界面要单独排版时用） */
function receiptWithPnpmTail(result: { ok: boolean; error?: string; tail?: string }): GwbResult {
  if (result.ok) return { ok: true, data: result }
  const tail = result.tail === undefined ? '' : `\n${result.tail}`
  return { ok: false, error: `${result.error ?? '没有给出原因'}${tail}`, data: result }
}

/** 不传、传空对象都表示「全部升级」；给了 only 就必须是非空字符串数组 */
function onlyPackagesArgOf(args: unknown): string[] | undefined {
  if (args === undefined || args === null) return undefined
  const only = argsObjectOf(args)['only']
  if (only === undefined || only === null) return undefined
  if (!Array.isArray(only) || only.some((item) => typeof item !== 'string' || item === '')) {
    throw new Error('only 给了就要是个非空字符串数组，比如 { "only": ["@godcreator/gwb-hello"] }')
  }
  return only as string[]
}

/** 不传、传空对象都表示装源上的 latest；给了 version 就要是非空字符串 */
function versionArgOf(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined
  return optionalString(argsObjectOf(args), 'version')
}

/** 不传、传空对象都是查全部源；给了 scope 就要是非空字符串 */
function scopeArgOf(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined
  const scope = argsObjectOf(args)['scope']
  if (scope === undefined || scope === null) return undefined
  if (typeof scope !== 'string' || scope === '') throw new Error('scope 给了就要是非空字符串，比如 "@j"')
  return scope
}

function argsObjectOf(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) throw new Error('参数要是一个对象，比如 { "entryId": "commands" }')
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
