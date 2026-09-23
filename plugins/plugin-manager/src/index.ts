import type { GwbContext, GwbResult } from '@godcreator/gwb-plugin-api'
import { isRecord, requireKernel } from './vocab.js'
// 这几条 type import 只为引入对方的 `declare module 'cordis'`，让 ctx 上有那几个服务名
// （commands 那条另带一个类型：一键热升级要持有命令插件的引用）。这些插件在这里**都是可选的**，
// 所以都用嵌套注入、都写进 devDependencies
import type { GwbCommands } from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-data'
import type {} from '@godcreator/gwb-settings'
import type {} from '@godcreator/gwb-skills'
import { readHomeDependencies } from './home.js'
import { assertId, assertIdUsable, assertPkgName, bareId, installSpec, pickId, type IdOwners } from './ids.js'
import { readEntries, reconcile, toLabels, type PluginPackageView } from './inventory.js'
import { describeAddFailure, describePnpm, locatePnpm, runPnpm, runPnpmCapture, type PnpmResult } from './pnpm.js'
import { parseOutdated, type UpdateInfo } from './outdated.js'
import { entriesForPackage } from './uninstall.js'
import { ownEntryId, treeOf, type EntryTreeLike } from './tree.js'
import { BusyGate } from './busy.js'
import { fiberStateOf, planUpdateAll, type PlannedEntry } from './update-all.js'
import { remountNow, remountOne, remountSelfLater, type RemountedEntry } from './remount.js'

export type { EntrySnapshot, PluginEntryView, PluginPackageView } from './inventory.js'
export type { RemountedEntry } from './remount.js'

/**
 * 管理 home 里的**包**和 `cordis.yml` 里的**条目**。包由 pnpm 装进 home，条目由 loader 写进 `cordis.yml`
 * ——只装包、不加条目，插件不会运行。
 *
 * **对外只有命令**（`plugin-manager.*`）。服务 `gwbPluginManager` 只表示「插件管理装了」，上面没有方法：
 * 同一件事只提供一种调用方式，所有改动都经过命令，也就都经过同一道 BUSY 检查。
 *
 * **安装 = 一次 `pnpm add` + 一条条目。** 不替插件装它的 peer，也不判断装的是不是库：插件的 peer 只该是宿主
 * 提供的 `cordis`，库该打包进用它的插件里，都不需要装进 home。装了一个没有 `apply` 的包，条目加载失败，
 * 在 `list` 里看得到。
 *
 * **卸载 = 删除条目并移除包**，设置与数据留在磁盘上。先删条目后卸包，pnpm 失败只报告、不回滚。
 *
 * **一键热升级（`update-all`）= 一次 pnpm 升级过期包，再逐条停用→启用重新加载，不重启。** 计划由
 * `update-all.ts` 里的纯函数算出。升级与重新加载必须在**同一条命令**里完成：pnpm 会删除旧版本目录，
 * 两者之间只要隔着一条命令，旧版插件读磁盘就读不到文件。本插件自己的条目排在最后、回执发出后才处理。
 *
 * 找插件、配置包源在 `@godcreator/gwb-plugin-sources`；操作面板在 `@godcreator/gwb-baseui`。
 */

/** 外壳的整页重载命令。**按命令名查找**，不 import 外壳的常量——那会让外壳成为运行时依赖 */
const SHELL_RELOAD_COMMAND = 'shell.reload'

const NAME = 'gwb-plugin-manager'

/** 注册命令时填的所属插件：包名——agent 侧按包名识别命令属于哪个插件 */
const PKG = '@godcreator/gwb-plugin-manager'

/** 显示名存在本插件自己的数据里：一份「不带前缀的 id → label」的文档 */
const LABELS_DOC = 'labels'

export const LIST_COMMAND = 'plugin-manager.list'
export const INSTALL_COMMAND = 'plugin-manager.install'
export const ADD_ENTRY_COMMAND = 'plugin-manager.add-entry'
export const REMOVE_ENTRY_COMMAND = 'plugin-manager.remove-entry'
export const ENABLE_COMMAND = 'plugin-manager.enable'
export const DISABLE_COMMAND = 'plugin-manager.disable'
export const REMOUNT_COMMAND = 'plugin-manager.remount'
export const SET_LABEL_COMMAND = 'plugin-manager.set-label'
export const OUTDATED_COMMAND = 'plugin-manager.outdated'
export const UPDATE_ALL_COMMAND = 'plugin-manager.update-all'
export const UNINSTALL_COMMAND = 'plugin-manager.uninstall'
export const TRANSFER_OWNER_COMMAND = 'plugin-manager.transfer-owner'

/**
 * 服务 `gwbPluginManager` 的值：只表示插件管理装了（别的插件 inject 它，跟着它一起加载、卸载）。
 * 命令的参数或回执有破坏性变化时 `contract` 加一
 */
export interface PluginManagerPresence {
  contract: number
}

const PRESENCE: PluginManagerPresence = { contract: 1 }

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
  /** 需要提醒的情况：全都最新、only 里列出但不在过期清单里的包、界面要手动刷新 */
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

/**
 * 归属记录：数据插件与设置插件各有一份，记录每个 id 属于哪个包。只保留用得到的两个方法——
 * `ctx.gwbData` 与 `ctx.gwbSettings` 都满足它。分配 id 时用它避开别的包留在磁盘上的数据
 */
interface OwnerBook {
  owners(): Promise<Record<string, string>> | Record<string, string>
  transferOwner(id: string, pkg: string): Promise<void>
}

export const name = NAME

export function apply(ctx: GwbContext): void {
  const manager = new PluginManager(ctx)
  ctx.effect(() => ctx.provide('gwbPluginManager', PRESENCE))
  manager.wire()
  ctx.logger(NAME).info(`插件管理已就绪，自己那条条目是 ${ownEntryId(ctx)}，查看列表调用 ${LIST_COMMAND}`)
}

class PluginManager {
  private readonly ctx: GwbContext
  /** 这个 home 的目录：pnpm 的 cwd，也是 home 的 package.json 所在的目录 */
  private readonly home: string
  /** cordis.yml 对应的条目树 */
  private readonly tree: EntryTreeLike
  /**
   * 事先拿到的 logger。一键热升级里最后重新加载本插件那一步运行时，本插件的 fiber 已经卸载——
   * 那时 ctx 上什么都不能访问，只能用事先持有的这个 logger
   */
  private readonly log: { info(message: string): void; warn(message: string): void }

  /** 装了数据插件才有。没装时只显示 id，`set-label` 返回「没装数据插件」 */
  private labelStore: LabelStore | undefined
  /** 数据插件、设置插件各自的归属记录，装了才有 */
  private dataBook: OwnerBook | undefined
  private settingsBook: OwnerBook | undefined
  /** 命令插件存在才有。一键热升级用它查找并执行 `shell.reload`——包括本插件自己重新加载之后那一次 */
  private cli: GwbCommands | undefined

  /** 同一 home 同一时刻最多一个安装、卸载、升级或重新加载，重入时返回 BUSY */
  private readonly gate = new BusyGate()
  /** 不带前缀的 id → 显示名。以内存里这份为准，磁盘上那份是它的副本 */
  private labels: Record<string, string> = {}
  /** 第一次读取 labels 是否完成。改显示名要等它——不等的话第一次改名会被读磁盘的结果覆盖 */
  private labelsReady: Promise<void> = Promise.resolve()

  /**
   * pnpm 排队执行，同一时刻只运行一个。两个 pnpm 同时运行的话，pnpm 读-改-写 home 的
   * `package.json`，后写的会把前一个加进去的依赖覆盖掉——而且没有任何报错。
   */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(ctx: GwbContext) {
    this.ctx = ctx
    this.home = requireKernel(ctx).dataDir
    this.tree = treeOf(ctx)
    this.log = ctx.logger(NAME)
  }

  wire(): void {
    this.wireData()
    this.wireSettings()
    this.wireCommands()
    this.wireSkills()
  }

  /** 说明书用局部注入：没有 skills 插件时本插件照常加载。skills/ 目录必须列进 package.json 的 files */
  private wireSkills(): void {
    this.ctx.inject(['gwbSkills'], (ctx) => {
      ctx.effect(() => ctx.gwbSkills.register(new URL('../skills/', import.meta.url)))
    })
  }

  /** 数据插件是**可选**的：用嵌套注入，它存在时才连接，卸载时自动断开，之后才加载也能连接上 */
  private wireData(): void {
    this.ctx.inject(['gwbData'], (ctx) => {
      const store: LabelStore = ctx.gwbData
      this.labelStore = store
      this.dataBook = ctx.gwbData
      this.labelsReady = store.readDoc(LABELS_DOC).then(
        (raw) => {
          this.labels = toLabels(raw)
        },
        (err: unknown) => {
          this.log.warn(`显示名读不出来，先当没有：${String(err)}`)
        },
      )
      ctx.effect(() => () => {
        this.labelStore = undefined
        this.dataBook = undefined
      })
    })
  }

  /** 设置插件也是可选的。只用它的归属记录：分配 id 时避开别的包的设置分区，转移归属时一起改 */
  private wireSettings(): void {
    this.ctx.inject(['gwbSettings'], (ctx) => {
      this.settingsBook = ctx.gwbSettings
      ctx.effect(() => () => {
        this.settingsBook = undefined
      })
    })
  }

  /** 命令插件是可选的，但没有它插件管理就没有任何对外接口 */
  private wireCommands(): void {
    this.ctx.inject(['gwbCommands'], (ctx) => {
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
      /** 安装、卸载、一键热升级、重新加载这四条命令经过互斥检查，重入时返回 BUSY */
      const onGuarded = (name: string, description: string, usage: string, handler: (args?: unknown) => unknown): void => {
        ctx.effect(() => cli.register({ name, description, usage, plugin: PKG }, (args) => this.gate.run(() => handler(args) as Promise<{ ok: boolean }> | { ok: boolean })))
      }
      const busy = '同一时刻只允许一个变更，重入回 { ok:false, error:"BUSY…" }'

      on(LIST_COMMAND, 'home 里装了哪些包、各有哪些条目', '回执按包列：包名、spec、条目（id、entryId、启停、是否 ACTIVE、显示名）。无参数', () => this.list())

      onGuarded(
        INSTALL_COMMAND,
        '往 home 装一个包并加一条条目',
        `一次 pnpm add 把包装进 home，再加一条条目（默认启用）。不装它的 peer，也不判断是不是库：装了没有 apply 的包，条目加载失败，在 plugin-manager.list 里看得到。回执 { ok, pkg, entryId?, error?, tail? }。参数 { pkg, spec? }（spec 是版本或 tag）；${busy}`,
        async (args) => {
          const raw = asRecord(args)
          const result = await this.install(text(raw, 'pkg'), optional(raw, 'spec'))
          return withTail(result)
        },
      )

      on(ADD_ENTRY_COMMAND, '给已装的包再加一条条目', '参数 { pkg, id?, config? }。不给 id 就自动生成（磁盘上有本包留下的旧 id 时优先沿用）；给的 id 在条目树上已被占用、或磁盘上的数据与设置属于别的包，直接拒绝', async (args) => {
        const raw = asRecord(args)
        const entryId = await this.addEntry(text(raw, 'pkg'), optional(raw, 'id'), raw['config'])
        return { ok: true, data: { entryId } }
      })

      on(
        TRANSFER_OWNER_COMMAND,
        '把一个 id 的数据与设置的归属转给另一个包',
        '同一个插件改了包名、要继续用旧数据与设置时调用它；数据目录与设置分区的归属一起改。参数 { id, pkg }：id 是条目 id（不带前缀的 id 或完整 entryId，条目树上不必有这条），pkg 是新的所属包名。回执 { id, pkg, data, settings }，data / settings 是 false 说明对应的插件（gwb-data / gwb-settings）没装、那一半没改',
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
        '重新加载一条条目：停用→等卸载完→启用→等加载完，一条命令做完',
        `参数 { entryId }（完整 entryId 或不带前缀的 id）。回执 { id, action, state }：action 是 remounted（在这条命令里做完，state 是重新加载后的 fiber 状态，ACTIVE 才算加载成功）或 deferred（目标是插件管理自己：先返回回执，下一个宏任务才重新加载，state 是动手前的状态，之后用 plugin-manager.list 核对 active）；操作条目树时抛错则回 ok: false，data 里 action 是 failed。原本停用的条目重新加载后是启用的；重新加载命令插件（gwb-commands）也在这条命令里做完；${busy}`,
        async (args) => {
          const result = await this.remount(text(asRecord(args), 'entryId'))
          if (result.action === 'failed') return { ok: false, error: `条目 ${result.id} 重新加载失败：${result.state}`, data: result }
          return { ok: true, data: result }
        },
      )

      on(SET_LABEL_COMMAND, '改一条条目的显示名', '参数 { entryId, label }（label 给空字符串就是清除）', async (args) => {
        const raw = asRecord(args)
        return this.setLabel(text(raw, 'entryId'), label(raw))
      })

      on(OUTDATED_COMMAND, '查已装的包哪些有新版本', 'pnpm outdated。回执 { ok, updates: { 包名: { current, latest } } }，空对象表示全都最新。无参数', async () => {
        const result = await this.outdated()
        if (result.ok) return { ok: true, data: result }
        return { ok: false, error: result.error ?? '没有给出原因' }
      })

      onGuarded(
        UPDATE_ALL_COMMAND,
        '一键热升级过期包，不重启',
        `一次 pnpm add 把过期包升到 outdated 返回的精确版本，再逐条停用→启用，重新加载成新版本（原本停用的跳过；插件管理自己排最后、回执发出后才重新加载），最后 shell.reload 整页重新加载。回执 { updated: [{ pkg, from, to, entries: [{ id, action, state }] }], selfDeferred, reload, note? }。参数 { only?: string[] }（只升这几个包；不给就全升）；${busy}`,
        async (args) => {
          const result = await this.updateAll(onlyList(args))
          return withTail(result)
        },
      )

      onGuarded(UNINSTALL_COMMAND, '卸载一个包：删除它的全部条目，再卸载包', `设置与数据留在磁盘上（只删一条条目调用 plugin-manager.remove-entry）。参数 { pkg }；${busy}`, async (args) => {
        const result = await this.uninstall(text(asRecord(args), 'pkg'))
        return withTail(result)
      })
    })
  }

  async list(): Promise<PluginPackageView[]> {
    const deps = await readHomeDependencies(this.home)
    return reconcile(deps, readEntries(this.tree.store), this.labels)
  }

  /** 调用方写错（包名、版本范围不合规）直接抛；下面每一种失败都是正常结果，转成回执 */
  async install(pkg: string, spec?: string): Promise<InstallResult> {
    const target = installSpec(pkg, spec)

    const found = locatePnpm()
    if (!found.ok) {
      this.log.warn(`装不了 ${target}：${found.error}`)
      return { ok: false, pkg, error: found.error }
    }

    this.log.info(`用 ${describePnpm(found)} 装 ${target}`)
    const run = await this.applyToHome(found.file, { add: [target] })
    if (!run.ok) {
      const failure = describeAddFailure(`pnpm add ${target}`, run)
      this.log.warn(`${failure.error}\n${failure.tail ?? ''}`)
      return { ok: false, pkg, ...failure }
    }

    try {
      const entryId = await this.createEntry(pkg)
      // 日志说「已加进」而不说「已加载」——这里不等待加载，是否加载成功看 list 的 active
      this.log.info(`${target} 装上了，条目 ${entryId} 已加进 cordis.yml`)
      return { ok: true, pkg, entryId }
    } catch (err: unknown) {
      // **不回滚删包**：留下的包会出现在 list 的「没有条目」那一组里，用户看得到；
      // 删包比留着危险，而且删除时未必只删掉这一个
      const error = `${target} 装上了，但条目加不进 cordis.yml：${String(err)}。包留在 home 里，查看列表调用 ${LIST_COMMAND}`
      this.log.warn(error)
      return { ok: false, pkg, error }
    }
  }

  /**
   * 查 home 里已装的包哪些有新版本（`pnpm outdated --json`）。
   *
   * **退出码 1 表示「存在过期包」，是结果不是失败**；0 且 stdout 为空才是「全都最新」。
   * 与安装共用同一个串行队列——它只读不写，排队等待无妨，省得另外处理并发。
   */
  async outdated(): Promise<OutdatedReceipt> {
    const found = locatePnpm()
    if (!found.ok) return { ok: false, error: found.error }

    const run = await this.queue(() =>
      runPnpmCapture({ pnpm: found.file, cwd: this.home, args: ['outdated', '--json'] }),
    )
    // pnpm 给人看的说明都在 stderr 上，两种失败情况都把它带上
    const say = (message: string): string =>
      run.stderrTail === '' ? message : `${message}\n${run.stderrTail}`
    if (run.exitCode === null) return { ok: false, error: say(`pnpm 启动失败（退出码 ${String(run.exitCode)}）`) }
    if (run.exitCode !== 0 && run.exitCode !== 1) {
      return { ok: false, error: say(`pnpm outdated 失败（退出码 ${String(run.exitCode)}）`) }
    }
    const updates = parseOutdated(run.stdout)
    if (updates === undefined) {
      return { ok: false, error: say('pnpm outdated 的输出解析不了（需要的是 JSON）——pnpm 升大版本时输出格式可能变了') }
    }
    return { ok: true, updates }
  }

  /** `only` 里包名不合规直接抛；下面每一种失败都是正常结果，转成回执 */
  async updateAll(only?: readonly string[]): Promise<UpdateAllResult> {
    for (const pkg of only ?? []) assertPkgName(pkg)
    const bare = (extra?: string): UpdateAllResult => ({ ok: false, updated: [], selfDeferred: false, ...(extra === undefined ? {} : { error: extra }) })

    const checked = await this.outdated()
    if (!checked.ok || checked.updates === undefined) return bare(checked.error ?? '查不出过期清单')

    const plan = planUpdateAll(checked.updates, this.tree.store, ownEntryId(this.ctx), only)
    const notes: string[] = []
    if (plan.ignored.length > 0) notes.push(`only 里这几个不在过期清单里，没动：${plan.ignored.join('、')}`)
    if (plan.packages.length === 0) {
      return { ok: true, updated: [], selfDeferred: false, note: ['全都最新', ...notes].join('；') }
    }

    const found = locatePnpm()
    if (!found.ok) {
      this.log.warn(`升不了：${found.error}`)
      return bare(found.error)
    }
    // 一次装完：pnpm 读-改-写 home 的 package.json，逐个包启动进程与并发安装一样会互相覆盖
    const specs = plan.pnpmArgs.slice(1)
    this.log.info(`用 ${describePnpm(found)} 一次安装 ${specs.join(' ')}`)
    const run = await this.applyToHome(found.file, { add: specs })
    if (!run.ok) {
      const failure = describeAddFailure(`pnpm ${plan.pnpmArgs.join(' ')}`, run)
      // 失败发生在重新加载之前：没有改动任何条目
      const error = `${failure.error}。一条条目都没动`
      this.log.warn(`${error}\n${failure.tail ?? ''}`)
      return { ...bare(error), ...(failure.tail === undefined ? {} : { tail: failure.tail }) }
    }

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
      this.log.info(`一键热升级完成：${summary}${reload.reload === 'done' ? '；界面已整页重载' : ''}`)
      return { ok: true, updated, selfDeferred: false, reload: reload.reload, ...noteOf(notes) }
    }

    /**
     * **本插件自己最后处理，而且在回执之后。** 在命令处理函数里停用自己，await 链随 fiber 一起卸载，回执永远
     * 到不了调用方。所以先返回回执，下一个宏任务再处理——那时命令的应答早已发出。
     * 闭包**只持有 tree、id、命令插件的引用与 logger**：本插件的 fiber 卸载之后，ctx 上的
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
    this.log.info(`一键热升级：${summary}；插件管理自己（${id}）在回执之后重新加载${canReload ? '，随后整页重载' : ''}`)
    return { ok: true, updated, selfDeferred: true, reload: canReload ? 'deferred' : 'unavailable', ...noteOf(notes) }
  }

  /** 按计划重新加载一条：本来就停用的跳过（保持停用），修改条目树时抛出的错误转成 failed */
  private async remountPlanned(entry: PlannedEntry): Promise<RemountedEntry> {
    if (entry.disabled) return { id: entry.id, action: 'skipped', state: 'disabled' }
    return remountNow(this.tree, entry.id, this.log)
  }

  async remount(entryId: string): Promise<RemountedEntry> {
    const id = this.locate(entryId)
    return remountOne(this.tree, id, bareId(ownEntryId(this.ctx)), this.log)
  }

  /** 包没装（调用方写错了）直接抛；删条目与 pnpm 两步的失败转成回执 */
  async uninstall(pkg: string): Promise<UninstallResult> {
    assertPkgName(pkg)
    const deps = await readHomeDependencies(this.home)
    if (deps[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，无法卸载。只删条目请调用 ${REMOVE_ENTRY_COMMAND}。`)
    }

    // 第一步：删除条目。逐条 tree.remove——它一次做两件事（写回 yml、立即卸载 fiber），
    // 依赖这个包的其他插件会随 fiber 一起被 cordis 卸载，停在「未加载」状态
    const ids = entriesForPackage(this.tree.store, pkg)
    for (const id of ids) this.tree.remove(id)

    // 第二步：卸载包。排进现有的串行队列，与安装、升级共用
    const found = locatePnpm()
    if (!found.ok) {
      this.log.warn(`卸不了 ${pkg}：条目已删除（${ids.length} 条），${found.error}`)
      return { ok: false, pkg, removedEntries: ids, error: found.error }
    }
    const run = await this.applyToHome(found.file, { remove: [pkg] })
    if (!run.ok) {
      // 不回滚：条目已删是可以接受的结果，包会出现在「已装、没有条目」那一组里，重试加条目即可
      const error = `pnpm remove ${pkg} 失败（退出码 ${String(run.exitCode)}）。条目已删除 ${ids.length} 条，包还在 home 里`
      this.log.warn(`${error}\n${run.tail ?? ''}`)
      return run.tail === undefined
        ? { ok: false, pkg, removedEntries: ids, error }
        : { ok: false, pkg, removedEntries: ids, error, tail: run.tail }
    }

    this.log.info(`${pkg} 卸载了：删除 ${ids.length} 条条目，包已从 home 移除。设置与数据留在磁盘上`)
    return { ok: true, pkg, removedEntries: ids }
  }

  /** 包没装、id 已被占用、id 的数据或设置属于别的包，都会抛 */
  async addEntry(pkg: string, id?: string, config?: unknown): Promise<string> {
    assertPkgName(pkg)
    const deps = await readHomeDependencies(this.home)
    if (deps[pkg] === undefined) {
      throw new Error(`home 里没装 ${pkg}，加不了条目。先调用 ${INSTALL_COMMAND}，或者自己去 home 里 pnpm add。`)
    }
    const entryId = await this.createEntry(pkg, id, config)
    // 安装有自己的「装上了」日志，这条日志只针对单独加条目的情况
    this.log.info(`条目 ${entryId}（${pkg}）加进 cordis.yml 了`)
    return entryId
  }

  /** 数据插件、设置插件没装的那部分跳过；`id` 不要求条目树上有这条 */
  async transferOwner(id: string, pkg: string): Promise<TransferOwnerResult> {
    assertPkgName(pkg)
    const bare = bareId(id)
    assertId(bare)
    const data = this.dataBook
    const settings = this.settingsBook
    if (data !== undefined) await data.transferOwner(bare, pkg)
    if (settings !== undefined) await settings.transferOwner(bare, pkg)
    this.log.info(`${bare} 的数据与设置的归属已转给 ${pkg}`)
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
    this.log.info(`条目 ${id} 已删（只删这一条，包没动；要连包一起卸载，调用 ${UNINSTALL_COMMAND}）`)
  }

  async enable(entryId: string): Promise<void> {
    // **null 表示「删掉这个字段」**，不是「设成 null」——loader 的 update 把 null 当作删除
    const id = this.locate(entryId)
    await this.tree.update(id, { disabled: null })
    this.log.info(`条目 ${id} 已启用`)
  }

  async disable(entryId: string): Promise<void> {
    const id = this.locate(entryId)
    await this.tree.update(id, { disabled: true })
    this.log.info(`条目 ${id} 已停用`)
  }

  /** 给空串就是清除。没装数据插件时返回 `ok: false`，不抛异常 */
  async setLabel(entryId: string, label: string): Promise<GwbResult> {
    const id = this.locate(entryId)
    const store = this.labelStore
    if (store === undefined) {
      return {
        ok: false,
        error: '没装数据插件（@godcreator/gwb-data），显示名存不下来。装上它、在 cordis.yml 里加一条条目，再改一次。',
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
    this.log.info(trimmed === '' ? `条目 ${id} 的显示名已清除` : `条目 ${id} 的显示名改成「${trimmed}」`)
    return { ok: true }
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
      throw new Error(`cordis.yml 里没有 id 是 ${JSON.stringify(id)} 的条目。查看列表调用 ${LIST_COMMAND}。`)
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
     * 的条目，cordis 抛 `service ... has been registered`，整个安装卡死）。
     *
     * 写入磁盘那部分是**同步**发生的：`create` 的函数体在第一个 await 之前就把 options
     * 放进了 group、安排好了写回。所以不 await 也不影响条目写入磁盘。
     *
     * 是否加载成功是另一回事，看 `list` 的 `active`；加载失败的原因在日志里。
     */
    void this.tree.create(options, null).catch((err: unknown) => {
      this.log.warn(`条目 ${final}（${pkg}）加进 cordis.yml 了，但没加载起来：${String(err)}`)
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
    const own = ownEntryId(this.ctx)
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

/** 经命令插件执行 `shell.reload`。没有命令插件、命令表里没有这条、执行失败，都返回「界面要手动刷新」 */
async function reloadVia(cli: GwbCommands | undefined): Promise<{ reload: 'done' | 'unavailable'; note?: string }> {
  if (!hasCommand(cli, SHELL_RELOAD_COMMAND) || cli === undefined) {
    return { reload: 'unavailable', note: `命令表里没有 ${SHELL_RELOAD_COMMAND}（外壳没装或版本太旧），界面要手动刷新` }
  }
  const result = await cli.run(SHELL_RELOAD_COMMAND)
  if (result.ok) return { reload: 'done' }
  return { reload: 'unavailable', note: `${SHELL_RELOAD_COMMAND} 失败（${result.error ?? '没有给出原因'}），界面要手动刷新` }
}

/** 回执里的 `note` 字段：没有要说明的就不带这个字段 */
function noteOf(notes: readonly string[]): { note?: string } {
  return notes.length === 0 ? {} : { note: notes.join('；') }
}

/**
 * 回执 → 命令的返回值。失败时 pnpm 输出的最后几行既拼进 error（给人看），也原样留在 data 里（界面要单独排版时用）
 */
function withTail(result: { ok: boolean; error?: string; tail?: string }): GwbResult {
  if (result.ok) return { ok: true, data: result }
  const tail = result.tail === undefined ? '' : `\n${result.tail}`
  return { ok: false, error: `${result.error ?? '没有给出原因'}${tail}`, data: result }
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
  if (typeof value !== 'string') throw new Error('label 要是个字符串（空字符串就是清除）')
  return value
}

declare module 'cordis' {
  interface Context {
    gwbPluginManager: PluginManagerPresence
  }
}
