import type { GwbContext } from '@godcreator/gwb-kernel-desktop'
import { isRecord, noteOf, requireKernel } from './vocab.js'
// 这三条 type import 只为引入对方的 `declare module 'cordis'`；这几个插件写在 peer 里，都经嵌套注入使用
import type { GwbCommandEffect } from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-settings'
import type {} from '@godcreator/gwb-skills'
import type {
  Acknowledged,
  DependentPackage,
  EntryAdded,
  Installed,
  KernelInstalledButCordisNot,
  OutdatedFound,
  Outcome,
  PluginPackageView,
  RemountedEntry,
  Uninstalled,
  Updated,
  UpdatedPackage,
  VersionChange,
} from './receipts.js'
import { installedPackageRealpath, readHomeDependencies, readInstalledPackageManifest } from './home.js'
import { assertPkgName, bareId, installSpec, isPkgName, pickId } from './ids.js'
import { installedVersionOf, readEntries, reconcile } from './inventory.js'
import { describeAddFailure, describePnpm, runPnpm, runPnpmCapture, type PnpmResult } from './pnpm.js'
import { locatePnpm } from './pnpm-location.js'
import { parseOutdated } from './outdated.js'
import { entriesForPackage } from './uninstall.js'
import { ownEntryId, treeOf, type EntryTreeLike } from './tree.js'
import { BusyGate } from './busy.js'
import { fiberStateOf } from './fiber.js'
import {
  assertOnlyNotKernelManaged,
  assertOnlyPackagesInHome,
  deferredAfterSelf,
  deferredEntryIdsOf,
  packageRemountingSelf,
  packagesToRemount,
  peerCycleNote,
  peerNamesOf,
  planOutdatedUpdate,
  planSpecsUpdate,
  remountOrderOf,
  versionChangesAfterAdd,
  type InstalledDirectories,
  type InstalledVersions,
  type PackageEntries,
  type PeerNamesByPackage,
  type PlannedEntry,
  type RemountSchedule,
  type SpecsUpdatePlan,
  type UpdateArgs,
  type VersionChangesAfterAdd,
} from './update.js'
import { remountNow, remountSelfLater } from './remount.js'
import { KERNEL_PACKAGE } from './kernel-compat.js'
import { CORDIS_PACKAGE, installedVersionMismatch, KERNEL_MANAGED_PACKAGES, kernelUpgradeTargetOf, versionChangeOf } from './kernel-upgrade.js'
import { declaredPluginPeers, peerStatusOf } from './peers.js'
import { searchPlugins } from './package-sources.js'
import { readPnpmConfig } from './pnpm-config.js'
import { REGISTRY_AUTH_KEY, registryTokens, withHomeRegistryAuth } from './registry-auth.js'
import { DEFAULT_MARKETS, MARKETS_SETTING_KEY } from './sources.js'

// 开发套件复用的规则：它 import 这几个，不另存一份
export { locatePnpm } from './pnpm-location.js'
export { isCaretRange, KERNEL_PACKAGE } from './kernel-compat.js'
export { homePnpmEnv, tailLines } from './pnpm.js'
export { withHomeRegistryAuth } from './registry-auth.js'

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
const OUTDATED_COMMAND = 'plugin-manager.outdated'
const UNINSTALL_COMMAND = 'plugin-manager.uninstall'
const SEARCH_COMMAND = 'plugin-manager.search'

/**
 * 服务 `gwbPluginManager` 的值：只表示插件管理装了（别的插件 inject 它，跟着它一起加载、卸载），上面没有字段。
 * 命令有没有破坏性变化看插件管理的版本号
 */
export type PluginManagerPresence = Record<string, never>

const PRESENCE: PluginManagerPresence = {}

type CommandHandler = (args?: unknown) => unknown
type RegisterCommand = (name: string, description: string, usage: string, effect: GwbCommandEffect, handler: CommandHandler) => void

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
  private readonly tree: EntryTreeLike
  /** 事先拿到的 logger：最后重新加载本插件那一步运行时，本插件的 fiber 已经卸载，ctx 上什么都不能访问 */
  private readonly log: { info(message: string): void; warn(message: string): void }

  private readonly busyGate = new BusyGate()

  constructor(ctx: GwbContext) {
    this.ctx = ctx
    const kernel = requireKernel(ctx)
    this.homeDir = kernel.dataDir
    this.kernelVersion = kernel.version
    this.tree = treeOf(ctx)
    this.log = ctx.logger(NAME)
  }

  wire(): void {
    this.wireCommands()
    this.wireSearch()
    this.wireSkills()
  }

  /** skills/ 目录要列进 package.json 的 files */
  private wireSkills(): void {
    this.ctx.inject(['gwbSkills'], (ctx) => {
      ctx.effect(() => ctx.gwbSkills.register(new URL('../skills/', import.meta.url)))
    })
  }

  /** 命令插件是可选的，但没有它插件管理就没有任何对外接口 */
  private wireCommands(): void {
    this.ctx.inject(['gwbCommands'], (ctx) => {
      const commandBus = ctx.gwbCommands
      // inject 保证了它在，这句只是把类型收窄
      if (commandBus === undefined) return
      const registerCommand: RegisterCommand = (name, description, usage, effect, handler) => {
        commandBus.register({ name, description, usage, plugin: PKG, effect }, handler)
      }
      const registerBusyGuardedCommand: RegisterCommand = (name, description, usage, effect, handler) => {
        commandBus.register({ name, description, usage, plugin: PKG, effect }, (args) => this.busyGate.run(() => handler(args) as Promise<{ ok: boolean }> | { ok: boolean }))
      }
      this.registerHomeCommands(registerCommand, registerBusyGuardedCommand)
    })
  }

  /** 改 home 里的包与条目的命令；安装、卸载、升级、重新加载经过 BUSY 检查 */
  private registerHomeCommands(registerCommand: RegisterCommand, registerBusyGuardedCommand: RegisterCommand): void {
    registerCommand(
      LIST_COMMAND,
      'home 里装了哪些包（内核包与 cordis 除外）、各有哪些条目、peer 里写的包（含内核包）有没有没满足的',
      `回执按包列，不列内核包 ${KERNEL_PACKAGE} 与 ${CORDIS_PACKAGE}（它们没有条目；内核包经 ${UPDATE_COMMAND} 的 specs 换，cordis 随它对齐）：包名、spec、条目（id、entryId、启停、是否 ACTIVE）、unmetPeers（只看插件——keywords 含 gwb-plugin 的包——peer 里除了 ${CORDIS_PACKAGE} 之外的包，没满足的列成 [{ pkg, range, installed? }]：内核包 ${KERNEL_PACKAGE} 对照正在运行的内核，范围不包含就列、installed 是运行中的内核版本，peer 里没写内核包就不列这一项；别的包对照 home 里装着的版本，没装（没有 installed 字段；peerDependenciesMeta 里 optional: true 的没装不算）、装着的版本不在范围里都列；范围不是 ^x.y.z 也列，range 原样照抄；^x.y.z 在主版本号为 0 时要求次版本号相同，≥1 时要求主版本号相同，并且不低于 x.y.z；每个包都有这个字段，不是插件、清单读不到、全都满足时是空数组）。只报告，不拦加载。无参数`,
      'read',
      () => this.list(),
    )

    registerBusyGuardedCommand(
      INSTALL_COMMAND,
      '往 home 装一个还没装的包并加一条条目',
      `一次 pnpm add 把包装进 home（home 的 package.json 里照 pnpm 默认写 ^ 范围），再加一条条目（默认启用）。包已在 home 的 dependencies 里直接报错：再加一条条目用 ${ADD_ENTRY_COMMAND}，换版本用 ${UPDATE_COMMAND} {"specs":{…}}。不装它的 peer，也不判断是不是库：装了没有 apply 的包，条目加载失败，在 ${LIST_COMMAND} 里看得到。回执 data { pkg, entryId }；失败时 error 里带 pnpm 输出的最后几行。参数 { pkg, spec? }（spec 是版本或 tag）；${BUSY_USAGE_NOTE}`,
      'write',
      async (args) => {
        const argsObject = argsObjectOf(args, ['pkg', 'spec'])
        return this.install(requiredString(argsObject, 'pkg'), optionalString(argsObject, 'spec'))
      },
    )

    registerCommand(
      ADD_ENTRY_COMMAND,
      '给已装的包再加一条条目',
      '参数 { pkg }。id 自动生成：包名去掉 scope 与 gwb- 前缀转成 kebab-case，条目树上已有就加 -2、-3 后缀。回执 data { entryId }',
      'write',
      async (args): Promise<Outcome<EntryAdded>> => {
        const entryId = await this.addEntry(requiredString(argsObjectOf(args, ['pkg']), 'pkg'))
        return { ok: true, data: { entryId } }
      },
    )

    registerCommand(REMOVE_ENTRY_COMMAND, '删一条条目（不删包）', '参数 { entryId }', 'write', (args): Acknowledged => {
      this.removeEntry(requiredString(argsObjectOf(args, ['entryId']), 'entryId'))
      return { ok: true }
    })

    registerCommand(ENABLE_COMMAND, '启用一条条目', '参数 { entryId }', 'write', async (args): Promise<Acknowledged> => {
      await this.enable(requiredString(argsObjectOf(args, ['entryId']), 'entryId'))
      return { ok: true }
    })

    registerCommand(DISABLE_COMMAND, '停用一条条目', '参数 { entryId }', 'write', async (args): Promise<Acknowledged> => {
      await this.disable(requiredString(argsObjectOf(args, ['entryId']), 'entryId'))
      return { ok: true }
    })

    registerCommand(
      OUTDATED_COMMAND,
      '查已装的包哪些有新版本',
      `pnpm outdated。回执 data { updates: { 包名: { current, latest } } }，空对象表示全都最新；不含内核包 ${KERNEL_PACKAGE} 与 ${CORDIS_PACKAGE}（热升级不了，内核包用 ${UPDATE_COMMAND} 的 specs 换）。无参数`,
      'read',
      () => this.outdated(),
    )

    registerBusyGuardedCommand(
      UPDATE_COMMAND,
      '升级 home 里已装的包（全部过期的、点名的几个、或按给定写法装，内核包也走这条），不重启、不整页重新加载',
      `${UPDATE_ARGS_USAGE}。home 的 package.json 里照 pnpm 默认写 ^ 范围（只有 ${CORDIS_PACKAGE} 写精确版本号）；清单里已有的 ^ 范围会挡住往回退版本，specs 退回旧版会在核对时回 ok: false。all 与 only：一次 pnpm add 把过期包升到 outdated 返回的精确版本；specs：一次 pnpm add 每项 <包名>@<写法>，不查 outdated，写法是准确版本号的，装完读 node_modules 里的清单核对，装上的不是那个号就回 ok: false、一条条目都不重新加载（tag 与 file: 不核对）。pnpm add 前后 home 里 node_modules/<包名> 指向的真实目录变了的包，条目在同一条命令里逐条停用→启用、重新加载成新版本（原本停用的跳过）：点了名的包归 updated（装的就是原来那一版、目录没变的也列出，entries 为空），没点名的（多半是 peer 写了被装的包的插件）归 dependents。重新加载的先后按装上后清单里的 peerDependencies 排（只看这批要重新加载的包之间的 peer），被依赖的先、同一层按包名，两组合在一起排，组内也照这个先后列；插件管理自己，以及这批里传递地 peer 了插件管理的包，条目记 action deferred，回执发出后按这个先后依次重新加载（插件管理自己在最前，一条失败只记日志、接着下一条）。这批包里 peer 成环时，环上的包与传递地 peer 了环上包的包这次不重新加载（entries 为空），回执带 restartRequired: true，note 写明环（A → B → A）、这些包重启工作台后才换成新版本；其余包照常按先后重新加载。不整页重新加载：界面要换成新代码，由调用方拿到回执后自己调 shell.reload。内核包 ${KERNEL_PACKAGE} 与 ${CORDIS_PACKAGE} 不在过期清单里，only 点了它们直接报错。specs 里有内核包时：内核包与其余包一次 pnpm add，再读装上的内核包 peerDependencies.cordis（必须是精确版本号）pnpm add ${CORDIS_PACKAGE}@<那个版本>，不重新加载任何条目——主进程里的内核换不掉，重启工作台后才生效，重启由人决定；回执另带 restartRequired（装上的内核版本与正在运行的不同时是 true；不装内核包时只在 peer 成环时出现），重启后 peer 范围不包含新内核的插件由 ${LIST_COMMAND} 的 unmetPeers 列出；内核包装上了而 cordis 没对齐时回 ok: false，data 带 { kernel: { from?, to } }，error 说明先别重启。specs 里写 ${CORDIS_PACKAGE} 直接报错。回执 data { updated: [{ pkg, from?, to, entries: [{ id, action, state }] }], dependents: [{ pkg, entries: [{ id, action, state }] }], selfDeferred, restartRequired?, note? }：specs 的 from 是装之前 node_modules 里清单的 version（读不到就没有），to 是装完读到的 version；失败时 error 里带 pnpm 输出的最后几行；${BUSY_USAGE_NOTE}`,
      'write',
      (args) => this.update(updateArgsOf(args)),
    )

    registerBusyGuardedCommand(
      UNINSTALL_COMMAND,
      '卸载一个包：删除它的全部条目，再卸载包',
      `设置与数据留在磁盘上（只删一条条目调用 ${REMOVE_ENTRY_COMMAND}）。内核包与 ${CORDIS_PACKAGE} 不许卸载，直接报错。回执 data { pkg }；pnpm 失败时 error 说明条目已删几条、包还在，并带 pnpm 输出的最后几行。参数 { pkg }；${BUSY_USAGE_NOTE}`,
      'write',
      (args) => this.uninstall(requiredString(argsObjectOf(args, ['pkg']), 'pkg')),
    )
  }

  /**
   * 找插件：市场名单是公共区的设置项，所以 `search` 要命令总线与设置两样都在才登记。
   * 只读设置、pnpm 的配置与源，不改 home，不经 BUSY 检查
   */
  private wireSearch(): void {
    this.ctx.inject(['gwbCommands', 'gwbSettings'], (ctx) => {
      const settings = ctx.gwbSettings
      const commandBus = ctx.gwbCommands
      // inject 保证了它们在，这句只是把类型收窄
      if (settings === undefined || commandBus === undefined) return
      settings.define({ key: REGISTRY_AUTH_KEY, type: 'secret', shared: true, title: 'npm 源凭据', description: '本 home 的源鉴权 JSON：键为 //主机/路径/:_authToken，值为 token；由接入 skill 本地导入，不回显原文。安装、检索、发布共用。' })
      settings.define({
        key: MARKETS_SETTING_KEY,
        title: '插件市场',
        type: 'string-list',
        shared: true,
        default: [...DEFAULT_MARKETS],
        description: `plugin-manager.search 只在这些 scope 上找插件，每行一个（如 @godcreator）。每个市场的源地址按 pnpm 的配置走（~/.npmrc 里的 @<scope>:registry=…），装包也走这个源`,
      })
      commandBus.register(
        {
          name: SEARCH_COMMAND,
          description: '列出市场名单里各个市场上的插件（npm 标准检索）',
          usage: `无参数。市场名单是公共区（section "*"）的设置项 ${MARKETS_SETTING_KEY}，字符串数组，每项一个 scope，默认 ${JSON.stringify(DEFAULT_MARKETS)}；加删市场用 settings.set 改它。每个市场的源地址问 pnpm（在 home 里 pnpm config list --json，含 ~/.npmrc、<home>/.npmrc、pnpm 全局配置），只认这个 scope 自己的 @<scope>:registry，没配就报这个市场没配源、不去全局源查；凭据只从当前 home 的共享 secret npm-auth 读取，不回退机器凭据。各市场并发查，查成的并进 packages，没查成的在 note 里点名，一个失败不影响别的；全都没查成才 ok:false。只列插件：包自己的 keywords 里有 gwb-plugin 的。回执 data { packages: [{ pkg, version?, description? }], markets: [{ scope, registry?, ok, count?, error? }]（顺序照名单）, note? }`,
          plugin: PKG,
          effect: 'read',
        },
        async (args) => {
          argsObjectOf(args ?? {}, [])
          const pnpmLookup = await locatePnpm()
          if (!pnpmLookup.ok) return { ok: false, error: pnpmLookup.error }
          return searchPlugins({
            markets: settings.get(MARKETS_SETTING_KEY),
            readPnpmConfig: () => readPnpmConfig(pnpmLookup.file, this.homeDir),
            readPnpmConfigValue: (key) => Promise.resolve(registryTokens(settings.get(REGISTRY_AUTH_KEY))[key]),
          })
        },
      )
    })
  }

  async list(): Promise<PluginPackageView[]> {
    const homeDependencies = await readHomeDependencies(this.homeDir)
    const reconciledPackages = reconcile(withoutKernelManaged(homeDependencies), readEntries(this.tree.store))
    const manifestsByPackage = new Map<string, unknown>()
    await this.readInstalledManifests(reconciledPackages.map((view) => view.pkg), manifestsByPackage)
    const installedVersions = await this.installedVersionsFor(manifestsByPackage)
    return reconciledPackages.map((view) => ({ ...view, ...peerStatusOf(manifestsByPackage.get(view.pkg), installedVersions, this.kernelVersion) }))
  }

  /** 没装的包读成 undefined */
  private async readInstalledManifests(pkgs: readonly string[], manifestsByPackage: Map<string, unknown>): Promise<void> {
    const manifests = await Promise.all(pkgs.map((pkg) => readInstalledPackageManifest(this.homeDir, pkg)))
    pkgs.forEach((pkg, index) => manifestsByPackage.set(pkg, manifests[index]))
  }

  /**
   * 包 → 装着的版本号。插件 peer 里点名、而 dependencies 与条目都没提到的包也去 `node_modules` 读一次清单；
   * 内核包不读（它对照正在运行的内核）；不合包名规则的键不拿去拼路径（`..` 之类会读到 `node_modules` 外面），按没装报
   */
  private async installedVersionsFor(manifestsByPackage: Map<string, unknown>): Promise<Map<string, string>> {
    const peeredButUnreadPackages = new Set<string>()
    for (const manifest of manifestsByPackage.values()) {
      for (const { pkg } of declaredPluginPeers(manifest)) {
        if (pkg !== KERNEL_PACKAGE && !manifestsByPackage.has(pkg) && isPkgName(pkg)) peeredButUnreadPackages.add(pkg)
      }
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
  async install(pkg: string, spec?: string): Promise<Outcome<Installed>> {
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
      const entryId = this.createEntry(pkg)
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
  async outdated(): Promise<Outcome<OutdatedFound>> {
    const pnpmLookup = await locatePnpm()
    if (!pnpmLookup.ok) return { ok: false, error: pnpmLookup.error }

    const pnpmRun = await withHomeRegistryAuth(pnpmLookup.file, this.homeDir, ({ env }) => runPnpmCapture({ pnpm: pnpmLookup.file, cwd: this.homeDir, args: ['outdated', '--json'], env }))
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
    const restartRequired = target.kernelVersion !== this.kernelVersion
    this.log.info(`装了 ${updated.map(describeVersionChange).join('，')}；有内核包，没有重新加载任何条目` + (restartRequired ? '，重启工作台后生效' : ''))
    const note = restartRequired
      ? `装了内核包 ${KERNEL_PACKAGE} ${target.kernelVersion}：主进程里的内核换不掉，这次没有重新加载任何条目，这 ${updated.length} 个包重启工作台后才都换成新装的版本；重启由人决定。重启后 ${LIST_COMMAND} 的 unmetPeers 列出 peer 范围不包含新内核的插件`
      : `装上的就是正在运行的内核 ${this.kernelVersion}，不用重启；这次没有重新加载任何条目`
    return { ok: true, data: { updated, dependents: [], selfDeferred: false, restartRequired, note } }
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
   * 一次 pnpm add → 真实目录变了的包按 peer 排的先后逐条重新加载；本插件自己与传递地 peer 了它的包推迟到回执之后；
   * peer 成环的与依赖环的这次不重新加载，回执带 restartRequired。不整页重新加载：
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

    // 升完不重新加载，运行着的还是旧版本，等于没升；旧版本目录也不会一直留着（pnpm 默认约 7 天后清掉）。所以换了目录的条目都由这条命令重新加载，只有 peer 成环的留到重启
    const targets = packagesToRemount(directoriesBefore, await this.readInstalledDirectories(homePackages), requestedPackages, this.tree.store, ownEntryId(this.ctx))
    const plannedPackages = [...targets.updated, ...targets.dependents]
    const peersOf = await this.readInstalledPeerNames(plannedPackages.map((planned) => planned.pkg))
    const order = remountOrderOf(plannedPackages.map((planned) => planned.pkg), peersOf)
    const schedule = deferredAfterSelf(order.ordered, peersOf, packageRemountingSelf(plannedPackages))
    const remounted = await this.remountInOrder(plannedPackages, schedule, order.heldBack)

    const executionOrder = [...schedule.now, ...schedule.afterReceipt, ...order.heldBack]
    const inExecutionOrder = <T extends { pkg: string }>(group: readonly T[]): T[] =>
      [...group].sort((a, b) => executionOrder.indexOf(a.pkg) - executionOrder.indexOf(b.pkg))
    const updated = inExecutionOrder(targets.updated).map<UpdatedPackage>((planned) => ({ pkg: planned.pkg, ...versionChanges.changes.get(planned.pkg)!, entries: remounted.get(planned.pkg)! }))
    const dependents = inExecutionOrder(targets.dependents).map<DependentPackage>((planned) => ({ pkg: planned.pkg, entries: remounted.get(planned.pkg)! }))

    const summary =
      updated.map(describeVersionChange).join('，') +
      (dependents.length === 0 ? '' : `；跟着重新加载 ${dependents.map((d) => d.pkg).join('、')}`)
    const deferredIds = deferredEntryIdsOf(schedule.afterReceipt, plannedPackages)
    const [ownId, ...followingIds] = deferredIds
    if (ownId !== undefined) remountSelfLater(this.tree, ownId, followingIds, this.log)
    this.log.info(`升级完成：${summary}${ownId === undefined ? '' : `；回执之后依次重新加载 ${deferredIds.join('、')}（插件管理自己在最前）`}`)
    if (order.cycles.length > 0) {
      const cycleNote = peerCycleNote(order.cycles, order.heldBack)
      this.log.warn(cycleNote)
      notes.push(cycleNote)
    }
    return {
      ok: true,
      data: { updated, dependents, selfDeferred: ownId !== undefined, ...(order.cycles.length > 0 ? { restartRequired: true } : {}), ...noteOf(notes) },
    }
  }

  /** 包 → 装上后清单里 peerDependencies 的包名。`pnpm add` 之后读：排的是这次装上的那一版的依赖 */
  private async readInstalledPeerNames(pkgs: readonly string[]): Promise<PeerNamesByPackage> {
    const manifests = await Promise.all(pkgs.map((pkg) => readInstalledPackageManifest(this.homeDir, pkg)))
    return new Map(pkgs.map((pkg, index) => [pkg, peerNamesOf(manifests[index])]))
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

  /**
   * 包 → 它每条条目的处理结果：`schedule.now` 的包在这里依次重新加载；`schedule.afterReceipt` 的包启用着的条目只记 deferred
   * （state 是重新加载前的状态），交给 `remountSelfLater`；`heldBack` 的包不动，结果是空数组。本来就停用的条目跳过
   */
  private async remountInOrder(plannedPackages: readonly PackageEntries[], schedule: RemountSchedule, heldBack: readonly string[]): Promise<Map<string, RemountedEntry[]>> {
    const plannedByPackage = new Map(plannedPackages.map((planned) => [planned.pkg, planned.entries]))
    const remounted = new Map<string, RemountedEntry[]>()
    for (const pkg of schedule.now) {
      const entries: RemountedEntry[] = []
      for (const entry of plannedByPackage.get(pkg)!) entries.push(entry.disabled ? skippedEntry(entry) : await remountNow(this.tree, entry.id, this.log))
      remounted.set(pkg, entries)
    }
    for (const pkg of schedule.afterReceipt) {
      remounted.set(
        pkg,
        plannedByPackage.get(pkg)!.map<RemountedEntry>((entry) => (entry.disabled ? skippedEntry(entry) : { id: entry.id, action: 'deferred', state: fiberStateOf(this.tree.store[entry.id]) })),
      )
    }
    for (const pkg of heldBack) remounted.set(pkg, [])
    return remounted
  }

  /** 包没装（调用方写错了）、是内核包或 cordis 直接抛；删条目与 pnpm 两步的失败转成回执 */
  async uninstall(pkg: string): Promise<Outcome<Uninstalled>> {
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

  /** 包没装就抛 */
  async addEntry(pkg: string): Promise<string> {
    assertPkgName(pkg)
    const homeDependencies = await readHomeDependencies(this.homeDir)
    if (homeDependencies[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，加不了条目。先调用 ${INSTALL_COMMAND}，或者自己去 home 里 pnpm add。`)
    }
    const entryId = this.createEntry(pkg)
    this.log.info(`条目 ${entryId}（${pkg}）加进 cordis.yml 了`)
    return entryId
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
  private createEntry(pkg: string): string {
    const chosenId = pickId(pkg, new Set(Object.keys(this.tree.store)))

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
    return withHomeRegistryAuth(pnpm, this.homeDir, ({ env }) => runPnpm({ pnpm, cwd: this.homeDir, args, env }))
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

/** 本来就停用的条目：保持停用，不重新加载 */
function skippedEntry(entry: PlannedEntry): RemountedEntry {
  return { id: entry.id, action: 'skipped', state: 'disabled' }
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
