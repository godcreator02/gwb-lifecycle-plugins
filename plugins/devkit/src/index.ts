import fs from 'node:fs'
import path from 'node:path'
import type { GwbContext } from '@godcreator/gwb-kernel-desktop'
import { isRecord, requireKernel, TEAM_REGISTRY, TEAM_SCOPE } from './vocab.js'
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
import { kill, portOwner, processName, processTable } from './node-probe-deps.js'
import { type DevDeps, type DevInput, runDev } from './dev.js'
import { runRelease } from './release.js'
import { servicesOf } from './services.js'
import { readHomeTypeDeclarations } from './node-services-deps.js'
import { CDP_ENTRY, devDepsWith, releaseDepsWith } from './node-dev-deps.js'
import { locatePnpm } from '@godcreator/gwb-plugin-manager'
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
  SCOPE_RE,
  writePluginPage,
  writeRepo,
} from './scaffold.js'
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
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。它派生出包名 <scope>/gwb-<短名>、插件名 gwb-<短名>、命令名 <短名>.<动作> 的前半`,
  '  dir    必给，目标目录的绝对路径，必须还不存在（存在就拒，不覆盖任何东西）。生成的仓只有一种布局：workspace——仓根是不发布的 private 包，插件包在 plugins/<短名>/',
  '  title  可选，显示名，缺省用 name',
  `  scope  可选，包名范围（${String(SCOPE_RE)}），缺省 ${TEAM_SCOPE}。没有团队源发布权限的开发者给自己的范围`,
  `  registry 可选，插件包 package.json 的 publishConfig.registry，devkit.release 发到这里。要是 http(s) 地址的规范写法（new URL(x).href 与原文相同，如 "http://localhost:4873/"），不带账号、查询串与 #；缺省是团队源 ${TEAM_REGISTRY}。发布 token 写在用户级 ~/.npmrc`,
  `  docs   可选，缺省 true——插件文件写到磁盘之后顺带建站，两步：${CREATE_SITE_COMMAND} 生成 fumadocs 骨架、${ATTACH_SITE_COMMAND} 在骨架上装六区；六区装好之后再写插件页的初稿 docs-site/content/docs/plugins/<短名>.mdx。两条都经命令总线找，没装那个插件就跳过那一步（回执里说怎么补），不算建仓失败。false 就只生成插件文件`,
  '  port   可选，文档站端口。不给由站点插件自己选（跳过别的站已占用的端口，从 4310 起找没人用的）',
  '例：{"name":"hello","dir":"D:\\\\tmp\\\\hello","title":"打个招呼"}',
].join('\n')

const SCAFFOLD_PLUGIN_USAGE = [
  'devkit.scaffold.plugin 的参数：',
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。派生规则同 devkit.scaffold`,
  '  repo   必给，workspace 仓根的绝对路径（pnpm-workspace.yaml 所在的目录）。yaml 里得有 plugins/ 那条——旧布局的仓（仓根就是插件包）先迁成 workspace 布局，报错里写着怎么迁',
  '  title  可选，显示名，缺省用 name',
  '  scope、registry  可选，规则与缺省值同 devkit.scaffold。同一个仓里的插件一般用同一套：看仓里已有插件包 package.json 的 name 与 publishConfig.registry',
  '插件包写到 <repo>/plugins/<短名>/，必须还不存在（存在就拒，不覆盖任何东西）。仓根与 workspace 配置不碰；仓里有装好六区的文档站（docs-site/docfirst.config.mjs 在）时，再写插件页的初稿 docs-site/content/docs/plugins/<短名>.mdx（已存在就拒）。README 的插件清单由人更新（回执 nextSteps 里提醒）',
  '例：{"repo":"D:\\\\tmp\\\\hello","name":"world","title":"第二个插件"}',
].join('\n')

const HOME_USAGE = [
  'home 命令的参数：',
  '  devkit.home.new  { short 必给（kebab-case 短名） }——开 <short>-<yyMMddHHmm> 的新 home。启动之前装好内核包（运行中的内核的精确版本）、cordis（内核包要的精确版本）与七个基础插件，再用宿主安装版启动，调试端口自动选',
  '  devkit.home.open { name 必给（完整 home 名） }——重开一个已有的 home，不 build。机器重启之后回到现场走这条',
  '  devkit.home.rm   { name，force? }——删一个 home。没在运行的直接删；还在运行的要 force（连停带删，等进程真退再删）；目录真不在了才回已删',
  '                     default 是日常用的 home：不 force 不删，而且它在运行时 force 也不删——自己关掉它的窗口再来',
  '  devkit.home.list 无参数——列出 home 根目录下全部 home 与哪些在运行',
  '例：{"short":"data"}、{"name":"data-2609081430"}',
  '**这几条都不收调试端口**：端口是启动时自动选的（先沿用这个 home 上次用的，被占了才另选），',
  '之后从它的 runtime.json 里查。端口没有含义，敲错一位就连到另一个 home。',
].join('\n')

const DEV_USAGE = [
  'devkit.dev 的参数：',
  '  home      必给，目标 home 名。**这里不收端口**：端口从那个 home 的 runtime.json 里查，同时确认它还在运行',
  '            （记录读得出、pid 还在、那个 pid 真的在监听那个端口），再拿页面自报的名字核对一次',
  '  dir       必给，仓根的绝对路径。构建在这里运行',
  '  packages  可选，要装的包目录，相对仓根。只收插件（keywords 含 gwb-plugin）与内核包，库打包进用它的插件、不单独装。不给就是仓根自己',
  '  waitFor   可选，刷新之后等页面上这个选择器出现才算刷回来了',
  '开发版不进源：每个包打成 <目标 home>\\dev-packs\\<包文件名>（版本号 <patch+1>-dev.<到秒的时间>，每版一个新文件，旧的不删），再在目标页面里调目标 home 的插件管理装：已在它 dependencies 里的合成一条 plugin-manager.update {"specs":{…}}，不在的插件逐个 plugin-manager.install',
  '**装内核包**（packages 里有 @godcreator/gwb-kernel-desktop 的包目录）：它 peer 里的 cordis 必须是精确版本号，和内核包放进同一条 update；',
  '内核包必须已在目标 home 里。update 回执 restartRequired 时不刷新，改成停掉目标 home 再启动，轮询 shell.env 直到页面报出的内核版本就是这次打包的版本号',
  '**构建不可跳过**：产物不是最新的就打包，装进去的是上一版，而回执一切正常',
  '例：{"home":"bn-2609111200","dir":"D:\\\\unitfolders\\\\evew5-gwbapps\\\\gwb-block-note","packages":["plugins/gwb-bn-core","plugins/gwb-bn-comment"]}',
  '目标 home 是 default、或者就是开发套件自己所在的 home，都直接拒——前者会把开发版装进日常用的 home，',
  '后者重新加载条目时会把正在运行的这条命令自己停掉。要换开发套件自己：发正式版，再 plugin-manager.update {"all":true}',
].join('\n')

const RELEASE_USAGE = [
  'devkit.release 的参数：',
  '  dir       必给，仓根的绝对路径。git 工作区检查与构建都在这里运行',
  '  packages  可选，要发的包目录，相对仓根，**按依赖顺序**（被依赖的排前面）。不给就是仓根自己',
  '**版本号在仓里升**：发的是 package.json 里写的版本号，同一个版本号已在源上就拒——要发新的一版，先升版本号、提交，再调用',
  '**仓根 git 工作区不干净就拒**：正式版只从提交过的状态发',
  `**发到包自己的 publishConfig.registry**：没写这个字段的包发到团队源 ${TEAM_REGISTRY}；写了但不是 http(s) 地址就拒。「同号已在源上」问的也是这个源`,
  `**发版前检查没过就拒**（构建之后，所有包一次列全）：${TEAM_SCOPE} 范围下的 dev 范围包含源上 dist-tags.latest；产物里没有空 import（import { type X } 留下的）`,
  '**插件包另加**（keywords 含 gwb-plugin）：peer 里只许 cordis、内核包 @godcreator/gwb-kernel-desktop 与别的插件（包目录 node_modules 里它的清单 keywords 含 gwb-plugin，或是 cordis 官方插件），peer 里每个 gwb 插件（不分范围）和源上 dist-tags.latest 在同一条线（0.x 只看 x，≥1 只看主版本号；问哪个源由 ~/.npmrc 的范围行决定）；node 侧产物（exports["."] 入口顺着相对 import 走到的文件）的包名 import 只有 node 内置模块、electron 与 peer 里写了的包；浏览器侧产物（dist/client.js）只 import 页面 importmap 里的名字——内核包清单 gwb.shared 的键（react 的四个），从包目录 node_modules 里装好的内核包读；peer 里写了内核包、写法是 ^x.y.z、范围包含运行中的内核（主版本号为 0 时次版本号相同，≥1 时主版本号相同，并且不低于下限）',
  '**这条命令只发到源、不碰任何 home**，从哪个 home 调用都行；升级 default 是下一步的事，用 plugin-manager.update {"all":true}',
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
      processTable,
      portOwner,
      kill,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      execPath: process.execPath,
      env: process.env,
    },
  }

  registerHomeCommands(wiring)
  describeSelfToShell(ctx)
  registerCdpCli(ctx)
  registerDevCommand(wiring)
  registerReleaseCommand(wiring)
  registerServicesCommand(wiring)
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
        description: '重开一个已有的测试 home（用宿主安装版启动）',
        usage: '{name 必给}——调试端口自动选。机器重启之后要回到原来那个 home 只有这一条路（home.new 每次都建新目录，插件得全部重装一遍）',
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
          '{name，force?}——没在运行的直接删；**还在运行的要 force**，那时连停带删（按它 runtime.json 里的 pid，核对映像名与记录里那个 CDP 端口再杀，按 pid 等进程真退了才删）。**回「已删」只在目录真不在了之后**，没删掉回 ok:false 并列出还剩什么。default 是日常用的 home：不 force 不删，而且它在运行时 force 也不删，自己关掉它的窗口再来',
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
      { name: 'devkit.home.list', plugin: '@godcreator/gwb-devkit', description: '列出全部测试 home 与各自的端口', usage: '无参数。每个 home 报名字（带时间戳）、是否在运行、调试端口、MCP 入口的端口与地址（runtime.json 的 mcp 字段）' },
      async () => {
        const root = homesRootOf()
        return { ok: true, data: { root, homes: await listHomes(root, homeDeps) } }
      },
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
      description: '经 CDP 操作一个工作台页面（default 上只许截图与问 home，写动作在隔离 home 上做）',
      usage:
        '{"args":["<home 名>","<动作>","<参数…>"]}。**第一个位置只收 home 名，给数字直接拒**——端口从那个 home 的 runtime.json 里查，连上之后还拿页面自报的名字核对一次。动作 eval <文件绝对路径> [JSON 参数] / shot [图.png 绝对路径] [选择器] / move / click / rclick / drag / type / key / scroll <点> / cmd <命令名> [JSON 参数] / reload [选择器] [秒] / home。点写成 .sel、.sel@=文字、.a@=文字 >> .b，或 x,y。开关 --target / --mod / --pad / --size / --timeout。**路径不看工作目录**：截图缺省存到被截的那个 home 自己的 out\\cdp\\，要存到别处给绝对路径；eval 的文件只收绝对路径，相对的直接拒；写入位置在本包目录或任何 node_modules 里也拒。**页面自报 default 时只许只读动作 shot / home**，别的动作与 --size 在动手之前就拒：这儿发的是真操作，写动作在隔离 home 上做。连不上的 home 是启动时没带 --remote-debugging-port，停掉重开一次',
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
        description: '改一版看一版（构建→打包进目标 home→经目标 home 的插件管理装并重新加载→刷新→取证；装内核包时改成重启目标 home）',
        usage:
          '{home 必给（目标 home 名，**只认名字不认端口**——端口从它的 runtime.json 里查，并确认它还在运行）, dir 必给（仓根绝对路径）, packages?（包目录，相对仓根；只收插件与内核包，库直接拒；不给就是仓根自己）, waitFor?（刷新后等这个选择器出现）}。一条走完：仓根 pnpm build → 照 files 验产物 → 在临时目录组装发布内容、版本号改成 <patch+1>-dev.<yyyyMMddHHmmss>，pnpm pack 到 <目标 home>\\dev-packs\\（包文件每版一个新路径，已存在就拒；旧的不删：home 清单引用着的包文件删了，这个 home 之后的 pnpm add 全失败；开发版不进源）→ 读目标 home 的 package.json（只读）：已在 dependencies 里的包合成一条 plugin-manager.update {"specs":{"<包>":"file:./dev-packs/<包文件>"}}，不在的插件逐个 plugin-manager.install {pkg, spec}（新建一条条目），都经 CDP 在目标页面里调；插件管理装包、重新加载这些包与真实目录变了的别的包，插件管理自己的条目推迟到回执之后（回执 selfDeferred，这边轮询 plugin-manager.list 等它 active）→ 整页刷新（驱动退出码非零或没等到页面回来就回 ok:false，说清等的是什么、最后看到了什么）→ 取证（装上的是这次打包的版本号、条目真的 ACTIVE、日志新增的部分里没有 error），取不到证就回 ok:false。回执 { home, homeName, shipped: [{ pkg, version, dir, packFile, via: update|install, entryId? }], update?（plugin-manager.update 的回执原样）, reload? | kernel?, evidence }。**packages 里有内核包 @godcreator/gwb-kernel-desktop 时**：它 peer 里的 cordis（必须是精确版本号）和内核包放进同一条 update；内核包不在目标 home 里直接拒；update 回执 restartRequired，这边不刷新，改成停掉目标 home 再启动（主进程里的内核换不掉），轮询 shell.env 直到 versions.kernel 就是这次打包的版本号，回执多一个字段 kernel { version, restart }，再照常取证。**构建不可跳过**：跳过构建就是装上一版。**目标是 default 或开发套件自己所在的 home 都直接拒；页面自报的名字跟你给的对不上也拒**',
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
        description: '发正式版到包的 publishConfig.registry，没写就是团队源（git 工作区干净→构建→验产物→发版前检查→在临时目录里组装并发布）',
        usage:
          '{dir 必给（仓根绝对路径）, packages?（包目录，相对仓根，按依赖顺序；不给就是仓根自己）}。一条走完：仓根 git 工作区干净（有未提交改动就拒，一个都不发）→ 仓根 pnpm build → 照 files 白名单验产物 → 同号已在发布目标上就拒（发布目标是包自己 package.json 的 publishConfig.registry，没写就是团队源；写了但不是 http(s) 地址就拒）→ 发版前检查（每个要发的包：@godcreator 范围下的 dev 范围包含源上 dist-tags.latest，workspace: 跳过，范围内落后放行；产物里没有空 import、相对 import 指向的文件都在。keywords 含 gwb-plugin 的插件包另加：peer 里只许 cordis、内核包 @godcreator/gwb-kernel-desktop 与别的插件（包目录 node_modules 里它的清单 keywords 含 gwb-plugin，或是 cordis 官方插件），peer 里每个 gwb 插件（不分范围）和源上 dist-tags.latest 在同一条线（0.x 只看 x，≥1 只看主版本号；问哪个源由 ~/.npmrc 的范围行决定）；node 侧产物——exports["."] 的运行时入口（没有 exports 时是 main）顺着相对 import 走到的文件——的包名 import 只有 node 内置模块、electron 与 peer 里写了的包；浏览器侧产物——dist/client.js，同样顺着相对 import 走——只 import 页面 importmap 里的名字，也就是内核包清单 gwb.shared 的键，从包目录 node_modules 里装好的内核包现读；peer 里写了内核包、写法是 ^x.y.z、范围包含运行中的内核 gwbKernel.version——主版本号为 0 时次版本号相同，≥1 时主版本号相同，并且不低于下限，预发布段不看。没过就一个都不发，回执按包一次列全）→ 在临时目录里组装发布内容并发到发布目标（不改仓里任何文件；tag latest；发布内容清单的 publishConfig.registry 写发布目标，命令行不带 --registry；workspace: 依赖写成 ^<工作区里那个号>，这一次同发的写成 ^新号）→ 按给定顺序发完。**版本号在仓里升**（改 package.json 并提交），同一个版本号永不重发。只发到源、不碰任何 home；升级 default 用 plugin-manager.update {"all":true}',
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

/** 读的是这个 home 的磁盘：装着的包就算，不管条目启没启用 */
function registerServicesCommand({ ctx, commands }: Wiring): void {
  ctx.effect(() =>
    commands.register(
      {
        name: 'devkit.services',
        plugin: '@godcreator/gwb-devkit',
        description: '这个 home 里有哪些可以 inject 的服务：谁提供、类型定义原文（方法签名与注释），从各包的 .d.ts 里现读',
        usage:
          '无参数。扫这个 home 顶层 node_modules 里每个包的全部 .d.ts，找 declare module \'cordis\' { interface Context { 服务名: 类型 } }。类型定义在自己声明里的包是提供方，类型从别处 import 来的只是在用。回执 { ok, data: { home, services: [{ service, providers: [<包名>@<版本>], type, optional, definition?, declaredAlsoBy: [<包名>@<版本>] }] } }，按服务名排序；definition 是第一个提供方里那个类型的定义原文连同文档注释，没有提供方时不带。providers 正常只有一个，多于一个说明有包带着重复或过期的声明。要用某个服务：在 peer 里写上提供方，import type 它的类型，ctx.inject 取用',
      },
      () => {
        const home = requireKernel(ctx).dataDir
        return { ok: true, data: { home, services: servicesOf(readHomeTypeDeclarations(home)) } }
      },
    ),
  )
}

// ── 建仓与加插件 ──────────────────────────────────────────────────────────────

/** `scope`、`registry` 两个可选参数：给了但不是字符串就抛（格式由 `planScaffold` / `planScaffoldPlugin` 校验） */
function publishIdentityArgsOf(args: Record<string, unknown>): { scope?: string; registry?: string } {
  const picked: { scope?: string; registry?: string } = {}
  for (const key of ['scope', 'registry'] as const) {
    const value = args[key]
    if (value === undefined) continue
    if (typeof value !== 'string') throw new Error(`${key} 要是字符串，实得 ${JSON.stringify(value)}`)
    picked[key] = value
  }
  return picked
}

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
        description: '在一个新目录里生成一个 gwb 插件仓（默认连文档站一起建）',
        usage:
          `{name（必给，kebab-case 短名）, dir（必给，绝对路径且必须还不存在）, title?, docs?（缺省 true）, port?, scope?（包名范围，缺省 ${TEAM_SCOPE}）, registry?（写进插件包 publishConfig.registry 的发布目标，缺省团队源）}。插件的模板在本包；建站是两步，都经命令总线交出去——${CREATE_SITE_COMMAND}（站点插件）生成 fumadocs 骨架，${ATTACH_SITE_COMMAND}（docfirst 插件）在骨架上装六区；六区装好之后写插件页的初稿（回执 pluginPage）。哪个插件没装就跳过那一步、回执里说怎么补，插件文件照样写到磁盘。参数不对会把完整说明回给你`,
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
            ...publishIdentityArgsOf(args),
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
            registry: plan.registry,
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
        description: '往已有的 workspace 仓的 plugins/ 再加一个插件包（同一份插件包模板；仓里有装好六区的文档站时顺带写插件页的初稿）',
        usage:
          '{name 必给（kebab-case 短名，派生规则同 devkit.scaffold）, repo 必给（workspace 仓根的绝对路径——pnpm-workspace.yaml 里得有 plugins/ 那条，旧布局的仓报错里写着怎么迁）, title?, scope?, registry?（规则与缺省值同 devkit.scaffold）}。插件包写到 <repo>/plugins/<短名>/，必须还不存在。与建仓用的是同一份插件包模板（template/pkg/）——只有一个插件和有多个插件的仓格式一致靠这个。参数不对会把完整说明回给你',
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
            ...publishIdentityArgsOf(args),
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
            registry: plan.registry,
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
