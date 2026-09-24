import fs from 'node:fs'
import path from 'node:path'
import type { GwbContext } from '@godcreator/gwb-plugin-api'
import { isRecord, requireKernel } from './vocab.js'
// 只为引入对方包里的 declare module 'cordis'：ctx 上那几个服务名的类型从那里来
import type {} from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-node-cli'
import type {} from '@godcreator/gwb-shell'
import type {} from '@godcreator/gwb-skills'
import {
  asHomeName,
  bringDownHome,
  type HomeDeps,
  launchHome,
  listHomes,
  nextName,
  pickCdpPort,
  removeHome,
  resolveTarget,
  CDP_PORT_BASE,
  CDP_PORT_TRIES,
} from './home.js'
import { kill, portOwner, processName } from './node-probe-deps.js'
import { DEFAULT_REGISTRY, type DevDeps, type DevInput, runDev } from './dev.js'
import { runRelease } from './release.js'
import { auditManifest, countByKind, type ManifestDeps } from './audit.js'
import { collectManifests, collectRepos, fetchRegistry } from './node-audit-deps.js'
import { auditStructure, scanRepo, tallyKinds, type StructureFinding } from './structure.js'
import { CDP_ENTRY, devDepsWith, releaseDepsWith } from './node-dev-deps.js'
import { locatePnpm } from './pnpm-location.js'
import { homeFs, makeAppSpawnPlan, makeGuiSpawn, runCaptured } from './node-home-deps.js'
import {
  NAME_RE,
  nextSteps,
  nextStepsPlugin,
  packageRoot,
  planScaffold,
  planScaffoldPlugin,
  pluginPageTarget,
  renderPlugin,
  renderPluginPage,
  renderTemplate,
  writePluginPage,
  writeRepo,
} from './scaffold.js'
import { joinProvides, serviceSight } from './services.js'
import { importFacesOf } from './capabilities.js'
import { homesRootOf } from '../bin/cdp.mjs'

export const name = 'gwb-devkit'
export const inject = ['gwbCommands']

/** 生成 fumadocs 骨架的命令，站点插件 `@godcreator/gwb-docs-site` 提供。本包不依赖它，只在命令总线上按名字找 */
const CREATE_SITE_COMMAND = 'docs-site.create'

/** 在骨架上装六区的命令，docfirst 插件 `@godcreator/gwb-docfirst-workflow` 提供。只在刚生成的骨架上装得了 */
const ATTACH_SITE_COMMAND = 'docfirst.attach'

// 下面几段参数说明在参数不对时连同报错一起回

const SCAFFOLD_USAGE = [
  'devkit.scaffold 的参数：',
  // 规则从 NAME_RE 取，不在这里抄一份
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。它派生出包名 @godcreator/gwb-<短名>、插件名 gwb-<短名>、命令名 <短名>.<动作> 的前半`,
  '  dir    必给，目标目录的绝对路径，必须还不存在（存在就拒，不覆盖任何东西）。落下去只有一个仓形：薄壳 workspace——根壳 + plugins/<短名>/ 件包',
  '  title  可选，显示名，缺省用 name',
  `  docs   可选，缺省 true——插件文件写到磁盘之后顺带建站，两步：${CREATE_SITE_COMMAND} 生成 fumadocs 骨架、${ATTACH_SITE_COMMAND} 在骨架上装六区；六区装好之后再写插件页起稿 docs-site/content/docs/plugins/<短名>.mdx。两条都经命令总线找，没装那个插件就跳过那一步（回执里说怎么补），不算建仓失败。false 就只生成插件文件`,
  '  port   可选，文档站端口。不给由站件自己挑（扫邻居已占的，从 4310 起找空位）',
  '例：{"name":"hello","dir":"D:\\\\tmp\\\\hello","title":"打个招呼"}',
].join('\n')

const SCAFFOLD_PLUGIN_USAGE = [
  'devkit.scaffold.plugin 的参数：',
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。派生规则同 devkit.scaffold`,
  '  repo   必给，薄壳仓根的绝对路径（pnpm-workspace.yaml 住的那层）。yaml 里得有 plugins/ 那条——老裸根单件仓（仓根即包根）先迁成薄壳再来，报错里带路',
  '  title  可选，显示名，缺省用 name',
  '插件包写到 <repo>/plugins/<短名>/，必须还不存在（存在就拒，不覆盖任何东西）。仓根与 workspace 配置不碰；仓里有装好六区的文档站（docs-site/docfirst.config.mjs 在）时，再写插件页起稿 docs-site/content/docs/plugins/<短名>.mdx（已存在就拒）。README 的插件清单由人更新（回执 nextSteps 里提醒）',
  '例：{"repo":"D:\\\\tmp\\\\hello","name":"world","title":"第二件"}',
].join('\n')

const STRUCTURE_USAGE = [
  'devkit.audit-structure 的参数：',
  '  dir   可选，单仓的绝对路径——只体检这一个仓',
  '  root  可选，容器根的绝对路径——扫全生态（unit-folder.list 现问缺省）。',
  '        dir 与 root 都不给就是全生态',
  '只读。管形状与静态红线（仓形 / 件包自足 / 短名派生链 / files 白名单 / prepublishOnly /',
  'cordis 位置 / tsconfig paths / link:·file: 依赖 / gwb.provides 与源码对应），不管版本（那是 audit-deps 与发版检票）、',
  '不管产物（各仓 artifact 测试）。',
  'gwb.provides（keywords 含 gwb 或 gwb-plugin 的包）：源码提供的每个服务都要有一条；每个键是源码提供的服务名，',
  '或本包 exports 里的 import 说明符（主入口写包名，子路径写 包名/子路径）；每条的 summary、usage 是非空字符串。',
  '没过记一条 error 级的 provides-declaration，devkit.release 的发版前检查同样查这一条。',
  'findings 分级：error 长不成或装不上、warn 偏离当前形、info 提示（裸根单件仓给迁移清单）。',
  '例：{"dir":"D:\\\\unitfolders\\\\evew5-gwbapps\\\\gwb-block-note"}',
].join('\n')

const HOME_USAGE = [
  'home 命令的参数：',
  '  devkit.home.new  { short 必给（kebab-case 短名） }——开 <short>-<yyMMddHHmm> 的新 home。启动之前装好内核包（运行中的内核的精确版本）、cordis（内核包要的精确版本）与七个基础插件，再用宿主安装版启动，调试端口自动选',
  '  devkit.home.open { name 必给（完整 home 名） }——重开一个已有的 home，不 build。机器重启之后回到现场走这条',
  '  devkit.home.rm   { name，force? }——删一个 home。没在跑的直接删；还在跑的要 force（连停带删，等进程真退再删）；目录真不在了才回已删',
  '                     default 是日常那份：不 force 不删，而且它在跑的时候 force 也不删——自己关掉那扇窗再来',
  '  devkit.home.list {}——列出 home 根下全部 home 与谁在跑',
  '例：{"short":"data"}、{"name":"data-2609081430"}',
  '**这几条都不收调试口**：口是起的时候自动挑的（先沿用这个 home 上次那个，被占了才另挑），',
  '之后从它的 runtime.json 里查。端口没有语义，敲错一位就落在另一个现场。',
].join('\n')

const DEV_USAGE = [
  'devkit.dev 的参数：',
  '  home      必给，目标 home 名。**这儿不收端口**：口从那个 home 的 runtime.json 里查，顺带验活',
  '            （记录读得出、pid 还活着、那个 pid 真的持着那个口），再拿页面自报的名字核对一次',
  '  dir       必给，仓根的绝对路径。构建在这儿跑',
  '  packages  可选，要发的包目录，相对仓根，**按依赖顺序**（被依赖的排前面）。不给就是仓根自己',
  '  waitFor   可选，刷新之后等页面上这个选择器出现才算刷回来了',
  '**发内核包**（packages 里有 @godcreator/gwb-kernel-desktop 的包目录）：内核包连同它 peer 里的 cordis（必须是精确版本号）',
  '一起写进目标 home 的清单再装；不重挂、不刷新，改成停掉目标 home 再启动，轮询 shell.env 直到页面报出的内核版本就是这次发的号',
  '**构建不可跳过**：产物不新就发＝发的是上一版，而回执一切正常。源也不收：这台机器上只有',
  '一个，就是 ' + DEFAULT_REGISTRY,
  '例：{"home":"bn-2609111200","dir":"D:\\\\unitfolders\\\\evew5-gwbapps\\\\gwb-block-note","packages":["packages/model","plugins/gwb-bn-core"]}',
  '目标 home 是 default、或者就是本件自己住的那个，都当场拒——前者会把开发版塞进日常那份，',
  '后者停用条目那一下会把正在跑的这条命令自己停掉。换 devkit 自己：发正式版，再 plugin-manager.update-all',
].join('\n')

const RELEASE_USAGE = [
  'devkit.release 的参数：',
  '  dir       必给，仓根的绝对路径。git 守卫与构建都在这儿跑',
  '  packages  可选，要发的包目录，相对仓根，**按依赖顺序**（被依赖的排前面）。不给就是仓根自己',
  '**号在仓里抬**：发的是 package.json 里声明的那个号，同号在源上就拒——要发新的一版，先抬号、提交，再来',
  '**仓根 git 树不干净就拒**：正式版只从提交过的状态发',
  '**发版前检查没过就拒**（构建之后，所有包一次列全）：自己不在 0.0.x；@godcreator 的 dev 范围包含源上 dist-tags.latest；产物里没有空 import（import { type X } 留下的）；包目录里 pnpm exec tsc --noEmit -p <tsconfig> --skipLibCheck false 通过（node 侧有 tsconfig.build.json 就查它、没有查 tsconfig.json、两份都没有就拒，有 src/client/tsconfig.json 再查一次；测试与构建脚本不查）；keywords 含 gwb 或 gwb-plugin 的包，gwb.provides 与源码对应（源码提供的每个服务都有一条；每个键是源码提供的服务名或本包 exports 里的 import 说明符；每条的 summary、usage 是非空字符串）',
  '**插件包另加**（keywords 含 gwb-plugin）：peer 里只有 cordis 与内核包 @godcreator/gwb-kernel-desktop，node 侧产物按值 import 了 cordis 就必须写 peer cordis；node 侧产物（exports["."] 入口顺着相对 import 走到的文件）的包名 import 只有 node 内置模块、electron、cordis；浏览器侧产物（dist/client.js 与本包 gwb.shared 指到的文件）只 import importmap 里的名字；peer 里写了内核包、写法是 ^x.y.z、范围包含运行中的内核（主版本号为 0 时次版本号相同，≥1 时主版本号相同，并且不低于下限）；写了 gwb.requires 的，它是 { 包名: 最低版本号 } 的对象、每个值是 x.y.z、每个包也写在 devDependencies 里、要求的版本不高于 dev 范围的下限（dev 写 workspace: 的不比下限）',
  '**这条链只碰源、不碰任何 home**，从哪个 home 调都行；升 default 是下一步的事，走 plugin-manager.update-all',
  '例：{"dir":"D:\\\\unitfolders\\\\evew5-gwbapps\\\\gwb-block-note","packages":["packages/model","packages/engine","packages/client","plugins/gwb-bn-core","plugins/gwb-bn-comment"]}',
].join('\n')

type CommandBus = NonNullable<GwbContext['gwbCommands']>
type Logger = ReturnType<GwbContext['logger']>

/** 各段命令登记共用的东西 */
interface Wiring {
  ctx: GwbContext
  log: Logger
  commands: CommandBus
  /** 命令总线上此刻有没有这条命令。每次现问、不缓存：插件是热加载的，装一个新插件答案当场就变 */
  hasCommand(command: string): boolean
  homeDeps: HomeDeps
}

export function apply(ctx: GwbContext): void {
  const log = ctx.logger(name)
  const bus = ctx.gwbCommands
  if (bus === undefined) {
    // export const inject 在，理论上走不到这里；走到就直说，别让命令表不声不响地空着
    log.warn('gwbCommands 服务不在（inject 没生效？）——命令一条没挂')
    return
  }
  const wiring: Wiring = {
    ctx,
    log,
    commands: bus,
    hasCommand: (command) => bus.list().some((entry) => entry.name === command),
    homeDeps: {
      fs: homeFs,
      spawn: makeGuiSpawn((message) => log.warn(message)),
      appSpawnPlan: makeAppSpawnPlan(),
      run: runCaptured,
      processName,
      portOwner,
      kill,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      execPath: process.execPath,
      env: process.env,
      platform: process.platform,
    },
  }

  registerHomeCommands(wiring)
  registerServiceCommands(wiring)
  describeSelfToShell(ctx)
  registerCdpCli(ctx)
  registerDevCommand(wiring)
  registerReleaseCommand(wiring)
  registerAuditDepsCommand(wiring)
  registerAuditStructureCommand(wiring)
  registerScaffoldCommand(wiring)
  registerScaffoldPluginCommand(wiring)
  registerOwnSkills(ctx)
  logReady(wiring)
}

// ── 测试 home ────────────────────────────────────────────────────────────────

/** 调试端口自动选，选不出来就不启动：只按名字找 home 之后，没有调试端口的 home 启动完就连不上。换了端口回执里说一句 */
async function cdpPortFor(
  root: string,
  homeName: string,
  homeDeps: HomeDeps,
): Promise<{ ok: true; cdp: number; note?: string } | { ok: false; error: string }> {
  const picked = await pickCdpPort(root, homeDeps, homeName)
  if (picked === undefined) {
    return {
      ok: false,
      error: `从 ${String(CDP_PORT_BASE)} 往上找了 ${String(CDP_PORT_TRIES)} 个口，一个空的都没有——这台机器上是不是攒了一堆没停的 home（devkit.home.list）`,
    }
  }
  return {
    ok: true,
    cdp: picked.port,
    ...(picked.reused ? {} : { note: `调试口 ${String(picked.port)}（上次那个被占着或者还没有，另挑的）` }),
  }
}

function registerHomeCommands({ ctx, log, commands, homeDeps }: Wiring): void {
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.home.new',
        plugin: '@godcreator/gwb-devkit',
        description: '开一个测试 home（装内核包、cordis 与基础插件，用宿主安装版启动，调试端口自动选）',
        usage:
          '{short 必给（kebab-case）}——名字是 <short>-<yyMMddHHmm>。启动之前往新 home 里依次 pnpm add 三次（写好 cordis.yml 条目）：先装内核包 @godcreator/gwb-kernel-desktop，精确版本是运行这条命令的内核的 gwbKernel.version，带 --save-exact；再装装上的内核包 peerDependencies.cordis 写的那个精确版本的 cordis，同样带 --save-exact；最后装七个基础插件。内核包与 cordis 装完都读 node_modules 里的清单核对版本。安装包只带启动器、从 home 里加载内核，所以内核包必须装上；哪一步没成都不启动。然后用宿主自己那个 exe 再开一个窗口（安装版认 GWB_HOME；不构建内核、不认内核仓），调试端口自动选一个空的。回执里带着现有 home 清单，开新的时候顺便清理旧的',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const short = asHomeName(args.short)
        if (short === undefined) return { ok: false, error: `short 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const root = homesRootOf()
        let homeName: string
        try {
          homeName = nextName(short, homeDeps.now(), (candidate) => homeDeps.fs.exists(path.join(root, candidate)))
        } catch (err) {
          return { ok: false, error: String(err instanceof Error ? err.message : err) }
        }
        const pnpm = await locatePnpm()
        if (!pnpm.ok) return { ok: false, error: pnpm.error }
        const port = await cdpPortFor(root, homeName, homeDeps)
        if (!port.ok) return { ok: false, error: port.error }
        const outcome = await launchHome(
          { name: homeName, homesRoot: root, cdp: port.cdp, install: { kernelVersion: requireKernel(ctx).version, pnpm: pnpm.file } },
          homeDeps,
        )
        if (!outcome.ok) {
          log.warn(`home.new 没成：${outcome.error}`)
          return outcome
        }
        log.info(`devkit.home.new：${outcome.note}`)
        return { ok: true, data: { ...outcome, ...(port.note === undefined ? {} : { cdpNote: port.note }), homes: await listHomes(root, homeDeps) } }
      },
    ),
  )

  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.home.open',
        plugin: '@godcreator/gwb-devkit',
        description: '重开一个已有的测试 home（拉宿主安装版）',
        usage: '{name 必给}——调试口自动挑。机器重启之后回到原来那个现场只有这一条路（home.new 永远造新目录，件得全部重装一遍）',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const homeName = asHomeName(args.name)
        if (homeName === undefined) return { ok: false, error: `name 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const root = homesRootOf()
        if (!homeDeps.fs.exists(path.join(root, homeName))) {
          return { ok: false, error: `${path.join(root, homeName)} 不在——没有这个 home（看 devkit.home.list）` }
        }
        const port = await cdpPortFor(root, homeName, homeDeps)
        if (!port.ok) return { ok: false, error: port.error }
        const outcome = await launchHome(
          { name: homeName, homesRoot: root, cdp: port.cdp },
          homeDeps,
        )
        if (!outcome.ok) {
          log.warn(`home.open 没成：${outcome.error}`)
          return outcome
        }
        log.info(`devkit.home.open：${outcome.note}`)
        return { ok: true, data: { ...outcome, ...(port.note === undefined ? {} : { cdpNote: port.note }) } }
      },
    ),
  )

  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.home.rm',
        plugin: '@godcreator/gwb-devkit',
        description: '删一个测试 home',
        usage:
          '{name，force?}——没在跑的直接删；**还在跑的要 force**，那时连停带删（按它 runtime.json 里的 pid，核对映像名与记录里那个 CDP 端口再杀，按 pid 等进程真退了才删）。**回「已删」只在目录真不在了之后**，没删掉回 ok:false 并列出还剩什么。default 是日常那份：不 force 不删，而且它在跑的时候 force 也不删，自己关掉那扇窗再来',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const homeName = asHomeName(args.name)
        if (homeName === undefined) return { ok: false, error: `name 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const outcome = await removeHome(path.join(homesRootOf(), homeName), homeName, args.force === true, homeDeps)
        if (outcome.ok) log.info(`devkit.home.rm：${outcome.note}`)
        else log.warn(`devkit.home.rm 没成：${outcome.note}`)
        return outcome.ok ? { ok: true, data: outcome } : { ok: false, error: outcome.note }
      },
    ),
  )

  ctx.effect(() =>
    commands.register(
      { name: 'devkit.home.list', plugin: '@godcreator/gwb-devkit', description: '列出全部测试 home 与各自的口', usage: '名字（带时间戳）、谁还在跑、CDP 口、MCP 门（mcp 格；老 home 的 command-http 格照报当线索）。无参数' },
      async () => {
        const root = homesRootOf()
        return { ok: true, data: { root, homes: await listHomes(root, homeDeps) } }
      },
    ),
  )
}

// ── 能用什么 ──────────────────────────────────────────────────────────────────

async function readHomePackageManifest(homeDir: string, pkg: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(homeDir, 'node_modules', pkg, 'package.json'), 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function homeDependencyNames(homeDir: string): Promise<string[]> {
  try {
    const homeManifest: unknown = JSON.parse(await fs.promises.readFile(path.join(homeDir, 'package.json'), 'utf8'))
    const dependencies = isRecord(homeManifest) ? homeManifest['dependencies'] : undefined
    return isRecord(dependencies) ? Object.keys(dependencies) : []
  } catch {
    // home 清单读不到：import 段是空表，inject 段照常
    return []
  }
}

/** inject 段是运行时现问的服务表，import 段是 home 已装包的入口；用法都取自各包自己的 gwb.provides */
async function capabilitiesOf(ctx: GwbContext): Promise<unknown> {
  const homeDir = requireKernel(ctx).dataDir
  const readManifest = (pkg: string): Promise<unknown> => readHomePackageManifest(homeDir, pkg)
  const injectable = await joinProvides(serviceSight(ctx).owners, readManifest)
  const faces = await importFacesOf(await homeDependencyNames(homeDir), (pkg) => readManifest(pkg))
  return {
    inject: injectable,
    import: faces,
    commands: '件暴露的命令面不在这儿重复——search {"plugin":"<包名>"} 按件查，那是命令的家',
  }
}

function registerServiceCommands({ ctx, commands }: Wiring): void {
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.services',
        plugin: '@godcreator/gwb-devkit',
        description: '这台 home 里有哪些 cordis 服务、各是谁提供的、怎么用——运行时现问，用法从各包 gwb.provides 声明 join',
        usage:
          '无参数。回 { services: [{ service, entryId?, pkg?, provides? }] }——entryId 是 cordis.yml 里的条目名，pkg 是包名；两个都没有的是内核自己挂的服务。provides 是那个包在自家 package.json 的 gwb.provides 里声明的 { summary, usage }，写插件要接一面时照它用——没声明的服务照样列，只是不带用法。拿不到运行时的服务表时回空表加 note 与 saw（看见了几层 fiber 链、几个件、几张服务表）——用来分辨「这个宿主不是 cordis」和「cordis 换了形状」',
      },
      async () => {
        const sight = serviceSight(ctx)
        const homeDir = requireKernel(ctx).dataDir
        const services = await joinProvides(sight.owners, (pkg) => readHomePackageManifest(homeDir, pkg))
        return {
          ok: true,
          data: {
            services,
            ...(sight.owners.length === 0
              ? {
                  note: `运行时没给出服务表——看见的东西：自己的 fiber 链 ${String(sight.saw.chainDepth)} 层、件 ${String(sight.saw.runtimes)} 个、fiber ${String(sight.saw.fibers)} 条、服务表 ${String(sight.saw.stores)} 张。全是 0 说明这个 ctx 上没有 cordis 的 fiber/registry；有 fiber 而表是 0 张，多半是 cordis 换了形状`,
                  saw: sight.saw,
                }
              : {}),
          },
        }
      },
    ),
  )

  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.capabilities',
        plugin: '@godcreator/gwb-devkit',
        description: '开发一个新插件能基于什么：可 inject 的服务、可 import 的包与入口、类型正本在哪——一站看全，别孤零零从零做',
        usage:
          '无参数。回 { inject, import, commands } 三段。inject：这台 home 现挂的 cordis 服务，带各包 gwb.provides 自述（要接一面照 usage 写）。import：home 已装包逐个列——身份（件/库/第三方）、import 时写的入口说明符、d.ts 路径（符号级看原文，命令不摘抄）、importmap 外置名（shared，react 系那种）与意图自述。commands：指 search。事实现算不抄；没声明的入口照样列、只是少一句人话',
      },
      async () => ({ ok: true, data: await capabilitiesOf(ctx) }),
    ),
  )
}

/** 本插件没有页面：使用者是 agent，读的是回执。只报一个给人看的名字，外壳不在就不报 */
function describeSelfToShell(ctx: GwbContext): void {
  ctx.inject(['gwbShell'], (scoped) => {
    scoped.gwbShell.describeSelf({ title: '开发套件', icon: 'wrench' })
  })
}

/**
 * 命令行工具经 gwbNodeCli 登记：登记的命令自动出现在命令总线上，回执带 stdout 与退出码。
 * register 不用自己包 effect：它已经登记在调用方的 effect 上
 */
function registerCdpCli(ctx: GwbContext): void {
  ctx.inject(['gwbNodeCli'], (scoped) => {
    scoped.gwbNodeCli.register({
      name: 'devkit.cdp',
      plugin: '@godcreator/gwb-devkit',
      description: '在一个工作台页面里动手（CDP 直达，只对隔离 home 用）',
      usage:
        '{"args":["<home 名>","<动作>","<参数…>"]}。**第一个位置只收 home 名，给数字当场拒**——口从那个 home 的 runtime.json 里查，连上之后还拿页面自报的名字核对一次。动作 eval <文件绝对路径> [JSON 参数] / shot [图.png 绝对路径] [选择器] / move / click / rclick / drag / type / key / scroll <点> / cmd <命令名> [JSON 参数] / reload [选择器] [秒] / home。点写成 .sel、.sel@=文字、.a@=文字 >> .b，或 x,y。开关 --target / --mod / --pad / --size / --timeout。**路径不看工作目录**：截图缺省落被截那个 home 自己的 out\\cdp\\，要落别处给绝对路径；eval 的文件只收绝对路径，相对的当场拒；落点在本包目录或任何 node_modules 里也拒。**只对隔离 home 用，绝不打 default**：这儿发的是真操作。够不着的 home 是起的时候没带 --remote-debugging-port，停掉重开一次',
      entry: CDP_ENTRY,
    })
  })
}

// ── 改一版看一版与发正式版 ────────────────────────────────────────────────────

/** 停掉再启动同一个测试 home。调试端口照启动时的规则挑：先沿用上次那个 */
async function restartTestHome(homeName: string, homeDeps: HomeDeps): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const root = homesRootOf()
  const stopped = await bringDownHome(path.join(root, homeName), homeDeps)
  if (!stopped.ok) return { ok: false, error: stopped.note }
  const port = await cdpPortFor(root, homeName, homeDeps)
  if (!port.ok) return port
  const launched = await launchHome({ name: homeName, homesRoot: root, cdp: port.cdp }, homeDeps)
  if (!launched.ok) return { ok: false, error: launched.error }
  return { ok: true, note: `${stopped.note};${launched.note}` }
}

/**
 * 只收 home 名，不收端口：端口从那个 home 的 `runtime.json` 查并确认进程还在，名字再传下去跟页面自报的核对。
 * 给了 `cdp` 当场拒并告诉新写法，不静默改道
 */
async function cdpTargetOf(
  args: Record<string, unknown>,
  homeDeps: HomeDeps,
): Promise<{ ok: true; cdp: number; name: string } | { ok: false; error: string }> {
  if (args.cdp !== undefined) {
    return {
      ok: false,
      error: `这儿不收端口了，只收 home 名：{"home":"<名>"}。口从那个 home 的 runtime.json 里查，顺带验活。\n${DEV_USAGE}`,
    }
  }
  const homeName = asHomeName(args.home)
  if (homeName === undefined) return { ok: false, error: `home 缺了或不是个合格的 home 名（kebab-case）。\n${DEV_USAGE}` }
  const found = await resolveTarget(homesRootOf(), homeName, homeDeps)
  if (!found.ok) return { ok: false, error: found.error }
  return { ok: true, cdp: found.cdp, name: homeName }
}

function packagesArgOf(args: Record<string, unknown>): string[] {
  return Array.isArray(args.packages)
    ? args.packages.filter((one): one is string => typeof one === 'string' && one.trim() !== '')
    : []
}

function registerDevCommand({ ctx, log, commands, homeDeps }: Wiring): void {
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.dev',
        plugin: '@godcreator/gwb-devkit',
        description: '改一版看一版（build→发 dev 版→目标 home 热挂→取证；发内核包时改成重启目标 home）',
        usage:
          '{home 必给（目标 home 名，**只认名字不认端口**——口从它的 runtime.json 里查并验活）, dir 必给（仓根绝对路径）, packages?（包目录，相对仓根，按依赖顺序；不给就是仓根自己）, waitFor?（刷新后等这个选择器出现）}。一条走完：仓根 pnpm build → 发开发版（<patch+1>-dev.<戳>，标 dev 不动 latest）→ 目标 home 的 package.json 写那个准确号再 pnpm install，读回 node_modules 里装上的号核对（对不上当场 ok:false，不重挂）→ 逐条 plugin-manager.remount 重挂（一条命令做完停用再启用，目标 home 的 plugin-manager 要 ≥0.4.0；重挂 plugin-manager 自己时回执之后才动手，这边轮询到它回来）→ 整页重载 → 取证（装上的是这一趟的号、条目真 ACTIVE、日志增量里没有 error），取不到证就回 ok:false。**packages 里有内核包 @godcreator/gwb-kernel-desktop 时**：它 peer 里的 cordis（必须是精确版本号）也按准确号写进清单一起装并核对；不重挂、不整页重载，改成停掉目标 home 再启动（主进程里的内核换不掉），轮询 shell.env 直到 versions.kernel 就是这次发的号，回执多一格 kernel { version, restart }，再照常取证。**构建与源都不可给**：跳过构建就是发上一版，而这台机器只有一个源。**目标是 default 或本件自己所在的 home 都当场拒；页面自报的名字跟你给的对不上也拒**',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${DEV_USAGE}` }
        const target = await cdpTargetOf(args, homeDeps)
        if (!target.ok) return { ok: false, error: target.error }
        const dir = typeof args.dir === 'string' ? args.dir.trim() : ''
        if (dir === '' || !path.isAbsolute(dir)) return { ok: false, error: `dir 要是仓根的绝对路径。\n${DEV_USAGE}` }
        if (!fs.existsSync(dir)) return { ok: false, error: `${dir} 不在——dir 给的是仓根，不是包目录` }
        const pnpm = await locatePnpm()
        if (!pnpm.ok) return { ok: false, error: pnpm.error }
        const input: DevInput = {
          home: target.name,
          repoDir: path.resolve(dir),
          packages: packagesArgOf(args),
          ...(typeof args.waitFor === 'string' && args.waitFor.trim() !== '' ? { waitFor: args.waitFor.trim() } : {}),
          ownHome: requireKernel(ctx).dataDir,
        }
        log.info(`devkit.dev：仓 ${input.repoDir} → ${target.name}（调试口 ${String(target.cdp)}）`)
        const deps: DevDeps = { ...devDepsWith(pnpm.file), restartHome: (home) => restartTestHome(home, homeDeps) }
        const outcome = await runDev(input, deps)
        if (!outcome.ok) {
          log.warn(`devkit.dev 没成：${outcome.error}`)
          return outcome.data === undefined
            ? { ok: false, error: outcome.error }
            : { ok: false, error: outcome.error, data: outcome.data }
        }
        log.info(`devkit.dev：${outcome.data.homeName} 换上了 ${outcome.data.shipped.map((one) => `${one.pkg}@${one.version}`).join('、')}`)
        return outcome
      },
    ),
  )
}

/** 只发到源、不碰任何 home，从哪个 home 调都行；升级 default 不接在后面：先在隔离 home 验过，再由插件管理自己升级 */
function registerReleaseCommand({ ctx, log, commands }: Wiring): void {
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.release',
        plugin: '@godcreator/gwb-devkit',
        description: '发正式版到团队源（git 工作区干净→构建→验产物→发版前检查→在临时目录里组装并发布）',
        usage:
          '{dir 必给（仓根绝对路径）, packages?（包目录，相对仓根，按依赖顺序；不给就是仓根自己）}。一条走完：仓根 git 工作区干净（有未提交改动就拒，一个都不发）→ 仓根 pnpm build → 照 files 白名单验产物 → 同号已在源上就拒 → 发版前检查（每个要发的包：自己不在 0.0.x；@godcreator 的 dev 范围包含源上 dist-tags.latest，workspace: 跳过，范围内落后放行；产物里没有空 import、相对 import 指向的文件都在；包目录里 pnpm exec tsc --noEmit -p <tsconfig> --skipLibCheck false 通过——node 侧有 tsconfig.build.json 就查它、没有查 tsconfig.json、两份都没有就拒，有 src/client/tsconfig.json 再查一次，测试与构建脚本不查；keywords 含 gwb 或 gwb-plugin 的包，gwb.provides 与源码对应——源码（src/ 下 super(ctx, 名)、ctx.provide(名)、new X(ctx, 名) 三种写法）提供的每个服务都有一条，每个键是源码提供的服务名或本包 exports 里的 import 说明符（主入口写包名，子路径写 包名/子路径），每条的 summary、usage 是非空字符串。keywords 含 gwb-plugin 的插件包另加：peer 里只有 cordis 与内核包 @godcreator/gwb-kernel-desktop，node 侧产物按值 import 了 cordis 就必须写 peer cordis；node 侧产物——exports["."] 的运行时入口（没有 exports 时是 main）顺着相对 import 走到的文件——的包名 import 只有 node 内置模块、electron、cordis；浏览器侧产物——dist/client.js 与本包 gwb.shared 指到的文件，同样顺着相对 import 走——只 import importmap 里的名字，名字取本包与它依赖到的包的 gwb.shared 键，依赖的清单从包目录的 node_modules 现读；peer 里写了内核包、写法是 ^x.y.z、范围包含运行中的内核 gwbKernel.version——主版本号为 0 时次版本号相同，≥1 时主版本号相同，并且不低于下限，预发布段不看。没过就一个都不发，回执按包一次列全；写了 peer cordis 而 node 侧产物没 import 它只提醒，带在回执 reminders 里）→ 在临时目录里组装发布内容并发布（不改仓里任何文件；tag latest；workspace: 依赖写成 ^<工作区里那个号>，这一次同发的写成 ^新号）→ 按给定顺序发完。**号在仓里升**（改 package.json 提交），同号永不重发。只碰源不碰任何 home；升 default 走 plugin-manager.update-all',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${RELEASE_USAGE}` }
        const dir = typeof args.dir === 'string' ? args.dir.trim() : ''
        if (dir === '' || !path.isAbsolute(dir)) return { ok: false, error: `dir 要是仓根的绝对路径。\n${RELEASE_USAGE}` }
        if (!fs.existsSync(dir)) return { ok: false, error: `${dir} 不在——dir 给的是仓根，不是包目录` }
        const pnpm = await locatePnpm()
        if (!pnpm.ok) return { ok: false, error: pnpm.error }
        const packages = packagesArgOf(args)
        log.info(`devkit.release：仓 ${path.resolve(dir)}（${packages.length === 0 ? '仓根自己' : packages.join('、')}）`)
        const outcome = await runRelease({ repoDir: path.resolve(dir), packages, runningKernel: requireKernel(ctx).version }, releaseDepsWith(pnpm.file))
        if (!outcome.ok) {
          log.warn(`devkit.release 没成：${outcome.error}`)
          return outcome.data === undefined
            ? { ok: false, error: outcome.error }
            : { ok: false, error: outcome.error, data: outcome.data }
        }
        log.info(`devkit.release：${outcome.data.shipped.map((one) => `${one.pkg}@${one.version}`).join('、')} 上了 latest`)
        return outcome
      },
    ),
  )
}

// ── 依赖对账与结构体检 ────────────────────────────────────────────────────────

/** 给了就用给的；没给就在命令总线上按名字调 unit-folder.list 要容器根（容器根归单元文件夹插件管） */
async function containerRootOf({ commands, hasCommand }: Wiring, askedRoot: string): Promise<string | undefined> {
  if (askedRoot !== '') return path.resolve(askedRoot)
  if (!hasCommand('unit-folder.list')) return undefined
  const listed = await commands.run('unit-folder.list', {})
  const container = listed.ok && isRecord(listed.data) && typeof listed.data.container === 'string' ? listed.data.container : ''
  return container !== '' ? path.resolve(container) : undefined
}

function registerAuditDepsCommand(wiring: Wiring): void {
  const { ctx, log, commands } = wiring
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.audit-deps',
        plugin: '@godcreator/gwb-devkit',
        description: '全生态依赖对账：各插件仓 @godcreator 的 dev 依赖对照团队源上的最新正式版，插件包的 peer 只许 cordis 与内核包；只报告',
        usage:
          '{root?（容器根绝对路径，缺省现问命令总线 unit-folder.list 回的 container）, registry?（缺省个人源）}。无参数直接调也行。回执 { ok, data: { root, registry, repos, manifests, packages, retired, testUnits, findings, byKind } }——findings 逐条 { kind, repo, manifest, pkg, detail }；kind：dead-pin（钉了源上没有的版本，装必炸）/ behind（dev 钉落后源上 dist-tags.latest 但还在 ^<dev 钉> 范围内，提示，等各自下次发版；dev 号不算最新）/ out-of-range（最新已出 ^ 范围，上游出了破坏版，必须跟进）/ loose-dev-pin（dev 写法既不是精确号也不是 ^ 范围）/ peer-not-cordis（keywords 含 gwb-plugin 的插件包 peer 里写了 cordis 与内核包 @godcreator/gwb-kernel-desktop 以外的包，下次发版时 devkit.release 会拒；peer 里内核包写没写对由发版前检查查，这里不查）。退役单元（unit.json 的 status 是 retired）与**测试件**（kind 是「测试件」的单元，测试用途的示范件）整个不扫，名字分别列在 retired 与 testUnits；private: true 的清单不发布，只查 dev、不查 peer。只报告不拦。只读不改：扫仓、读 package.json、问源',
      },
      async (args) => {
        const askedRoot = isRecord(args) && typeof args.root === 'string' ? args.root.trim() : ''
        const root = await containerRootOf(wiring, askedRoot)
        if (root === undefined) {
          return { ok: false, error: '扫哪没说清：给 root（容器根的绝对路径），或在这个 home 装 @godcreator/gwb-unit-folder——它现扫回的 container 就是容器根' }
        }
        if (!fs.existsSync(root)) return { ok: false, error: `${root} 不在——root 给的是容器根（unit.json 们住的那层）` }
        const registryBase = isRecord(args) && typeof args.registry === 'string' && args.registry.trim() !== '' ? args.registry.trim() : DEFAULT_REGISTRY

        const { repos: repoDirs, retired, testUnits } = collectRepos(root)
        const repoRel = (dir: string): string => path.relative(root, dir).replaceAll('\\', '/')
        const manifests: { repo: string; manifest: string; deps: ManifestDeps }[] = []
        for (const dir of repoDirs) {
          for (const one of collectManifests(dir)) manifests.push({ repo: repoRel(dir), manifest: one.rel, deps: one.deps })
        }
        if (manifests.length === 0) return { ok: false, error: `${root} 下面一份带 @godcreator 依赖的 package.json 都没扫到——root 是不是给错了` }
        const pkgs = [...new Set(manifests.flatMap((m) => Object.keys(m.deps.devs)))]
        const registry = await fetchRegistry(pkgs, registryBase)
        const findings = manifests.flatMap((m) => auditManifest(m.repo, m.manifest, m.deps, registry))
        const byKind = countByKind(findings)
        log.info(
          `devkit.audit-deps：${String(repoDirs.length)} 仓 ${String(manifests.length)} 份 manifest 对 ${String(pkgs.length)} 个包（退役单元 ${String(retired.length)} 个、测试件 ${String(testUnits.length)} 个不扫）——` +
            `源上没有的版本 ${String(byKind['dead-pin'])}、出范围 ${String(byKind['out-of-range'])}、范围内落后 ${String(byKind.behind)}、peer 写了 cordis 与内核包以外的包 ${String(byKind['peer-not-cordis'])}`,
        )
        return { ok: true, data: { root, registry: registryBase, repos: repoDirs.length, manifests: manifests.length, packages: pkgs.length, retired, testUnits, findings, byKind } }
      },
    ),
  )
}

function auditOneRepo(log: Logger, dir: string): { ok: true; data: unknown } {
  const report = auditStructure(scanRepo(dir))
  log.info(
    `devkit.audit-structure：${dir}（${report.shape}，${String(report.findings.length)} 条：` +
      Object.entries(tallyKinds(report.findings)).map(([kind, n]) => `${kind} ${String(n)}`).join('、') + '）',
  )
  return {
    ok: true,
    data: { repoDir: dir, shape: report.shape, findings: report.findings, byKind: tallyKinds(report.findings) },
  }
}

function auditReposUnder(log: Logger, root: string): { ok: true; data: unknown } {
  const { repos: repoDirs, retired, testUnits } = collectRepos(root)
  const repos: { repo: string; shape: string; findings: StructureFinding[] }[] = []
  for (const one of repoDirs) {
    const report = auditStructure(scanRepo(one))
    repos.push({ repo: path.basename(one), shape: report.shape, findings: report.findings })
  }
  const findings = repos.flatMap((one) => one.findings.map((finding) => ({ repo: one.repo, ...finding })))
  const shapeTally = repos.reduce<Record<string, number>>((acc, one) => {
    acc[one.shape] = (acc[one.shape] ?? 0) + 1
    return acc
  }, {})
  log.info(
    `devkit.audit-structure：${String(repos.length)} 仓（${Object.entries(shapeTally).map(([s, n]) => `${s} ${String(n)}`).join('、')}；退役 ${String(retired.length)}、测试件 ${String(testUnits.length)} 个不扫）——findings ${String(findings.length)} 条`,
  )
  return {
    ok: true,
    data: {
      root,
      repos: repos.length,
      shape: shapeTally,
      retired,
      testUnits,
      findings,
      byKind: tallyKinds(findings),
    },
  }
}

/** 与 devkit.audit-deps 同一个入口形状：给了 dir 查一个仓，给了或缺省 root 扫全生态 */
function registerAuditStructureCommand(wiring: Wiring): void {
  const { ctx, log, commands } = wiring
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.audit-structure',
        plugin: '@godcreator/gwb-devkit',
        description: '结构体检（只读）：仓形、件包自足、短名派生链、files 白名单、静态红线（cordis 位置 / tsconfig paths / link: 依赖）、gwb.provides 与源码对应',
        usage:
          '{dir?（单仓绝对路径）, root?（容器根，缺省现问 unit-folder.list）}。dir 与 root 都不给就是全生态。只读，回 { shape, findings:[{kind,level,path,detail}], byKind }——level：error（长不成/装不上/必炸/发版会拒）、warn（偏离当前形）、info（提示；裸根单件仓给按实际文件拼好的迁移清单）。kind 为 provides-declaration 的 error：keywords 含 gwb 或 gwb-plugin 的包，源码（src/ 下 super(ctx, 名)、ctx.provide(名)、new X(ctx, 名) 三种写法）提供的服务在 gwb.provides 里没有、gwb.provides 的键既不是源码提供的服务名也不是本包 exports 里的 import 说明符（主入口写包名，子路径写 包名/子路径）、或某条的 summary / usage 不是非空字符串——devkit.release 的发版前检查同样查这一条。**不管的**：依赖钉版与 peer（audit-deps 与发版检票）、产物形状（各仓 artifact 测试）。不挂发版检票——那是门禁，这是日常体检。参数不对会把完整说明回给你',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${STRUCTURE_USAGE}` }
        const dir = typeof args.dir === 'string' && args.dir.trim() !== '' ? path.resolve(args.dir.trim()) : ''
        if (dir !== '') {
          if (!fs.existsSync(dir)) return { ok: false, error: `${dir} 不在——dir 给的是仓根的绝对路径` }
          return auditOneRepo(log, dir)
        }
        const root = await containerRootOf(wiring, typeof args.root === 'string' ? args.root.trim() : '')
        if (root === undefined) {
          return { ok: false, error: '扫哪没说清：给 dir（单仓）或 root（容器根），或在这个 home 装 @godcreator/gwb-unit-folder——它现扫回的 container 就是容器根' }
        }
        if (!fs.existsSync(root)) return { ok: false, error: `${root} 不在——root 给的是容器根（unit.json 们住的那层）` }
        return auditReposUnder(log, root)
      },
    ),
  )
}

// ── 建仓与加插件 ──────────────────────────────────────────────────────────────

/** 包内 `template/` 目录；这一版没把它带进包时是 null */
function templateRootOrNull(requiredSubdir: string): string | null {
  const root = packageRoot()
  const templateRoot = root === null ? null : path.join(root, 'template')
  return templateRoot === null || !fs.existsSync(path.join(templateRoot, requiredSubdir)) ? null : templateRoot
}

function registerScaffoldCommand(wiring: Wiring): void {
  const { ctx, log, commands, hasCommand } = wiring
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.scaffold',
        plugin: '@godcreator/gwb-devkit',
        description: '把一个新 gwb 件的骨架落进一个新文件夹（默认连文档站）',
        usage:
          `{name（必给，kebab-case 短名）, dir（必给，绝对路径且必须还不存在）, title?, docs?（缺省 true）, port?}。插件的模板在本包；建站是两步，都经命令总线交出去——${CREATE_SITE_COMMAND}（站点插件）生成 fumadocs 骨架，${ATTACH_SITE_COMMAND}（docfirst 插件）在骨架上装六区；六区装好之后写插件页起稿（回执 pluginPage）。哪个插件没装就跳过那一步、回执里说怎么补，插件文件照样写到磁盘。参数不对会把完整说明回给你`,
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${SCAFFOLD_USAGE}` }
        const templateRoot = templateRootOrNull('')
        if (templateRoot === null) {
          return { ok: false, error: '包内 template/ 不在——这一版没把它带进包（files 白名单漏了），换一版' }
        }
        // 想不想建站与建不建得成是两件事：站点插件没装时 README 里那段话也得跟着改，所以在渲染之前定下来
        const canDocs = args.docs !== false && hasCommand(CREATE_SITE_COMMAND)
        const kernelVersion = requireKernel(ctx).version
        let plan
        try {
          plan = planScaffold({
            name: typeof args.name === 'string' ? args.name : '',
            dir: typeof args.dir === 'string' ? args.dir : '',
            ...(typeof args.title === 'string' && args.title.trim() !== '' ? { title: args.title } : {}),
            docs: canDocs,
            ...(typeof args.port === 'number' ? { port: args.port } : {}),
            kernelVersion,
          })
        } catch (err) {
          return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${SCAFFOLD_USAGE}` }
        }
        let files
        let page
        try {
          files = renderTemplate(templateRoot, plan)
          page = renderPluginPage(templateRoot, plan)
          writeRepo(plan.dir, files)
        } catch (err) {
          return { ok: false, error: `建仓没成：${err instanceof Error ? err.message : String(err)}` }
        }
        log.info(`devkit.scaffold：${plan.pkg} → ${path.join(plan.dir, 'plugins', plan.name)}（${files.length} 个文件）`)

        // 插件文件已经在磁盘上，站没建成不算建仓失败，回执里说清楚
        const docs = await buildDocsSite(wiring, plan)
        // 插件页只能在六区装好之后写：attach 只在没加过页的骨架上装得了
        const pluginPage = pluginPageTarget(plan.dir, plan.name)
        if (pluginPage !== null) writePluginPage(pluginPage, page)
        return {
          ok: true,
          data: {
            repoDir: plan.dir,
            pluginDir: path.join(plan.dir, 'plugins', plan.name),
            pkg: plan.pkg,
            name: plan.name,
            title: plan.title,
            files: files.length,
            docs,
            pluginPage,
            nextSteps: nextSteps(plan, {
              built: docs.built,
              attached: docs.attached,
              ...(docs.port === undefined ? {} : { port: docs.port }),
            }),
          },
        }
      },
    ),
  )
}

function registerScaffoldPluginCommand({ ctx, log, commands }: Wiring): void {
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.scaffold.plugin',
        plugin: '@godcreator/gwb-devkit',
        description: '往已有的 workspace 仓的 plugins/ 再加一个插件包（同一份插件包模板；仓里有装好六区的文档站时顺带写插件页起稿）',
        usage:
          '{name 必给（kebab-case 短名，派生规则同 devkit.scaffold）, repo 必给（薄壳仓根绝对路径——pnpm-workspace.yaml 里得有 plugins/ 那条，老裸根单件仓报错里带迁移的路）, title?}。件包落在 <repo>/plugins/<短名>/，必须还不存在。与建仓落的是同一份件包模板（template/pkg/）——单多格式统一靠这个。参数不对会把完整说明回给你',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${SCAFFOLD_PLUGIN_USAGE}` }
        const templateRoot = templateRootOrNull('pkg')
        if (templateRoot === null) {
          return { ok: false, error: '包内 template/pkg/ 不在——这一版没把它带进包（files 白名单漏了），换一版' }
        }
        const kernelVersion = requireKernel(ctx).version
        let plan
        try {
          plan = planScaffoldPlugin({
            name: typeof args.name === 'string' ? args.name : '',
            repo: typeof args.repo === 'string' ? args.repo : '',
            ...(typeof args.title === 'string' && args.title.trim() !== '' ? { title: args.title } : {}),
            kernelVersion,
          })
        } catch (err) {
          return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${SCAFFOLD_PLUGIN_USAGE}` }
        }
        // 插件页也要还不存在，在写任何文件之前查
        const pluginPage = pluginPageTarget(plan.repoDir, plan.name)
        if (pluginPage !== null && fs.existsSync(pluginPage)) {
          return { ok: false, error: `加件没成：插件页已经存在，不覆盖：${pluginPage}` }
        }
        let files
        try {
          files = renderPlugin(templateRoot, plan)
          const page = renderPluginPage(templateRoot, plan)
          writeRepo(plan.dir, files)
          if (pluginPage !== null) writePluginPage(pluginPage, page)
        } catch (err) {
          return { ok: false, error: `加件没成：${err instanceof Error ? err.message : String(err)}` }
        }
        log.info(`devkit.scaffold.plugin：${plan.pkg} → ${plan.dir}（${files.length} 个文件）`)
        return {
          ok: true,
          data: {
            repoDir: plan.repoDir,
            pluginDir: plan.dir,
            pkg: plan.pkg,
            name: plan.name,
            title: plan.title,
            files: files.length,
            pluginPage,
            nextSteps: nextStepsPlugin(plan, pluginPage),
          },
        }
      },
    ),
  )
}

/** 建站那部分的回执 */
interface DocsOutcome {
  /** 骨架生成了没有（`docs-site.create` 成没成） */
  built: boolean
  /** 六区装了没有（`docfirst.attach` 成没成）。骨架都没生成时一定是 false */
  attached: boolean
  /** 站端口。站点插件选的，生成成功才有 */
  port?: number
  note: string
  /** 两条命令各自的原始回执，出错时看这里 */
  create?: unknown
  attach?: unknown
}

/**
 * 两步都按名字经命令总线交给别的插件：站点插件生成骨架，docfirst 插件在刚生成的骨架上装六区。
 * 哪一步的插件没装就停在那里、说清怎么补；两条命令都认站目录（`<仓>/docs-site`），不是仓根
 */
async function buildDocsSite(
  { log, commands, hasCommand }: Wiring,
  plan: {
    dir: string
    title: string
    docs: boolean
    port: number | undefined
  },
): Promise<DocsOutcome> {
  const siteDir = path.join(plan.dir, 'docs-site')
  const attachHint = `${ATTACH_SITE_COMMAND} {"dir":"${siteDir}"}`
  if (!plan.docs) {
    return {
      built: false,
      attached: false,
      note: hasCommand(CREATE_SITE_COMMAND)
        ? '没建站：调用时给了 docs: false'
        : `没建站：这个 home 没装站件（命令总线上没有 ${CREATE_SITE_COMMAND}）。件那半已经落盘了——装上 @godcreator/gwb-docs-site（plugin-manager.install）之后自己补两步：${CREATE_SITE_COMMAND} {"dir":"${siteDir}","title":"${plan.title}"} 铺骨架，再 ${attachHint} 装六区`,
    }
  }
  const created = await commands.run(CREATE_SITE_COMMAND, {
    dir: siteDir,
    title: plan.title,
    ...(plan.port === undefined ? {} : { port: plan.port }),
  })
  if (!created.ok) {
    log.warn(`devkit.scaffold 的站那半没成：${created.error ?? '没说原因'}`)
    return {
      built: false,
      attached: false,
      note: `骨架没铺成（${CREATE_SITE_COMMAND}：${created.error ?? '没说原因'}）。件那半已经落盘、README 里讲站的那段话是按「要建」写的——补建一次，或者把那段改掉`,
      create: created,
    }
  }
  const rawPort = isRecord(created.data) ? created.data.port : undefined
  const port = typeof rawPort === 'number' && Number.isInteger(rawPort) ? rawPort : undefined
  log.info(`devkit.scaffold：fumadocs 骨架铺好了 → ${siteDir}`)

  // 这时正是刚生成骨架、中间没人改过文件的时刻，attach 装得了
  if (!hasCommand(ATTACH_SITE_COMMAND)) {
    return {
      built: true,
      attached: false,
      ...(port === undefined ? {} : { port }),
      note: `骨架铺好了，六区没装：这个 home 没装 docfirst 件（命令总线上没有 ${ATTACH_SITE_COMMAND}）。装上 @godcreator/gwb-docfirst-workflow 之后**立刻**跑 ${attachHint}——它只在还没写过内容的骨架上装得了，往里写过东西就得人工接线`,
      create: created,
    }
  }
  const attached = await commands.run(ATTACH_SITE_COMMAND, { dir: siteDir, title: plan.title })
  if (!attached.ok) {
    log.warn(`devkit.scaffold 的装配那步没成：${attached.error ?? '没说原因'}`)
    return {
      built: true,
      attached: false,
      ...(port === undefined ? {} : { port }),
      note: `骨架铺好了，六区没装成（${ATTACH_SITE_COMMAND}：${attached.error ?? '没说原因'}）。站是个光骨架，pnpm doc 那几条还不在——补一次 ${attachHint}`,
      create: created,
      attach: attached,
    }
  }
  log.info(`devkit.scaffold：六区装配好了 → ${siteDir}`)
  return {
    built: true,
    attached: true,
    ...(port === undefined ? {} : { port }),
    note: '站建好了（骨架 + 六区，两步）。依赖没装——去 docs-site 里 pnpm install',
    create: created,
    attach: attached,
  }
}

// ── 说明书与就绪日志 ──────────────────────────────────────────────────────────

/**
 * 只登记自己那份说明书：说明书是全局唯一的命名空间，替别人登记会撞名，撞掉的常常是新的那份。
 * 局部注入：说明书插件不在时开发套件照常加载
 */
function registerOwnSkills(ctx: GwbContext): void {
  ctx.inject(['gwbSkills'], (scoped) => {
    scoped.effect(() => scoped.gwbSkills.register(new URL('../skills/', import.meta.url)))
  })
}

/** 就绪日志现问命令总线，不抄一份名单：devkit.cdp 经 gwbNodeCli 登记，它在不在取决于那个插件有没有先加载 */
function logReady({ log, commands }: Wiring): void {
  const ownCommandNames = commands
    .list()
    .filter((entry) => entry.plugin === '@godcreator/gwb-devkit')
    .map((entry) => entry.name)
  log.info(
    `开发套件就绪（此刻在总线上的 ${String(ownCommandNames.length)} 条：${ownCommandNames.join('、')}；手册挂在本件 skills/ 下，只挂自己那份）`,
  )
}
