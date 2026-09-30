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
import { kill, portOwner, processTable } from './node-probe-deps.js'
import { type DevDeps, type DevInput, runDev } from './dev.js'
import { runRelease } from './release.js'
import { CDP_ENTRY, devDepsWith, releaseDepsWith } from './node-dev-deps.js'
import { locatePnpm } from '@godcreator/gwb-plugin-manager'
import { homeFs, makeAppSpawnPlan, makeGuiSpawn, runCaptured } from './node-home-deps.js'
import {
  homePeerVersions,
  NAME_RE,
  nextSteps,
  nextStepsPlugin,
  packageRoot,
  planScaffold,
  planScaffoldPlugin,
  type PeerVersions,
  renderPlugin,
  renderTemplate,
  SCOPE_RE,
  writeRepo,
} from './scaffold.js'
import { addTemplateComponents, componentsStepFailure, TEMPLATE_COMPONENTS } from './shadcn-components.js'
import { pnpmForComponents } from './node-shadcn-deps.js'
import { homesRootOf } from '../bin/cdp.mjs'

export const name = 'gwb-devkit'
export const inject = ['gwbCommands']


// 下面几段参数说明在参数不对时连同报错一起回

/** 建仓与加插件共用：模板 peer 里的版本号从哪来，外壳没装时为什么会失败 */
const SCAFFOLD_PEER_VERSIONS_NOTE =
  '模板插件 peer 里的内核包取正在运行的内核版本，命令总线与外壳读运行这条命令的 home 里 node_modules/@godcreator/gwb-commands 与 node_modules/@godcreator/gwb-shell 的 package.json 取版本号。' +
  '外壳在开发套件的 peer 里是可选的，home 里没装外壳（或命令总线）时这条命令报错、什么都不写：先在这个 home 里装上外壳'

/** 建仓与加插件共用：写完文件后添加模板窗格用的 shadcn 组件 */
const SCAFFOLD_COMPONENTS_NOTE =
  `写完插件文件后在插件包目录运行 pnpm dlx shadcn@latest add ${TEMPLATE_COMPONENTS.join(' ')} --yes（shadcn 官方 CLI，要联网；它装组件依赖时整个 workspace 装一遍，仓根的 pnpm-lock.yaml 与 node_modules 跟着变），` +
  '再用一次 pnpm add -D 把 CLI 写进 dependencies 的包、组件 import 了却没装的包放进 devDependencies。找不到 pnpm 时什么都不写；这一步没成时插件文件已写好、不回滚，回执 ok:false 并写明怎么补完'

const SCAFFOLD_USAGE = [
  'devkit.scaffold 的参数：',
  // 规则从 NAME_RE 取，不在这里抄一份
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。它派生出包名 <scope>/gwb-<短名>、插件名 gwb-<短名>、命令名 <短名>.<动作> 的前半`,
  '  dir    必给，目标目录的绝对路径，必须还不存在（存在就拒，不覆盖任何东西）。生成的仓只有一种布局：workspace——仓根是不发布的 private 包，插件包在 plugins/<短名>/',
  `  scope  可选，包名范围（${String(SCOPE_RE)}），缺省 ${TEAM_SCOPE}。没有团队源发布权限的开发者给自己的范围`,
  `  registry 可选，插件包 package.json 的 publishConfig.registry，devkit.release 发到这里。要是 http(s) 地址的规范写法（new URL(x).href 与原文相同，如 "http://localhost:4873/"），不带账号、查询串与 #；缺省是团队源 ${TEAM_REGISTRY}。发布 token 写在用户级 ~/.npmrc`,
  '模板里要显示名的地方（README 标题、description、窗格标题）都用短名，要改自己改生成的文件。不建文档站',
  SCAFFOLD_PEER_VERSIONS_NOTE,
  SCAFFOLD_COMPONENTS_NOTE,
  '例：{"name":"hello","dir":"D:\\\\tmp\\\\hello"}',
].join('\n')

const SCAFFOLD_PLUGIN_USAGE = [
  'devkit.scaffold.plugin 的参数：',
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。派生规则同 devkit.scaffold`,
  '  repo   必给，workspace 仓根的绝对路径（pnpm-workspace.yaml 所在的目录）。yaml 里得有 plugins/ 那条，没有就拒',
  '  scope、registry  可选，规则与缺省值同 devkit.scaffold。同一个仓里的插件一般用同一套：看仓里已有插件包 package.json 的 name 与 publishConfig.registry',
  '插件包写到 <repo>/plugins/<短名>/，必须还不存在（存在就拒，不覆盖任何东西）。仓根的 package.json、workspace 配置与文档站都不碰。README 的插件清单由人更新（回执 nextSteps 里提醒）',
  SCAFFOLD_COMPONENTS_NOTE,
  '例：{"repo":"D:\\\\tmp\\\\hello","name":"world"}',
].join('\n')

const HOME_USAGE = [
  'home 命令的参数：',
  '  devkit.home.new  { short 必给（kebab-case 短名） }——开 <short>-<yyMMddHHmm> 的新 home。启动之前装好内核包（运行中的内核的精确版本）、cordis（内核包要的精确版本）与基础插件（命令、外壳、数据、设置、说明书、插件管理、基础界面，加上提供 timer 服务的 @cordisjs/plugin-timer），再用宿主安装版启动，调试端口自动选',
  '  devkit.home.open { name 必给（完整 home 名） }——重开一个已有的 home，不 build。机器重启之后回到现场走这条',
  '  devkit.home.rm   { name，force? }——删一个 home。没在运行的直接删；还在运行的要 force（先停止进程，等它真正退出后再删除）；目录真不在了才回已删',
  '                     default 是日常用的 home：不 force 不删，而且它在运行时 force 也不删——先自己关掉它的窗口',
  '  devkit.home.list 无参数——列出 home 根目录下全部 home 与哪些在运行',
  '例：{"short":"data"}、{"name":"data-2609081430"}',
  '**这几条都不收调试端口**：端口是启动时自动选的（先沿用这个 home 上次用的，被占了才另选），',
  '之后从它的 runtime.json 里查。端口没有含义，敲错一位就连到另一个 home。',
].join('\n')

/** 样式检查查什么：devkit.dev 与 devkit.release 的 usage 共用这一句 */
const STYLE_CHECK_SUMMARY =
  'src/ 下恰好一个写了 prefix(<前缀>) 的样式入口；dist/style.css 的类选择器都是 .<前缀>\\: 开头（.dark 放行；@scope 块里的不查，但每个 @scope 的根选择器列表每一项都要有 .<前缀>\\: 开头的类，界限 to (…) 不要求）、没有 data-gwb-plugin、var() 的 fallback 里没有写死的值、' +
  '颜色只用主题令牌（规则的声明里引用的 var(--<前缀>-color-<名>) 只能是外壳 theme.reference.css 与本插件样式入口声明的 --color-<名>，出厂调色板就是这样被认出来的）；样式入口所在目录下 .tsx 字符串里的类名：前缀排在最前、带前缀的编得出规则（dist/style.css 里当 @scope 根或界限用的类除外）、' +
  '不带前缀却编得出规则的报「漏了前缀」。编译用包自己 dev 里 @tailwindcss/cli 旁边的 @tailwindcss/node，找不到就报'

/** 插件包的 peer 成不成环查什么：devkit.release 的两份 usage 共用这一句 */
const PEER_CYCLE_CHECK_SUMMARY =
  'peer 不成环——从本包出发，顺着 peer 里的 gwb 插件（keywords 含 gwb-plugin）的已装清单往下走（包 peer 里的包照 node 的解析规则从它的真实目录往上找；同一次发的包按工作区里的清单），走回本包就拒，理由里列出环（A → B → A）：' +
  '去掉环上的一条 peer，反方向改用局部注入 <上下文>.inject([...], fn)、不写 peer（提供方是同一个工作区里 peer 写了本包的插件时，下面的注入检查放行）；'

/** 插件包的注入与 peer 一致查什么：devkit.release 的两份 usage 共用这一句 */
const WIRING_CHECK_SUMMARY =
  '注入与 peer 一致——扫 src/ 下源码（.d.ts 除外）里的 export const inject = [...]、static inject = [...]（必需）与 <上下文>.inject([...], fn)（局部注入），数组里只认字符串字面量，像注入又读不出服务名的写法直接拒；' +
  '服务由谁提供看 peer 与 dev 里插件的类型入口（exports["."] 的 types）给 cordis Context 补的名字，几个都补了就只认运行时代码里 super(<上下文>, \'<名>\') 或 .provide(\'<名>\') 提供它的那个；' +
  '必需注入的提供方写在 peer 且不标 optional，局部注入的提供方写在 peer（标不标 optional 都行）；gwbKernel、本包自己提供的、提供方不是 gwb 插件的不查；局部注入的提供方是同工作区里 peer 写了本包的插件（写 peer 会成环）时放行'

const DEV_USAGE = [
  'devkit.dev 的参数：',
  '  home      必给，目标 home 名。**这里不收端口**：端口从那个 home 的 runtime.json 里查，同时确认它还在运行',
  '            （记录读得出、pid 还在、那个 pid 真的在监听那个端口），再拿页面自报的名字核对一次',
  '  dir       必给，仓根的绝对路径。构建在这里运行',
  '  packages  必给，要装的包目录（非空数组），相对仓根。只收插件（keywords 含 gwb-plugin）与内核包，库打包进用它的插件、不单独装',
  '  waitFor   可选，刷新之后等页面上这个选择器出现才算刷回来了',
  '开发版不进源：每个包打成 <目标 home>\\dev-packs\\<包文件名>（版本号 <patch+1>-dev.<到秒的时间>，每版一个新文件，旧的不删），再在目标页面里调目标 home 的插件管理装：已在它 dependencies 里的合成一条 plugin-manager.update {"specs":{…}}，之后不在的插件逐个 plugin-manager.install',
  '**装内核包**（packages 里有 @godcreator/gwb-kernel-desktop 的包目录）：内核包放进同一条 update，specs 里不放 cordis（插件管理照装上的内核包 peer 自己对齐）；',
  '内核包必须已在目标 home 里。update 回执 restartRequired 时不刷新，改成停掉目标 home 再启动，轮询 shell.env 直到页面报出的内核版本就是这次打包的版本号',
  '**构建不可跳过**：产物不是最新的就打包，装进去的是上一版，而回执一切正常',
  `**构建之后、打包之前做样式检查**（插件包构建后有 dist/style.css 才查，没过就停、一个都不装，所有包的问题一次列全）：${STYLE_CHECK_SUMMARY}`,
  '例：{"home":"bn-2609111200","dir":"D:\\\\unitfolders\\\\evew5-gwbapps\\\\gwb-block-note","packages":["plugins/gwb-bn-core","plugins/gwb-bn-comment"]}',
  '目标 home 是 default、或者就是开发套件自己所在的 home，都直接拒——前者会把开发版装进日常用的 home，',
  '后者重新加载条目时会把正在运行的这条命令自己停掉。要换开发套件自己：发正式版，再 plugin-manager.update {"all":true}',
].join('\n')

const RELEASE_USAGE = [
  'devkit.release 的参数：',
  '  dir       必给，仓根的绝对路径。git 工作区检查与构建都在这里运行',
  '  packages  必给，要发的包目录（非空数组），相对仓根，**按依赖顺序**（被依赖的排前面）',
  '**版本号在仓里升**：发的是 package.json 里写的版本号，同一个版本号已在源上就拒——要发新的一版，先升版本号、提交，再调用',
  '**仓根 git 工作区不干净就拒**：正式版只从提交过的状态发',
  `**发到包自己的 publishConfig.registry**：没写这个字段、或写的不是 http(s) 地址就拒（团队源是 ${TEAM_REGISTRY}）。「同号已在源上」问的也是这个源`,
  '**发版前检查没过就拒**（构建之后，所有包一次列全）：产物里相对 import 指向的文件都在；dev 依赖不查',
  `**带界面的插件包另加样式检查**（构建后有 dist/style.css 才查）：${STYLE_CHECK_SUMMARY}`,
  '**插件包另加**（keywords 含 gwb-plugin）：peer 里只许 cordis、内核包 @godcreator/gwb-kernel-desktop 与别的插件（包目录 node_modules 里它的清单 keywords 含 gwb-plugin），peer 里每个 gwb 插件（不分范围）和源上 dist-tags.latest 在同一条线（0.x 只看 x，≥1 只看主版本号；问哪个源由 ~/.npmrc 的范围行决定）；node 侧产物（exports["."] 入口顺着相对 import 走到的文件）的包名 import 只有 node 内置模块、electron 与 peer 里写了的包；浏览器侧产物（dist/client.js 与自身提供的模块）只 import 自身及直接 peer 的 ./browser-imports 代码出口提供的名字；检查同步映射、本地文件、包内路径、files 白名单与冲突；未声明提供方的旧项目兼容读取旧内核 HTML importmap；peer 里写了内核包、写法是 ^x.y.z（范围包不包含哪个内核不查，验证之后由人改）；' +
    PEER_CYCLE_CHECK_SUMMARY +
    WIRING_CHECK_SUMMARY,
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
  homeDeps: HomeDeps
}

export function apply(ctx: GwbContext): void {
  const log = ctx.logger(name)
  const bus = ctx.gwbCommands
  if (bus === undefined) throw new Error('gwbCommands 服务不在（export const inject 没生效？）——开发套件的命令一条都登记不了')
  const wiring: Wiring = {
    ctx,
    log,
    commands: bus,
    homeDeps: {
      fs: homeFs,
      spawn: makeGuiSpawn((message) => log.warn(message)),
      appSpawnPlan: makeAppSpawnPlan(),
      run: runCaptured,
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
  commands.register(
    {
      name: 'devkit.home.new',
      plugin: '@godcreator/gwb-devkit',
      description: '开一个测试 home（装内核包、cordis 与基础插件，用宿主安装版启动，调试端口自动选）',
      usage:
        '{short 必给（kebab-case）}——名字是 <short>-<yyMMddHHmm>。启动之前往新 home 里依次 pnpm add 三次（写好 cordis.yml 条目）：先装内核包 @godcreator/gwb-kernel-desktop，版本是运行这条命令的内核的 gwbKernel.version；再装装上的内核包 peerDependencies.cordis 写的那个精确版本的 cordis，带 --save-exact（home 清单里只有它写精确版本号）；最后装基础插件（源上的 latest）：命令、外壳、数据、设置、说明书、插件管理、基础界面，加上提供 timer 服务的 @cordisjs/plugin-timer，cordis.yml 里各一条条目。内核包与 cordis 装完都读 node_modules 里的清单核对版本。安装包只带启动器、从 home 里加载内核，所以内核包必须装上；哪一步没成都不启动。然后用宿主自己那个 exe 再开一个窗口（安装版认 GWB_HOME；不构建内核、不认内核仓），调试端口自动选一个空的。现有的 home 用 devkit.home.list 列出，验完的用 devkit.home.rm 删',
    },
    async (args) => {
      if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
      const unknownKeys = unknownKeysRefusal(args, ['short'], HOME_USAGE)
      if (unknownKeys !== undefined) return unknownKeys
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
      return { ok: true, data: { ...outcome, ...(port.note === undefined ? {} : { cdpNote: port.note }) } }
    },
  )

  commands.register(
    {
      name: 'devkit.home.open',
      plugin: '@godcreator/gwb-devkit',
      description: '重开一个已有的测试 home（用宿主安装版启动）',
      usage: '{name 必给}——调试端口自动选。机器重启之后要回到原来那个 home 只有这一条路（home.new 每次都建新目录，插件得全部重装一遍）',
    },
    async (args) => {
      if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
      const unknownKeys = unknownKeysRefusal(args, ['name'], HOME_USAGE)
      if (unknownKeys !== undefined) return unknownKeys
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
  )

  commands.register(
    {
      name: 'devkit.home.rm',
      plugin: '@godcreator/gwb-devkit',
      description: '删一个测试 home',
      usage:
        '{name，force?}——没在运行的直接删；**还在运行的要 force**，那时先停止再删除（按它 runtime.json 里的 pid，核对映像名与记录里那个 CDP 端口后结束进程，按 pid 等进程真正退出后才删除）。**回「已删」只在目录真不在了之后**，没删掉回 ok:false 并列出还剩什么。default 是日常用的 home：不 force 不删，而且它在运行时 force 也不删，先自己关掉它的窗口',
    },
    async (args) => {
      if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
      const unknownKeys = unknownKeysRefusal(args, ['name', 'force'], HOME_USAGE)
      if (unknownKeys !== undefined) return unknownKeys
      const homeName = asHomeName(args.name)
      if (homeName === undefined) return { ok: false, error: `name 缺了或不是 kebab-case。\n${HOME_USAGE}` }
      const outcome = await removeHome(path.join(homesRootOf(), homeName), homeName, args.force === true, homeDeps)
      if (outcome.ok) log.info(`devkit.home.rm：${outcome.note}`)
      else log.warn(`devkit.home.rm 没成：${outcome.note}`)
      return outcome.ok ? { ok: true, data: outcome } : { ok: false, error: outcome.note }
    },
  )

  commands.register(
    { name: 'devkit.home.list', plugin: '@godcreator/gwb-devkit', description: '列出全部测试 home 与各自的端口', usage: '无参数。每个 home 报名字（带时间戳）、是否在运行、调试端口、MCP 入口的端口与地址（runtime.json 的 mcp 字段）' },
    async (args) => {
      const refusal = noArgsRefusal(args)
      if (refusal !== undefined) return refusal
      const root = homesRootOf()
      return { ok: true, data: { root, homes: await listHomes(root, homeDeps) } }
    },
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
        '{"args":["<home 名>","<动作>","<参数…>"]}。**第一个位置只收 home 名，不收端口**——端口从那个 home 的 runtime.json 里查，连上之后还拿页面自报的名字核对一次。动作 eval <文件绝对路径> [JSON 参数] / shot [图.png 绝对路径] [选择器] / move / click / rclick / drag / type / key / scroll <点> / cmd <命令名> [JSON 参数] / reload [选择器] [秒] / home。点写成 .sel、.sel@=文字、.a@=文字 >> .b，或 x,y。开关 --target / --mod（只认 alt、ctrl、meta、shift，写错直接拒）/ --pad / --size / --timeout。**路径不看工作目录**：截图缺省存到被截的那个 home 自己的 out\\cdp\\，要存到别处给绝对路径；eval 的文件只收绝对路径，相对的直接拒；写入位置在本包目录或任何 node_modules 里也拒。**页面自报 default 时只许只读动作 shot / home**，别的动作与 --size 在动手之前就拒：这儿发的是真操作，写动作在隔离 home 上做。连不上的 home 是启动时没带 --remote-debugging-port，停掉重开一次',
      entry: CDP_ENTRY,
    })
  })
}

// ── 改一版看一版与发正式版 ────────────────────────────────────────────────────

/** 停掉一个测试 home，回 ok 时进程已经退出 */
async function stopTestHome(homeName: string, homeDeps: HomeDeps): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const stopped = await bringDownHome(path.join(homesRootOf(), homeName), homeDeps)
  return stopped.ok ? { ok: true, note: stopped.note } : { ok: false, error: stopped.note }
}

/** 启动一个测试 home。调试端口照启动时的规则挑：先沿用上次那个 */
async function startTestHome(homeName: string, homeDeps: HomeDeps): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const root = homesRootOf()
  const port = await cdpPortFor(root, homeName, homeDeps)
  if (!port.ok) return port
  const launched = await launchHome({ name: homeName, homesRoot: root, cdp: port.cdp }, homeDeps)
  return launched.ok ? { ok: true, note: launched.note } : { ok: false, error: launched.error }
}

/** 只收 home 名，不收端口：端口从那个 home 的 `runtime.json` 查并确认进程还在，名字再传下去跟页面自报的核对 */
async function cdpTargetOf(
  args: Record<string, unknown>,
  homeDeps: HomeDeps,
): Promise<{ ok: true; cdp: number; name: string } | { ok: false; error: string }> {
  const homeName = asHomeName(args.home)
  if (homeName === undefined) return { ok: false, error: `home 缺了或不是个合格的 home 名（kebab-case）。\n${DEV_USAGE}` }
  const found = await resolveTarget(homesRootOf(), homeName, homeDeps)
  if (!found.ok) return { ok: false, error: found.error }
  return { ok: true, cdp: found.cdp, name: homeName }
}

/** 认不出的参数键直接拒，报出是哪几个：不猜调用方本想写哪个，也不当没看见 */
function unknownKeysRefusal(args: Record<string, unknown>, known: readonly string[], usage: string): { ok: false; error: string } | undefined {
  const unknownKeys = Object.keys(args).filter((key) => !known.includes(key))
  if (unknownKeys.length === 0) return undefined
  return { ok: false, error: `不认识参数 ${unknownKeys.join('、')}。\n${usage}` }
}

/** 无参数的命令：不给参数或给空对象都收，给了任何键都拒 */
function noArgsRefusal(args: unknown): { ok: false; error: string } | undefined {
  if (args === undefined) return undefined
  if (!isRecord(args)) return { ok: false, error: `这条命令无参数，实得 ${JSON.stringify(args)}` }
  return unknownKeysRefusal(args, [], '这条命令无参数')
}

/** `packages` 必给：非空数组，每一项是非空字符串（包目录，相对仓根）。不合格就拒，不丢掉不合格的项 */
function packagesArgOf(args: Record<string, unknown>, usage: string): { ok: true; packages: string[] } | { ok: false; error: string } {
  const packages = args.packages
  if (!Array.isArray(packages) || packages.length === 0 || packages.some((one) => typeof one !== 'string' || one.trim() === '')) {
    return {
      ok: false,
      error: `packages 必给，要是非空的字符串数组（包目录，相对仓根，如 ["plugins/<短名>"]），实得 ${JSON.stringify(packages) ?? 'undefined'}。\n${usage}`,
    }
  }
  return { ok: true, packages: packages.map((one: string) => one.trim()) }
}

function registerDevCommand({ ctx, log, commands, homeDeps }: Wiring): void {
  commands.register(
    {
      name: 'devkit.dev',
      plugin: '@godcreator/gwb-devkit',
      description: '改一版看一版（构建→打包进目标 home→经目标 home 的插件管理装并重新加载→刷新→取证；装内核包时改成重启目标 home）',
      usage:
        '{home 必给（目标 home 名，**只认名字不认端口**——端口从它的 runtime.json 里查，并确认它还在运行）, dir 必给（仓根绝对路径）, packages 必给（包目录的非空数组，相对仓根；只收插件与内核包，库直接拒）, waitFor?（刷新后等这个选择器出现）}。一条走完：仓根 pnpm build → 照 files 验产物 → 样式检查（插件包构建后有 dist/style.css 才查，没过回 ok:false、一个都不打包，所有包的问题一次列全；查什么见 devkit.release 的 usage）→ 在临时目录组装发布内容、版本号改成 <patch+1>-dev.<yyyyMMddHHmmss>，pnpm pack 到 <目标 home>\\dev-packs\\（包文件每版一个新路径，已存在就拒；旧的不删：home 清单引用着的包文件删了，这个 home 之后的 pnpm add 全失败；开发版不进源）→ 读目标 home 的 package.json（只读）：已在 dependencies 里的包合成一条 plugin-manager.update {"specs":{"<包>":"file:./dev-packs/<包文件>"}}，之后不在的插件逐个 plugin-manager.install {pkg, spec}（新建一条条目），都经 CDP 在目标页面里调；插件管理装包、重新加载这些包与真实目录变了的别的包，插件管理自己的条目推迟到回执之后（回执 selfDeferred，这边轮询 plugin-manager.list 等它 active）→ 整页刷新（驱动退出码非零或没等到页面回来就回 ok:false，说清等的是什么、最后看到了什么）→ 取证（装上的是这次打包的版本号、条目真的 ACTIVE、日志新增的部分里没有 error），取不到证就回 ok:false。回执 { home, homeName, shipped: [{ pkg, version, dir, packFile, via: update|install, entryId? }], update?（plugin-manager.update 的回执原样）, reload? | kernel?, evidence }。**packages 里有内核包 @godcreator/gwb-kernel-desktop 时**：内核包放进同一条 update，specs 里不放 cordis（插件管理照装上的内核包 peer 自己对齐）；内核包不在目标 home 里直接拒；update 回执 restartRequired，这边不刷新，改成停掉目标 home 再启动（主进程里的内核换不掉），轮询 shell.env 直到 versions.kernel 就是这次打包的版本号，回执多一个字段 kernel { version, restart }，再照常取证。**构建不可跳过**：跳过构建就是装上一版。**目标是 default 或开发套件自己所在的 home 都直接拒；页面自报的名字跟你给的对不上也拒**',
    },
    async (args) => {
      if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${DEV_USAGE}` }
      const unknownKeys = unknownKeysRefusal(args, ['home', 'dir', 'packages', 'waitFor'], DEV_USAGE)
      if (unknownKeys !== undefined) return unknownKeys
      const packagesArg = packagesArgOf(args, DEV_USAGE)
      if (!packagesArg.ok) return packagesArg
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
        packages: packagesArg.packages,
        ...(typeof args.waitFor === 'string' && args.waitFor.trim() !== '' ? { waitFor: args.waitFor.trim() } : {}),
        ownHome: requireKernel(ctx).dataDir,
      }
      log.info(`devkit.dev：仓 ${input.repoDir} → ${target.name}（调试口 ${String(target.cdp)}）`)
      const deps: DevDeps = {
        ...devDepsWith(pnpm.file),
        stopHome: (home) => stopTestHome(home, homeDeps),
        startHome: (home) => startTestHome(home, homeDeps),
      }
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
  )
}

/** 只发到源、不碰任何 home，从哪个 home 调都行；升级 default 不接在后面：先在隔离 home 验过，再由插件管理自己升级 */
function registerReleaseCommand({ log, commands }: Wiring): void {
  commands.register(
    {
      name: 'devkit.release',
      plugin: '@godcreator/gwb-devkit',
      description: '发正式版到包的 publishConfig.registry（git 工作区干净→构建→验产物→发版前检查→在临时目录里组装并发布）',
      usage:
        '{dir 必给（仓根绝对路径）, packages 必给（包目录的非空数组，相对仓根，按依赖顺序）}。一条走完：仓根 git 工作区干净（有未提交改动就拒，一个都不发）→ 仓根 pnpm build → 照 files 白名单验产物 → 同号已在发布目标上就拒（发布目标是包自己 package.json 的 publishConfig.registry；没写、或写的不是 http(s) 地址就拒）→ 发版前检查（每个要发的包：产物里相对 import 指向的文件都在；dev 依赖不查。keywords 含 gwb-plugin 的插件包另加：peer 里只许 cordis、内核包 @godcreator/gwb-kernel-desktop 与别的插件（包目录 node_modules 里它的清单 keywords 含 gwb-plugin），peer 里每个 gwb 插件（不分范围）和源上 dist-tags.latest 在同一条线（0.x 只看 x，≥1 只看主版本号；问哪个源由 ~/.npmrc 的范围行决定）；node 侧产物——exports["."] 的运行时入口（没有 exports 时是 main）顺着相对 import 走到的文件——的包名 import 只有 node 内置模块、electron 与 peer 里写了的包；浏览器侧产物——dist/client.js 与自身提供的模块，同样顺着相对 import 走——只 import 自身及直接 peer 的 ./browser-imports 代码出口提供的名字；检查同步映射、本地文件、包内路径、files 白名单与冲突；未声明提供方的旧项目兼容读取旧内核 HTML importmap；peer 里写了内核包、写法是 ^x.y.z，范围包不包含哪个内核不查；' +
        PEER_CYCLE_CHECK_SUMMARY +
        WIRING_CHECK_SUMMARY +
        '；构建后有 dist/style.css 的插件包再做样式检查：' +
        STYLE_CHECK_SUMMARY +
        '。没过就一个都不发，回执按包一次列全）→ 在临时目录里组装发布内容并发到发布目标（不改仓里任何文件；tag latest；发布内容清单的 publishConfig.registry 写发布目标，命令行不带 --registry；workspace: 依赖写成 ^<工作区里那个号>，这一次同发的写成 ^新号）→ 按给定顺序发完。**版本号在仓里升**（改 package.json 并提交），同一个版本号永不重发。只发到源、不碰任何 home；升级 default 用 plugin-manager.update {"all":true}',
    },
    async (args) => {
      if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${RELEASE_USAGE}` }
      const unknownKeys = unknownKeysRefusal(args, ['dir', 'packages'], RELEASE_USAGE)
      if (unknownKeys !== undefined) return unknownKeys
      const packagesArg = packagesArgOf(args, RELEASE_USAGE)
      if (!packagesArg.ok) return packagesArg
      const { packages } = packagesArg
      const dir = typeof args.dir === 'string' ? args.dir.trim() : ''
      if (dir === '' || !path.isAbsolute(dir)) return { ok: false, error: `dir 要是仓根的绝对路径。\n${RELEASE_USAGE}` }
      if (!fs.existsSync(dir)) return { ok: false, error: `${dir} 不在——dir 给的是仓根，不是包目录` }
      const pnpm = await locatePnpm()
      if (!pnpm.ok) return { ok: false, error: pnpm.error }
      log.info(`devkit.release：仓 ${path.resolve(dir)}（${packages.join('、')}）`)
      const outcome = await runRelease({ repoDir: path.resolve(dir), packages }, releaseDepsWith(pnpm.file))
      if (!outcome.ok) {
        log.warn(`devkit.release 没成：${outcome.error}`)
        return outcome.data === undefined
          ? { ok: false, error: outcome.error }
          : { ok: false, error: outcome.error, data: outcome.data }
      }
      log.info(`devkit.release：${outcome.data.shipped.map((one) => `${one.pkg}@${one.version}`).join('、')} 上了 latest`)
      return outcome
    },
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

function peerVersionsOfOwnHome(ctx: GwbContext): PeerVersions {
  const kernel = requireKernel(ctx)
  return homePeerVersions(kernel.dataDir, kernel.version)
}

/** 包内 `template/` 目录。它在 `files` 白名单里，随包发布 */
function templateRoot(): string {
  return path.join(packageRoot(import.meta.dirname), 'template')
}

function registerScaffoldCommand({ ctx, log, commands }: Wiring): void {
  commands.register(
    {
      name: 'devkit.scaffold',
      plugin: '@godcreator/gwb-devkit',
      description: '在一个新目录里生成一个 gwb 插件仓（workspace 布局，插件在 plugins/<短名>/）',
      usage:
        `{name（必给，kebab-case 短名）, dir（必给，绝对路径且必须还不存在）, scope?（包名范围，缺省 ${TEAM_SCOPE}）, registry?（写进插件包 publishConfig.registry 的发布目标，缺省团队源）}。插件的模板在本包；要显示名的地方用短名；不建文档站。${SCAFFOLD_PEER_VERSIONS_NOTE}。${SCAFFOLD_COMPONENTS_NOTE}。回执 { repoDir, pluginDir, pkg, registry, name, files, components, nextSteps }，components 是添加的 shadcn 组件。参数不对会把完整说明回给你`,
    },
    async (args) => {
      if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${SCAFFOLD_USAGE}` }
      const unknownKeys = unknownKeysRefusal(args, ['name', 'dir', 'scope', 'registry'], SCAFFOLD_USAGE)
      if (unknownKeys !== undefined) return unknownKeys
      let plan
      try {
        plan = planScaffold({
          name: typeof args.name === 'string' ? args.name : '',
          dir: typeof args.dir === 'string' ? args.dir : '',
          ...publishIdentityArgsOf(args),
          peerVersions: peerVersionsOfOwnHome(ctx),
        })
      } catch (err) {
        return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${SCAFFOLD_USAGE}` }
      }
      const pnpm = await pnpmForComponents()
      if (!pnpm.ok) return { ok: false, error: `建仓没成，什么都没写：${pnpm.error}` }
      const pluginDir = path.join(plan.dir, 'plugins', plan.name)
      let files
      try {
        files = renderTemplate(templateRoot(), plan)
        writeRepo(plan.dir, files)
      } catch (err) {
        return { ok: false, error: `建仓没成：${err instanceof Error ? err.message : String(err)}` }
      }
      const components = await addTemplateComponents(pluginDir, pnpm.inDir(pluginDir))
      if (!components.ok) {
        log.warn(`devkit.scaffold：${plan.pkg} 的组件没加上：${components.error}`)
        return { ok: false, error: componentsStepFailure(pluginDir, components.error) }
      }
      log.info(`devkit.scaffold：${plan.pkg} → ${pluginDir}（${files.length} 个文件，组件 ${components.components.join('、')}）`)
      return {
        ok: true,
        data: {
          repoDir: plan.dir,
          pluginDir,
          pkg: plan.pkg,
          registry: plan.registry,
          name: plan.name,
          files: files.length,
          components: components.components,
          nextSteps: nextSteps(plan),
        },
      }
    },
  )
}

function registerScaffoldPluginCommand({ ctx, log, commands }: Wiring): void {
  commands.register(
    {
      name: 'devkit.scaffold.plugin',
      plugin: '@godcreator/gwb-devkit',
      description: '往已有的 workspace 仓的 plugins/ 再加一个插件包（与建仓同一份插件包模板）',
      usage:
        '{name 必给（kebab-case 短名，派生规则同 devkit.scaffold）, repo 必给（workspace 仓根的绝对路径——pnpm-workspace.yaml 里得有 plugins/ 那条，没有就拒）, scope?, registry?（规则与缺省值同 devkit.scaffold）}。插件包写到 <repo>/plugins/<短名>/，必须还不存在；仓根、workspace 配置与文档站都不碰。与建仓用的是同一份插件包模板（template/pkg/）——只有一个插件和有多个插件的仓格式一致靠这个。' +
        SCAFFOLD_PEER_VERSIONS_NOTE +
        '。' +
        SCAFFOLD_COMPONENTS_NOTE +
        '。回执 { repoDir, pluginDir, pkg, registry, name, files, components, nextSteps }，components 是添加的 shadcn 组件。参数不对会把完整说明回给你',
    },
    async (args) => {
      if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${SCAFFOLD_PLUGIN_USAGE}` }
      const unknownKeys = unknownKeysRefusal(args, ['name', 'repo', 'scope', 'registry'], SCAFFOLD_PLUGIN_USAGE)
      if (unknownKeys !== undefined) return unknownKeys
      let plan
      try {
        plan = planScaffoldPlugin({
          name: typeof args.name === 'string' ? args.name : '',
          repo: typeof args.repo === 'string' ? args.repo : '',
          ...publishIdentityArgsOf(args),
          peerVersions: peerVersionsOfOwnHome(ctx),
        })
      } catch (err) {
        return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${SCAFFOLD_PLUGIN_USAGE}` }
      }
      const pnpm = await pnpmForComponents()
      if (!pnpm.ok) return { ok: false, error: `加插件没成，什么都没写：${pnpm.error}` }
      let files
      try {
        files = renderPlugin(templateRoot(), plan)
        writeRepo(plan.dir, files)
      } catch (err) {
        return { ok: false, error: `加插件没成：${err instanceof Error ? err.message : String(err)}` }
      }
      const components = await addTemplateComponents(plan.dir, pnpm.inDir(plan.dir))
      if (!components.ok) {
        log.warn(`devkit.scaffold.plugin：${plan.pkg} 的组件没加上：${components.error}`)
        return { ok: false, error: componentsStepFailure(plan.dir, components.error) }
      }
      log.info(`devkit.scaffold.plugin：${plan.pkg} → ${plan.dir}（${files.length} 个文件，组件 ${components.components.join('、')}）`)
      return {
        ok: true,
        data: {
          repoDir: plan.repoDir,
          pluginDir: plan.dir,
          pkg: plan.pkg,
          registry: plan.registry,
          name: plan.name,
          files: files.length,
          components: components.components,
          nextSteps: nextStepsPlugin(plan),
        },
      }
    },
  )
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
