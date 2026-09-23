import fs from 'node:fs'
import path from 'node:path'
import type { GwbContext } from '@godcreator/gwb-plugin-api'
import { isRecord, requireKernel } from './vocab.js'
// 只为激活对方包里的 declare module 'cordis'——ctx 上那几个名字的类型从那儿来
import type {} from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-node-cli'
import type {} from '@godcreator/gwb-shell'
import type {} from '@godcreator/gwb-skills'
import {
  asHomeName,
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
import { DEFAULT_REGISTRY, type DevInput, runDev } from './dev.js'
import { runRelease } from './release.js'
import { auditManifest, countByKind, type ManifestDeps } from './audit.js'
import { collectManifests, collectRepos, fetchRegistry } from './node-audit-deps.js'
import { auditStructure, scanRepo, tallyKinds, type StructureFinding } from './structure.js'
import { CDP_ENTRY, devDeps, releaseDeps } from './node-dev-deps.js'
import { homeFs, makeAppSpawnPlan, makeGuiSpawn, runCaptured } from './node-home-deps.js'
import {
  NAME_RE,
  nextSteps,
  nextStepsPlugin,
  packageRoot,
  planScaffold,
  planScaffoldPlugin,
  renderPlugin,
  renderTemplate,
  writeRepo,
} from './scaffold.js'
import { joinProvides, serviceSight } from './services.js'
import { importFacesOf } from './capabilities.js'

export const name = 'gwb-devkit'
export const inject = ['gwbCommands']

/**
 * 铺 fumadocs 骨架那条命令，由**站件** `@godcreator/gwb-docs-site` 提供。
 *
 * **本包不依赖它**——只在命令总线上按名字找。找不到就是这个 home 没装站件，跳过铺站、
 * 在回执里说清怎么补，绝不因此让建仓失败。
 */
const CREATE_SITE_COMMAND = 'docs-site.create'

/**
 * 在骨架上装配六区那条命令，由 **docfirst 件** `@godcreator/gwb-docfirst-workflow` 提供。
 * 同样只认名字、不依赖包。**只在刚铺好的骨架上装得了**：站里已经有内容它会自己拒。
 */
const ATTACH_SITE_COMMAND = 'docfirst.attach'

/**
 * 开发套件。六件事，全服务同一个理由——「在新文件夹里开发新件」这条路的地基：
 *
 * - **建仓**：`devkit.scaffold` 把一个新件的骨架落进一个新文件夹（站那半经命令总线
 *   转给站件与 docfirst 件，两步）。**只有一种仓形**：薄壳 workspace——根壳 +
 *   `plugins/<短名>/` 件包；「单件仓」只是 plugins/ 下恰好一个目录
 * - **加件**：`devkit.scaffold.plugin` 往既有薄壳仓的 `plugins/` 再铺一个件包，
 *   落的是建仓时同一份件包模板——格式统一靠同一份正本，不靠纪律
 * - **结构体检**：`devkit.audit-structure` 只读地回答一个仓（或全生态）离标准形多远。
 *   规则正本仍是 scaffold 模板——round-trip 测试「模板产物零 findings」焊着两边
 * - **手册**：`skills/gwb-devkit/SKILL.md` 随件分发，经 gwb-skills 挂载。**只挂自己那份**
 *   ——知识随件走，docfirst 的两份归 docfirst 件自己挂（说明书是全局单一命名空间，
 *   代挂第二份只会撞名，而且撞掉的那份很可能是旧版）
 * - **home**：测试 home 的开/列/重开/删（`devkit.home.*`）——实机验证那几步的
 *   命令化（一次验开一个新 home、清理放在开新那一刻）。起 home 拉**宿主自己那个 exe**
 *   （日常就是安装版），不 build 内核、不认内核仓——内核源码的验机归内核仓自己的路
 *
 * - **改一版看一版**：`devkit.dev` 一条走完「构建 → 发开发版 → 装进隔离 home → 重挂 →
 *   刷新 → 取证」。**这条命令住控制台那个 home，操作另一个 home**：换件那一步要把条目
 *   停用再启用，工具自己跑在目标里就会把自己停掉
 *
 * - **发正式版**：`devkit.release` 从仓根把包按序发到团队源（tag latest）。号在仓里抬、
 *   git 树不干净就拒、只碰源不碰任何 home——没有自停问题，从哪个 home 调都行
 *
 * 外加一条经 `gwbNodeCli` 登记的外部 CLI：`devkit.cdp`（在一个工作台页面里动手，
 * 从取证到点按拖拽都是它；在页面里跑代码是它的 `eval` 动作）。
 *
 * `apply` 里只剩接线；建仓的校验、渲染、落盘在 `scaffold.ts`；home 的时序在 `home.ts`、
 * 改一版看一版那条链在 `dev.ts`、进程探测的纯机在 `probes.ts`（皆纯机，可单测），
 * 真机器的盘与进程在 `node-probe-deps.ts` / `node-home-deps.ts` / `node-dev-deps.ts`。
 */

/** `devkit.scaffold` 的参数说明。参数错的时候连它一起回——错误即文档 */
const SCAFFOLD_USAGE = [
  'devkit.scaffold 的参数：',
  // 规则从 NAME_RE 现取，不在这儿手抄一份——抄的那份必然跟真源漂开
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。它派生出包名 @godcreator/gwb-<短名>、插件名 gwb-<短名>、命令名 <短名>.<动作> 的前半`,
  '  dir    必给，目标目录的绝对路径，必须还不存在（存在就拒，不覆盖任何东西）。落下去只有一个仓形：薄壳 workspace——根壳 + plugins/<短名>/ 件包',
  '  title  可选，显示名，缺省用 name',
  `  docs   可选，缺省 true——件那半落盘之后顺带建站，两步：${CREATE_SITE_COMMAND} 铺 fumadocs 骨架、${ATTACH_SITE_COMMAND} 在骨架上装配六区。两条都经命令总线找，没装那个件就跳过那一步（回执里说怎么补），不算建仓失败。false 就只建件那半`,
  '  port   可选，文档站端口。不给由站件自己挑（扫邻居已占的，从 4310 起找空位）',
  '例：{"name":"hello","dir":"D:\\\\tmp\\\\hello","title":"打个招呼"}',
].join('\n')

/** `devkit.scaffold.plugin` 的参数说明。参数错的时候连它一起回——错误即文档 */
const SCAFFOLD_PLUGIN_USAGE = [
  'devkit.scaffold.plugin 的参数：',
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。派生规则同 devkit.scaffold`,
  '  repo   必给，薄壳仓根的绝对路径（pnpm-workspace.yaml 住的那层）。yaml 里得有 plugins/ 那条——老裸根单件仓（仓根即包根）先迁成薄壳再来，报错里带路',
  '  title  可选，显示名，缺省用 name',
  '件包落在 <repo>/plugins/<短名>/，必须还不存在（存在就拒，不覆盖任何东西）。根壳、workspace、文档站一概不碰——一份站盖全仓，件清单的更新归 docfirst（回执 nextSteps 里提醒）',
  '例：{"repo":"D:\\\\tmp\\\\hello","name":"world","title":"第二件"}',
].join('\n')

/** `devkit.audit-structure` 的参数说明。参数错的时候连它一起回——错误即文档 */
const STRUCTURE_USAGE = [
  'devkit.audit-structure 的参数：',
  '  dir   可选，单仓的绝对路径——只体检这一个仓',
  '  root  可选，容器根的绝对路径——扫全生态（unit-folder.list 现问缺省）。',
  '        dir 与 root 都不给就是全生态',
  '只读。管形状与静态红线（仓形 / 件包自足 / 短名派生链 / files 白名单 / prepublishOnly /',
  'cordis 位置 / tsconfig paths / link:·file: 依赖），不管版本（那是 audit-deps 与发版检票）、',
  '不管自述三格（repo-kit 守卫）、不管产物（各仓 artifact 测试）。',
  'findings 分级：error 长不成或装不上、warn 偏离当前形、info 提示（裸根单件仓给迁移清单）。',
  '例：{"dir":"D:\\\\unitfolders\\\\evew5-gwbapps\\\\gwb-block-note"}',
].join('\n')

/** home 命令的参数说明。参数错的时候连它一起回——错误即文档 */
const HOME_USAGE = [
  'home 命令的参数：',
  '  devkit.home.new  { short 必给（kebab-case 短名） }——开 <short>-<yyMMddHHmm> 的新 home。拉宿主安装版起窗、自动装底座七件，调试口自动挑',
  '  devkit.home.open { name 必给（完整 home 名） }——重开一个已有的 home，不 build。机器重启之后回到现场走这条',
  '  devkit.home.rm   { name，force? }——删一个 home。没在跑的直接删；还在跑的要 force（连停带删，等进程真退再删）；目录真不在了才回已删',
  '                     default 是日常那份：不 force 不删，而且它在跑的时候 force 也不删——自己关掉那扇窗再来',
  '  devkit.home.list {}——列出 home 根下全部 home 与谁在跑',
  '例：{"short":"data"}、{"name":"data-2609081430"}',
  '**这几条都不收调试口**：口是起的时候自动挑的（先沿用这个 home 上次那个，被占了才另挑），',
  '之后从它的 runtime.json 里查。端口没有语义，敲错一位就落在另一个现场。',
].join('\n')

/** `devkit.dev` 的参数说明。参数错的时候连它一起回——错误即文档 */
const DEV_USAGE = [
  'devkit.dev 的参数：',
  '  home      必给，目标 home 名。**这儿不收端口**：口从那个 home 的 runtime.json 里查，顺带验活',
  '            （记录读得出、pid 还活着、那个 pid 真的持着那个口），再拿页面自报的名字核对一次',
  '  dir       必给，仓根的绝对路径。构建在这儿跑',
  '  packages  可选，要发的包目录，相对仓根，**按依赖顺序**（被依赖的排前面）。不给就是仓根自己',
  '  waitFor   可选，刷新之后等页面上这个选择器出现才算刷回来了',
  '**构建不可跳过**：产物不新就发＝发的是上一版，而回执一切正常。源也不收：这台机器上只有',
  '一个，就是 ' + DEFAULT_REGISTRY,
  '例：{"home":"bn-2609111200","dir":"D:\\\\unitfolders\\\\evew5-gwbapps\\\\gwb-block-note","packages":["packages/model","plugins/gwb-bn-core"]}',
  '目标 home 是 default、或者就是本件自己住的那个，都当场拒——前者会把开发版塞进日常那份，',
  '后者停用条目那一下会把正在跑的这条命令自己停掉。换 devkit 自己：发正式版，再 plugin-manager.update-all',
].join('\n')

/** `devkit.release` 的参数说明。参数错的时候连它一起回——错误即文档 */
const RELEASE_USAGE = [
  'devkit.release 的参数：',
  '  dir       必给，仓根的绝对路径。git 守卫与构建都在这儿跑',
  '  packages  可选，要发的包目录，相对仓根，**按依赖顺序**（被依赖的排前面）。不给就是仓根自己',
  '**号在仓里抬**：发的是 package.json 里声明的那个号，同号在源上就拒——要发新的一版，先抬号、提交，再来',
  '**仓根 git 树不干净就拒**：正式版只从提交过的状态发',
  '**上车检票没过就拒**：自己不在 0.0.x、@godcreator 的 peer 写 ^<dev 钉>、dev 钉＝源上 dist-tags.latest（规矩见说明书 gwb-release）',
  '**插件包没写对 gwb.testedKernel 就拒**：keywords 含 gwb-plugin 的包，package.json 的 gwb.testedKernel 必须写了、是合法版本号、并且和运行中的内核在同一条版本线上（主版本号为 0 比前两位，≥1 只比主版本号）',
  '**这条链只碰源、不碰任何 home**，从哪个 home 调都行；升 default 是下一步的事，走 plugin-manager.update-all',
  '例：{"dir":"D:\\\\unitfolders\\\\evew5-gwbapps\\\\gwb-block-note","packages":["packages/model","packages/engine","packages/client","plugins/gwb-bn-core","plugins/gwb-bn-comment"]}',
].join('\n')

export function apply(ctx: GwbContext): void {
  const log = ctx.logger(name)
  const bus = ctx.gwbCommands
  if (bus === undefined) {
    // export const inject 在，理论上走不到这儿；走到就直说，别让命令面无声地空着
    log.warn('gwbCommands 服务不在（inject 没生效？）——命令一条没挂')
    return
  }

  /**
   * 收窄过的那份总线引用。**函数声明会提升**——提升到 undefined 判断之前的那几个函数体里，
   * `bus` 仍然是可空的；这个 const 求值在判断之后，类型就是收窄好的那个。
   */
  const commands = bus

  /**
   * 总线上现在有没有这条命令。**现问、不缓存**：件是热挂载的，装一个新件之后这个答案
   * 当场就变，缓存下来只会得到一份「装了却说没装」的假象。
   */
  function hasCommand(command: string): boolean {
    return commands.list().some((entry) => entry.name === command)
  }

  // ── home 那半 ──────────────────────────────────────────────────────────────

  const homeDeps: HomeDeps = {
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
  }

  /**
   * home 根从内核的 dataDir 推：`<userData>/homes/<名>` → 上两级再接 `homes`。
   * **不写死应用名**——内核哪天改了 userData 的名字，这儿也不漂。
   */
  function homesRoot(): string {
    return path.join(path.resolve(requireKernel(ctx).dataDir, '..', '..'), 'homes')
  }

  /**
   * 这一趟起 home 用哪个调试口。**自动定，定不出来就不起**——名字是唯一的地址之后，
   * 没有调试口的 home 等于起完就够不着；那不是「少一个可选项」，是起了个用不上的东西。
   *
   * **人给不了这个口**：自动那条先沿用这个 home 上次那个、被占了才另挑，比手给一个准；
   * 收下一个手给的口，剩下的全部用法就只有「敲错一位落在别人口上」。换没换在回执里说
   * 一句，不然人会以为口没变。
   */
  async function cdpFor(
    root: string,
    name: string,
  ): Promise<{ ok: true; cdp: number; note?: string } | { ok: false; error: string }> {
    const picked = await pickCdpPort(root, homeDeps, name)
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

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.home.new',
        plugin: '@godcreator/gwb-devkit',
        description: '开一个测试 home（拉宿主安装版、铺底座、调试口自动挑）',
        usage:
          '{short 必给（kebab-case）}——名字长成 <short>-<yyMMddHHmm>。拉宿主自己那个 exe 再开一扇窗（安装版对 GWB_HOME 同样成立；不 build 内核、不认内核仓，内核版本跟安装包走），起之前自动装底座七件，调试口自动挑一个空的。返回里带着现有 home 清单，开新那一刻正好清旧的',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const short = asHomeName(args.short)
        if (short === undefined) return { ok: false, error: `short 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const root = homesRoot()
        let name: string
        try {
          name = nextName(short, homeDeps.now(), (candidate) => homeDeps.fs.exists(path.join(root, candidate)))
        } catch (err) {
          return { ok: false, error: String(err instanceof Error ? err.message : err) }
        }
        const port = await cdpFor(root, name)
        if (!port.ok) return { ok: false, error: port.error }
        const outcome = await launchHome({ name, homesRoot: root, cdp: port.cdp, base: true }, homeDeps)
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
    bus.register(
      {
        name: 'devkit.home.open',
        plugin: '@godcreator/gwb-devkit',
        description: '重开一个已有的测试 home（拉宿主安装版）',
        usage: '{name 必给}——调试口自动挑。机器重启之后回到原来那个现场只有这一条路（home.new 永远造新目录，件得全部重装一遍）',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const name = asHomeName(args.name)
        if (name === undefined) return { ok: false, error: `name 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const root = homesRoot()
        if (!homeDeps.fs.exists(path.join(root, name))) {
          return { ok: false, error: `${path.join(root, name)} 不在——没有这个 home（看 devkit.home.list）` }
        }
        const port = await cdpFor(root, name)
        if (!port.ok) return { ok: false, error: port.error }
        const outcome = await launchHome(
          { name, homesRoot: root, cdp: port.cdp },
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
    bus.register(
      {
        name: 'devkit.home.rm',
        plugin: '@godcreator/gwb-devkit',
        description: '删一个测试 home',
        usage:
          '{name，force?}——没在跑的直接删；**还在跑的要 force**，那时连停带删（按它 runtime.json 里的 pid，核对映像名与记录里那个 CDP 端口再杀，按 pid 等进程真退了才删）。**回「已删」只在目录真不在了之后**，没删掉回 ok:false 并列出还剩什么。default 是日常那份：不 force 不删，而且它在跑的时候 force 也不删，自己关掉那扇窗再来',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const name = asHomeName(args.name)
        if (name === undefined) return { ok: false, error: `name 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const outcome = await removeHome(path.join(homesRoot(), name), name, args.force === true, homeDeps)
        if (outcome.ok) log.info(`devkit.home.rm：${outcome.note}`)
        else log.warn(`devkit.home.rm 没成：${outcome.note}`)
        return outcome.ok ? { ok: true, data: outcome } : { ok: false, error: outcome.note }
      },
    ),
  )

  ctx.effect(() =>
    bus.register(
      { name: 'devkit.home.list', plugin: '@godcreator/gwb-devkit', description: '列出全部测试 home 与各自的口', usage: '名字（带时间戳）、谁还在跑、CDP 口、MCP 门（mcp 格；老 home 的 command-http 格照报当线索）。无参数' },
      async () => {
        const root = homesRoot()
        return { ok: true, data: { root, homes: await listHomes(root, homeDeps) } }
      },
    ),
  )

  // 「谁提供这个服务」——问 cordis 自己的 reflect 表，答案现算（理由在 services.ts）；
  // 用法那半从各包自带的 gwb.provides 声明 join 进来——真相在各自的 package.json 里，这儿不抄
  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.services',
        plugin: '@godcreator/gwb-devkit',
        description: '这台 home 里有哪些 cordis 服务、各是谁提供的、怎么用——运行时现问，用法从各包 gwb.provides 声明 join',
        usage:
          '无参数。回 { services: [{ service, entryId?, pkg?, provides? }] }——entryId 是 cordis.yml 里的条目名，pkg 是包名；两个都没有的是内核自己挂的服务。provides 是那个包在自家 package.json 的 gwb.provides 里声明的 { summary, usage }，写插件要接一面时照它用——没声明的服务照样列，只是不带用法。拿不到运行时的服务表时回空表加 note 与 saw（看见了几层 fiber 链、几个件、几张服务表）——用来分辨「这个宿主不是 cordis」和「cordis 换了形状」',
      },
      async () => {
        const sight = serviceSight(ctx)
        const home = requireKernel(ctx).dataDir
        const services = await joinProvides(sight.owners, async (pkg) => {
          try {
            return JSON.parse(await fs.promises.readFile(path.join(home, 'node_modules', pkg, 'package.json'), 'utf8')) as unknown
          } catch {
            return undefined
          }
        })
        const owners = sight.owners
        return {
          ok: true,
          data: {
            services,
            ...(owners.length === 0
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

  // 「开发一个新插件能基于什么」的单一入口：inject 面 + import 面 + 一句指路。事实
  // （入口/身份/shared/d.ts）现算自各包 package.json，意图（怎么接）是 gwb.provides
  const capabilitiesData = async (): Promise<unknown> => {
    const home = requireKernel(ctx).dataDir
    const readManifest = async (pkg: string): Promise<unknown> => {
      try {
        return JSON.parse(await fs.promises.readFile(path.join(home, 'node_modules', pkg, 'package.json'), 'utf8')) as unknown
      } catch {
        return undefined
      }
    }
    const inject = await joinProvides(serviceSight(ctx).owners, readManifest)
    let deps: string[] = []
    try {
      const homeManifest: unknown = JSON.parse(await fs.promises.readFile(path.join(home, 'package.json'), 'utf8'))
      const dependencies = isRecord(homeManifest) ? homeManifest['dependencies'] : undefined
      if (isRecord(dependencies)) deps = Object.keys(dependencies)
    } catch {
      // home 清单读不到：import 段空表，inject 段照常——两条腿互不拖
    }
    const faces = await importFacesOf(deps, (pkg) => readManifest(pkg))
    return {
      inject,
      import: faces,
      commands: '件暴露的命令面不在这儿重复——search {"plugin":"<包名>"} 按件查，那是命令的家',
    }
  }

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.capabilities',
        plugin: '@godcreator/gwb-devkit',
        description: '开发一个新插件能基于什么：可 inject 的服务、可 import 的包与入口、类型正本在哪——一站看全，别孤零零从零做',
        usage:
          '无参数。回 { inject, import, commands } 三段。inject：这台 home 现挂的 cordis 服务，带各包 gwb.provides 自述（要接一面照 usage 写）。import：home 已装包逐个列——身份（件/库/第三方）、import 时写的入口说明符、d.ts 路径（符号级看原文，命令不摘抄）、importmap 外置名（shared，react 系那种）与意图自述。commands：指 search。事实现算不抄；没声明的入口照样列、只是少一句人话',
      },
      async () => ({ ok: true, data: await capabilitiesData() }),
    ),
  )

  // **本件没有浏览器半**：它的使用者是 agent，读的是回执。所以这儿只报一个给人看的
  // 名字，没有窗格、没有 `dist/client/`
  ctx.inject(['gwbShell'], (scoped) => {
    // 给人看的名字（件清单里显示用）。外壳不在就算了，那半本来就不是它的脸
    scoped.gwbShell.describeSelf({ title: '开发套件', icon: 'wrench' })
  })

  // ── 一条 node CLI ──────────────────────────────────────────────────────────

  // CLI 形态的东西一律经 gwbNodeCli 登记，不做总线命令、不进程内调：登记的命令自动镜像
  // 成总线命令，于是自动是 MCP 工具，回执自带 stdout 与退出码。
  // register **不用自己包 effect**：运行器内部已经挂在调用方的 effect 上了
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

  // ── 改一版看一版 ───────────────────────────────────────────────────────────

  /**
   * 「要操作哪个 home」收窄成「连哪个调试口」。**只收名字，不收端口**（0.5.0 起）。
   *
   * 口从那个 home 的 `runtime.json` 里查（内核开机写的），**顺带验活**：pid 还在、且那个 pid
   * 真的持着那个口。名字接着传给循环，跟页面自报的再核对一次——记录回答「你要的是哪个」，
   * 页面回答「你连上的实际是哪个」。
   *
   * **端口不再是地址**：它是一个没有语义、敲错一位就落在另一个现场的数，而那个现场也会
   * 老老实实收下这一趟改动。名字有拼写、有记录、有交叉核对，三样端口都没有。给了 `cdp`
   * 不是忽略，是当场拒并告诉他新写法——静默改道比报错坏。
   */
  async function targetOf(
    args: Record<string, unknown>,
  ): Promise<{ ok: true; cdp: number; name: string } | { ok: false; error: string }> {
    if (args.cdp !== undefined) {
      return {
        ok: false,
        error: `这儿不收端口了，只收 home 名：{"home":"<名>"}。口从那个 home 的 runtime.json 里查，顺带验活。\n${DEV_USAGE}`,
      }
    }
    const name = asHomeName(args.home)
    if (name === undefined) return { ok: false, error: `home 缺了或不是个合格的 home 名（kebab-case）。\n${DEV_USAGE}` }
    const found = await resolveTarget(homesRoot(), name, homeDeps)
    if (!found.ok) return { ok: false, error: found.error }
    return { ok: true, cdp: found.cdp, name }
  }

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.dev',
        plugin: '@godcreator/gwb-devkit',
        description: '改一版看一版（build→发 dev 版→目标 home 热挂→取证）',
        usage:
          '{home 必给（目标 home 名，**只认名字不认端口**——口从它的 runtime.json 里查并验活）, dir 必给（仓根绝对路径）, packages?（包目录，相对仓根，按依赖顺序；不给就是仓根自己）, waitFor?（刷新后等这个选择器出现）}。一条走完：仓根 pnpm build → 发开发版（<patch+1>-dev.<戳>，标 dev 不动 latest）→ 目标 home 的 package.json 写那个准确号再 pnpm install，读回 node_modules 里装上的号核对（对不上当场 ok:false，不重挂）→ 逐条 plugin-manager.remount 重挂（一条命令做完停用再启用，目标 home 的 plugin-manager 要 ≥0.4.0；重挂 plugin-manager 自己时回执之后才动手，这边轮询到它回来）→ 整页重载 → 取证（装上的是这一趟的号、条目真 ACTIVE、日志增量里没有 error），取不到证就回 ok:false。**构建与源都不可给**：跳过构建就是发上一版，而这台机器只有一个源。**目标是 default 或本件自己所在的 home 都当场拒；页面自报的名字跟你给的对不上也拒**',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${DEV_USAGE}` }
        const target = await targetOf(args)
        if (!target.ok) return { ok: false, error: target.error }
        const dir = typeof args.dir === 'string' ? args.dir.trim() : ''
        if (dir === '' || !path.isAbsolute(dir)) return { ok: false, error: `dir 要是仓根的绝对路径。\n${DEV_USAGE}` }
        if (!devDeps.exists(dir)) return { ok: false, error: `${dir} 不在——dir 给的是仓根，不是包目录` }
        const packages = Array.isArray(args.packages)
          ? args.packages.filter((one): one is string => typeof one === 'string' && one.trim() !== '')
          : []
        const input: DevInput = {
          home: target.name,
          repoDir: path.resolve(dir),
          packages,
          ...(typeof args.waitFor === 'string' && args.waitFor.trim() !== '' ? { waitFor: args.waitFor.trim() } : {}),
          ownHome: requireKernel(ctx).dataDir,
        }
        log.info(`devkit.dev：仓 ${input.repoDir} → ${target.name}（调试口 ${String(target.cdp)}）`)
        const outcome = await runDev(input, devDeps)
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

  // ── 发正式版 ───────────────────────────────────────────────────────────────

  /**
   * 与 `devkit.dev` 的安全模型不同:那条要站在被换的进程外(住控制台、操作另一个 home),
   * 这条只碰 registry、一个 home 都不碰,从哪个 home 调都行。升 default 不链进来——
   * update-all 得由插件件在那个 home 里发起才活得过热重挂,而且发完该先在隔离 home 验过。
   */
  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.release',
        plugin: '@godcreator/gwb-devkit',
        description: '发正式版到团队源（树干净守卫→build→验产物→上车检票→staging 发）',
        usage:
          '{dir 必给（仓根绝对路径）, packages?（包目录，相对仓根，按依赖顺序；不给就是仓根自己）}。一条走完：仓根 git 树干净守卫（有未提交改动就拒，一个都不发）→ 仓根 pnpm build → 照 files 白名单验产物 → 同号已在源上就拒 → 上车检票（每个要发的包：自己不在 0.0.x；@godcreator 的 peer 全写 ^x.y.z 且下限＝dev 钉；dev 精确钉全等于源上 dist-tags.latest，workspace: 跳过。没过就一个都不发，回执按包一次列全「把哪条改成什么」，落后的分范围内/出范围两种说法；peer 指向的上游还在 0.0.x 只提醒，带在回执 reminders 里；keywords 含 gwb-plugin 的包还要检查 package.json 的 gwb.testedKernel：必须写了、是合法版本号、并且和运行中的内核 gwbKernel.version 在同一条版本线上——主版本号为 0 比前两位，≥1 只比主版本号，不满足的同样列进回执、一个都不发）→ staging 发版（不改仓里任何文件；tag latest；workspace: 依赖写成 ^<工作区里那个号>，这一趟同发的写成 ^新号）→ 按给定顺序发完。**号在仓里抬**（改 package.json 提交），同号永不重发。只碰源不碰任何 home；升 default 走 plugin-manager.update-all',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${RELEASE_USAGE}` }
        const dir = typeof args.dir === 'string' ? args.dir.trim() : ''
        if (dir === '' || !path.isAbsolute(dir)) return { ok: false, error: `dir 要是仓根的绝对路径。\n${RELEASE_USAGE}` }
        if (!releaseDeps.exists(dir)) return { ok: false, error: `${dir} 不在——dir 给的是仓根，不是包目录` }
        const packages = Array.isArray(args.packages)
          ? args.packages.filter((one): one is string => typeof one === 'string' && one.trim() !== '')
          : []
        log.info(`devkit.release：仓 ${path.resolve(dir)}（${packages.length === 0 ? '仓根自己' : packages.join('、')}）`)
        const outcome = await runRelease({ repoDir: path.resolve(dir), packages, runningKernel: requireKernel(ctx).version }, releaseDeps)
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

  // ── 依赖对账 ────────────────────────────────────────────────────────────────

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.audit-deps',
        plugin: '@godcreator/gwb-devkit',
        description: '全生态依赖对账：各插件仓的 @godcreator 声明对 registry 现值，抓死钉与火车债',
        usage:
          '{root?（容器根绝对路径，缺省现问命令总线 unit-folder.list 回的 container）, registry?（缺省个人源）}。无参数直接调也行。回执 { ok, data: { root, registry, repos, manifests, packages, retired, testUnits, findings, byKind } }——findings 逐条 { kind, repo, manifest, pkg, detail }；kind：dead-pin（钉了源上没有的版本，装必炸）/ behind（dev 钉落后源上 dist-tags.latest 但还在 ^<dev 钉> 范围内，提示，等各自下次发版；dev 号不算最新）/ out-of-range（最新已出 ^ 范围，上游出了破坏版，必须追）/ peer-not-caret（peer 不是 ^x.y.z——还写 >= 或别的写法，迁移欠账，发版检票会拒）/ floor-unverifiable（peer 下限指向源上没有的版本）/ floor-mismatch（peer 下限 ≠ dev 钉）/ floor-no-mirror（peer 无 dev 镜像）/ loose-dev-pin（dev 钉不是精确号）。退役单元（unit.json 的 status 是 retired）与**测试件**（kind 是「测试件」的单元，测试用途的示范件）整个不扫，名字分别列在 retired 与 testUnits；private: true 的清单不发布，只查 dev 钉那三类、不查 peer 下限。只读不改：扫仓、读 package.json、问源',
      },
      async (args) => {
        const askedRoot = isRecord(args) && typeof args.root === 'string' ? args.root.trim() : ''
        let root = askedRoot !== '' ? path.resolve(askedRoot) : undefined
        if (root === undefined && hasCommand('unit-folder.list')) {
          // 容器根的知识归 unit-folder 件，devkit 只在总线上按名要——跟建仓转铺站那两条同一个路子
          const listed = await commands.run('unit-folder.list', {})
          const container = listed.ok && isRecord(listed.data) && typeof listed.data.container === 'string' ? listed.data.container : ''
          if (container !== '') root = path.resolve(container)
        }
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
        const pkgs = [...new Set(manifests.flatMap((m) => [...Object.keys(m.deps.peers), ...Object.keys(m.deps.devs)]))]
        const registry = await fetchRegistry(pkgs, registryBase)
        const findings = manifests.flatMap((m) => auditManifest(m.repo, m.manifest, m.deps, registry))
        const byKind = countByKind(findings)
        log.info(
          `devkit.audit-deps：${String(repoDirs.length)} 仓 ${String(manifests.length)} 份 manifest 对 ${String(pkgs.length)} 个包（退役单元 ${String(retired.length)} 个、测试件 ${String(testUnits.length)} 个不扫）——` +
            `死钉 ${String(byKind['dead-pin'])}、必须追 ${String(byKind['out-of-range'])}、范围内落后 ${String(byKind.behind)}、peer 未迁 ^ ${String(byKind['peer-not-caret'])}、下限水分 ${String(byKind['floor-unverifiable'] + byKind['floor-mismatch'])}`,
        )
        return { ok: true, data: { root, registry: registryBase, repos: repoDirs.length, manifests: manifests.length, packages: pkgs.length, retired, testUnits, findings, byKind } }
      },
    ),
  )

  // ── 结构体检 ───────────────────────────────────────────────────────────────

  /**
   * 只读的结构体检，与 `devkit.audit-deps` 同一个入口形状：给了 dir 体检单仓，
   * 给了/缺省 root 扫全生态（退役单元与测试件跳过）。规则正本是 scaffold 模板——
   * 「模板产物零 findings」的 round-trip 测试焊着两边。
   */
  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.audit-structure',
        plugin: '@godcreator/gwb-devkit',
        description: '结构体检（只读）：仓形、件包自足、短名派生链、files 白名单、静态红线（cordis 位置 / tsconfig paths / link: 依赖）',
        usage:
          '{dir?（单仓绝对路径）, root?（容器根，缺省现问 unit-folder.list）}。dir 与 root 都不给就是全生态。只读，回 { shape, findings:[{kind,level,path,detail}], byKind }——level：error（长不成/装不上/必炸）、warn（偏离当前形）、info（提示；裸根单件仓给按实际文件拼好的迁移清单）。**不管的**：依赖钉版与 peer（audit-deps 与发版检票）、自述三格（repo-kit 守卫）、产物形状（各仓 artifact 测试）。不挂发版检票——那是门禁，这是日常体检。参数不对会把完整说明回给你',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${STRUCTURE_USAGE}` }
        const dir = typeof args.dir === 'string' && args.dir.trim() !== '' ? path.resolve(args.dir.trim()) : ''
        if (dir !== '') {
          if (!fs.existsSync(dir)) return { ok: false, error: `${dir} 不在——dir 给的是仓根的绝对路径` }
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
        // 与 audit-deps 同一条路：容器根的知识归 unit-folder 件，devkit 只在总线上按名要
        const askedRoot = typeof args.root === 'string' ? args.root.trim() : ''
        let root = askedRoot !== '' ? path.resolve(askedRoot) : undefined
        if (root === undefined && hasCommand('unit-folder.list')) {
          const listed = await commands.run('unit-folder.list', {})
          const container = listed.ok && isRecord(listed.data) && typeof listed.data.container === 'string' ? listed.data.container : ''
          if (container !== '') root = path.resolve(container)
        }
        if (root === undefined) {
          return { ok: false, error: '扫哪没说清：给 dir（单仓）或 root（容器根），或在这个 home 装 @godcreator/gwb-unit-folder——它现扫回的 container 就是容器根' }
        }
        if (!fs.existsSync(root)) return { ok: false, error: `${root} 不在——root 给的是容器根（unit.json 们住的那层）` }
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
      },
    ),
  )

  // ── 建仓那半 ───────────────────────────────────────────────────────────────

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.scaffold',
        plugin: '@godcreator/gwb-devkit',
        description: '把一个新 gwb 件的骨架落进一个新文件夹（默认连文档站）',
        usage:
          `{name（必给，kebab-case 短名）, dir（必给，绝对路径且必须还不存在）, title?, docs?（缺省 true）, port?}。件那半的模板在本包；站那半是两步，都经命令总线转出去——${CREATE_SITE_COMMAND}（站件）铺 fumadocs 骨架，${ATTACH_SITE_COMMAND}（docfirst 件）在骨架上装配六区。哪个件没装就跳过那一步、回执里说怎么补，件那半照样落盘。参数不对会把完整说明回给你`,
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${SCAFFOLD_USAGE}` }
        const root = packageRoot()
        const templateRoot = root === null ? null : path.join(root, 'template')
        if (templateRoot === null || !fs.existsSync(templateRoot)) {
          return { ok: false, error: '包内 template/ 不在——这一版没把它带进包（files 白名单漏了），换一版' }
        }
        // 「想不想建站」与「建不建得成」是两件事：站件没装的时候连 README 里那段话都得
        // 改口，所以在渲染之前就把它定下来
        const wantDocs = args.docs !== false
        const canDocs = wantDocs && hasCommand(CREATE_SITE_COMMAND)
        let plan
        try {
          plan = planScaffold({
            name: typeof args.name === 'string' ? args.name : '',
            dir: typeof args.dir === 'string' ? args.dir : '',
            ...(typeof args.title === 'string' && args.title.trim() !== '' ? { title: args.title } : {}),
            docs: canDocs,
            ...(typeof args.port === 'number' ? { port: args.port } : {}),
          })
        } catch (err) {
          return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${SCAFFOLD_USAGE}` }
        }
        // 整套先在内存里渲染完才碰盘：目标目录一旦开始写就没有干净的回滚点
        let files
        try {
          files = renderTemplate(templateRoot, plan)
          writeRepo(plan.dir, files)
        } catch (err) {
          return { ok: false, error: `建仓没成：${err instanceof Error ? err.message : String(err)}` }
        }
        log.info(`devkit.scaffold：${plan.pkg} → ${path.join(plan.dir, 'plugins', plan.name)}（${files.length} 个文件）`)

        // ── 站那半：知识不在本包，两步都经总线转出去 ──────────────────────
        // **件那半已经在盘上了，站没建成不算建仓失败**——回执里说清楚，人补一条命令就是
        const docs = await buildDocsSite(plan)
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

  // ── 加件那半：往既有薄壳仓的 plugins/ 再铺一个件包 ─────────────────────────

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.scaffold.plugin',
        plugin: '@godcreator/gwb-devkit',
        description: '往既有薄壳仓的 plugins/ 再铺一个件包（同一份件包模板，不碰根壳与站）',
        usage:
          '{name 必给（kebab-case 短名，派生规则同 devkit.scaffold）, repo 必给（薄壳仓根绝对路径——pnpm-workspace.yaml 里得有 plugins/ 那条，老裸根单件仓报错里带迁移的路）, title?}。件包落在 <repo>/plugins/<短名>/，必须还不存在。与建仓落的是同一份件包模板（template/pkg/）——单多格式统一靠这个。参数不对会把完整说明回给你',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${SCAFFOLD_PLUGIN_USAGE}` }
        const root = packageRoot()
        const templateRoot = root === null ? null : path.join(root, 'template')
        if (templateRoot === null || !fs.existsSync(path.join(templateRoot, 'pkg'))) {
          return { ok: false, error: '包内 template/pkg/ 不在——这一版没把它带进包（files 白名单漏了），换一版' }
        }
        let plan
        try {
          plan = planScaffoldPlugin({
            name: typeof args.name === 'string' ? args.name : '',
            repo: typeof args.repo === 'string' ? args.repo : '',
            ...(typeof args.title === 'string' && args.title.trim() !== '' ? { title: args.title } : {}),
          })
        } catch (err) {
          return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n\n${SCAFFOLD_PLUGIN_USAGE}` }
        }
        // 与建仓同一条纪律：先在内存里渲染完，目标子目录必须还不存在
        let files
        try {
          files = renderPlugin(templateRoot, plan)
          writeRepo(plan.dir, files)
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
            nextSteps: nextStepsPlugin(plan),
          },
        }
      },
    ),
  )

  /** 站那半的回执 */
  interface DocsOutcome {
    /** 骨架铺没铺（`docs-site.create` 成没成） */
    built: boolean
    /** 六区装没装（`docfirst.attach` 成没成）。骨架都没铺时一定是 false */
    attached: boolean
    /** 站端口。站件挑的，铺成了才有 */
    port?: number
    note: string
    /** 两条命令各自的原始回执，出错时看这儿 */
    create?: unknown
    attach?: unknown
  }

  /**
   * 站那半。**建站是两步，都不是本包的知识**：
   *
   * 1. `docs-site.create`（站件）铺一个标准 fumadocs 骨架
   * 2. `docfirst.attach`（docfirst 件）在**刚铺好的**骨架上装配六区
   *
   * 两条都只按名字在总线上找，本包不依赖那两个件的任何包。**哪一步的件没装就停在那儿、
   * 说清怎么补**——建仓不因此失败，件那半早已落盘。
   *
   * 两条命令都认**站目录**（`<仓>/docs-site`），不是仓根。
   */
  async function buildDocsSite(plan: {
    dir: string
    title: string
    docs: boolean
    port: number | undefined
  }): Promise<DocsOutcome> {
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

    // ── 第二步：装六区 ──────────────────────────────────────────────────────
    // **只在刚铺好的骨架上装得了**（attach 自己守着这条）。这儿正是那个时刻：中间没人
    // 改过文件，所以整个覆盖是安全的
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

  // 说明书随件走：**只挂自己那份**。别人的说明书归提供那个能力的件自己挂——说明书是
  // 全局单一命名空间，代挂第二份撞名的那份直接不挂、只留一行警告，而撞掉的那份很可能
  // 是本包依赖树里那个旧版本，症状是 agent 照着一份过期手册干活还不报错。
  // 局部注入 = 可选依赖：skills 件不在，devkit 照常挂
  ctx.inject(['gwbSkills'], (scoped) => {
    scoped.effect(() => scoped.gwbSkills.register(new URL('../skills/', import.meta.url)))
  })

  // **就绪那句话现问总线，不手抄一份名单**：抄的那份改一条命令就过期，而它过期的样子是
  // 「日志里列着一条早就没有的命令」。`devkit.cdp` 那条经 gwbNodeCli 登记，它在不在这一行里
  // 取决于那个件有没有先挂上——列的是此刻真在总线上的，那正是这行字的全部价值
  const mine = commands
    .list()
    .filter((entry) => entry.plugin === 'devkit')
    .map((entry) => entry.name)
  log.info(
    `开发套件就绪（此刻在总线上的 ${String(mine.length)} 条：${mine.join('、')}；手册挂在本件 skills/ 下，只挂自己那份）`,
  )
}
