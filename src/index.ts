import fs from 'node:fs'
import path from 'node:path'
import type { GwbContext } from '@godcreator02/gwb-plugin-api'
import { isRecord, requireKernel } from '@godcreator02/gwb-plugin-api'
// 只为激活对方包里的 declare module 'cordis'——ctx 上那几个名字的类型从那儿来
import type {} from '@godcreator02/gwb-commands'
import type {} from '@godcreator02/gwb-node-cli'
import type {} from '@godcreator02/gwb-settings'
import type {} from '@godcreator02/gwb-shell'
import type {} from '@godcreator02/gwb-skills'
import {
  bringDown,
  bringUp,
  readStatus,
  type RegistryDeps,
} from './daemon.js'
import { kill, makeSpawn, nodeFs, ping, portOwner, processName } from './node-registry-deps.js'
import { DEFAULT_REGISTRY, type DevInput, runDev } from './dev.js'
import { CDP_ENTRY, devDeps } from './node-dev-deps.js'
import {
  appDirOf,
  asHomeName,
  buildPlan,
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
import { homeFs, makeGuiSpawn, runCaptured } from './node-home-deps.js'
import {
  NAME_RE,
  nextSteps,
  packageRoot,
  planScaffold,
  renderTemplate,
  writeRepo,
} from './scaffold.js'

export const name = 'gwb-devkit'
export const inject = ['gwbCommands']

/**
 * 铺 fumadocs 骨架那条命令，由**站件** `@godcreator02/gwb-docs-site` 提供。
 *
 * **本包不依赖它**——只在命令总线上按名字找。找不到就是这个 home 没装站件，跳过铺站、
 * 在回执里说清怎么补，绝不因此让建仓失败。
 */
const CREATE_SITE_COMMAND = 'docs-site.create'

/**
 * 在骨架上装配六区那条命令，由 **docfirst 件** `@godcreator02/gwb-docfirst-workflow` 提供。
 * 同样只认名字、不依赖包。**只在刚铺好的骨架上装得了**：站里已经有内容它会自己拒。
 */
const ATTACH_SITE_COMMAND = 'docfirst.attach'

/**
 * 开发套件。五件事，全服务同一个理由——「在新文件夹里开发新件」这条路的地基：
 *
 * - **建仓**：`devkit.scaffold` 把一个新件的骨架落进一个新文件夹（站那半经命令总线
 *   转给站件与 docfirst 件，两步）
 * - **手册**：`skills/gwb-devkit/SKILL.md` 随件分发，经 gwb-skills 挂载。**只挂自己那份**
 *   ——知识随件走，docfirst 的两份归 docfirst 件自己挂（说明书是全局单一命名空间，
 *   代挂第二份只会撞名，而且撞掉的那份很可能是旧版）
 * - **源**：本机 Verdaccio 的起/停/状态（`registry.*`）。工作台没起时同一份逻辑还有
 *   一个命令行入口，包内 `bin/registry.mjs`——一份实现，两个入口
 * - **home**：测试 home 的开/列/重开/删（`devkit.home.*`）——实机验证那几步的
 *   命令化（一次验开一个新 home、清理放在开新那一刻）
 *
 * - **改一版看一版**：`devkit.dev` 一条走完「构建 → 发开发版 → 装进隔离 home → 重挂 →
 *   刷新 → 取证」。**这条命令住控制台那个 home，操作另一个 home**：换件那一步要把条目
 *   停用再启用，工具自己跑在目标里就会把自己停掉
 *
 * 外加一条经 `gwbNodeCli` 登记的外部 CLI：`devkit.cdp`（在一个工作台页面里动手，
 * 从取证到点按拖拽都是它；`eval` 是它的一个动词，退役的 `devkit.cdp-eval` 是它的祖先）。
 *
 * `apply` 里只剩接线；建仓的校验、渲染、落盘在 `scaffold.ts`；registry 的起停时序在
 * `daemon.ts`、home 的在 `home.ts`、改一版看一版那条链在 `dev.ts`（皆纯机，可单测），
 * 真机器的盘与进程在 `node-registry-deps.ts` / `node-home-deps.ts` / `node-dev-deps.ts`。
 */

/** `devkit.scaffold` 的参数说明。参数错的时候连它一起回——错误即文档 */
const SCAFFOLD_USAGE = [
  'devkit.scaffold 的参数：',
  // 规则从 NAME_RE 现取，不在这儿手抄一份——抄的那份必然跟真源漂开
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。它派生出包名 @godcreator02/gwb-<短名>、插件名 gwb-<短名>、命令名 <短名>.<动作> 的前半`,
  '  dir    必给，目标目录的绝对路径，必须还不存在（存在就拒，不覆盖任何东西）',
  '  title  可选，显示名，缺省用 name',
  `  docs   可选，缺省 true——件那半落盘之后顺带建站，两步：${CREATE_SITE_COMMAND} 铺 fumadocs 骨架、${ATTACH_SITE_COMMAND} 在骨架上装配六区。两条都经命令总线找，没装那个件就跳过那一步（回执里说怎么补），不算建仓失败。false 就只建件那半`,
  '  port   可选，文档站端口。不给由站件自己挑（扫邻居已占的，从 4310 起找空位）',
  '例：{"name":"hello","dir":"D:\\\\tmp\\\\hello","title":"打个招呼"}',
].join('\n')

/** 未配置 registry-dir 时回的那句话 */
const MISSING_DIR =
  '未配置 registry-dir——到「设置」给开发套件填 registry-dir：那个含 config.yaml、storage、node_modules/verdaccio 的 Verdaccio 目录'

/** 未配置 kernel-dir 时回的那句话 */
const MISSING_KERNEL_DIR =
  '未配置 kernel-dir——到「设置」给开发套件填 kernel-dir：内核仓的根（那个含 apps/desktop 的目录）。home 的开与重开用它，列/停/删不用'

/** home 命令的参数说明。参数错的时候连它一起回——错误即文档 */
const HOME_USAGE = [
  'home 命令的参数：',
  '  devkit.home.new  { short 必给（kebab-case 短名） }——开 <short>-<yyMMddHHmm> 的新 home。先 build 内核，调试口自动挑',
  '  devkit.home.open { name 必给（完整 home 名） }——重开一个已有的 home，不 build。机器重启之后回到现场走这条',
  '  devkit.home.rm   { name，force? }——删一个 home。没在跑的直接删；还在跑的要 force（连停带删）',
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
  '例：{"home":"bn-2609111200","dir":"D:\\\\unitfolders\\\\26090814otr\\\\gwb-block-note","packages":["packages/model","plugins/gwb-bn-core"]}',
  '目标 home 是 default、或者就是本件自己住的那个，都当场拒——前者会把开发版塞进日常那份，',
  '后者停用条目那一下会把正在跑的这条命令自己停掉。换 devkit 自己：发正式版，再 plugins.update-all',
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

  // ── registry 那半 ──────────────────────────────────────────────────────────

  /**
   * 本次会话起的那个 pid。只在内存里、不落盘：它回答「这个 registry 是不是我这次起的」，
   * 宿主一重启答案就该变回「接管来的」，那正是实情。
   */
  let ownPid: number | undefined

  const deps: RegistryDeps = {
    fs: nodeFs,
    spawn: makeSpawn((message) => log.warn(message)),
    ping,
    processName,
    portOwner,
    kill,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    execPath: process.execPath,
    env: process.env,
  }

  let settings: { get(key: string): unknown } | undefined

  ctx.inject(['gwbSettings'], (scoped) => {
    scoped.gwbSettings.define({
      key: 'registry-dir',
      title: '本机插件源目录',
      type: 'string',
      description: 'Verdaccio 目录（含 config.yaml、storage、node_modules/verdaccio）。registry 的起/停/状态/日志都用它；不填这半不工作',
    })
    scoped.gwbSettings.define({
      key: 'kernel-dir',
      title: '内核仓根目录',
      type: 'string',
      description: 'gwb-kernel 仓的根（含 apps/desktop）。home 的开与重开用它定位 build 与 electron；不填那两条命令不工作',
    })
    settings = scoped.gwbSettings
  })

  /** 设置里那个目录。**不给默认值**：目录是这台机器的事实，编一个只会是「配置了但不在」的假象 */
  function dirOf(): string | undefined {
    const raw = settings?.get('registry-dir')
    const dir = typeof raw === 'string' ? raw.trim() : ''
    return dir === '' ? undefined : path.resolve(dir)
  }

  /** 设置里那个内核仓根。不给默认值的道理同 dirOf */
  function kernelDirOf(): string | undefined {
    const raw = settings?.get('kernel-dir')
    const dir = typeof raw === 'string' ? raw.trim() : ''
    return dir === '' ? undefined : path.resolve(dir)
  }

  ctx.effect(() =>
    bus.register(
      { name: 'registry.status', plugin: name, description: '查本机插件源。无参数。回执 {running, url（端口从 url 看）, pid, adopted, dir}' },
      async () => {
        const dir = dirOf()
        if (dir === undefined) return { ok: false, error: MISSING_DIR }
        const status = await readStatus(dir, deps, ownPid)
        return { ok: true, data: status }
      },
    ),
  )

  ctx.effect(() =>
    bus.register(
      { name: 'registry.up', plugin: name, description: '拉起本机插件源（已经在跑就直接接管），轮询 /-/ping 最多 30 秒。无参数' },
      async () => {
        const dir = dirOf()
        if (dir === undefined) return { ok: false, error: MISSING_DIR }
        const outcome = await bringUp(dir, deps, ownPid)
        if (!outcome.ok) {
          log.warn(`registry.up 没成：${outcome.error}`)
          return { ok: false, error: outcome.error }
        }
        if (outcome.started) ownPid = outcome.status.pid ?? undefined
        log.info(`registry.up：${outcome.note}`)
        return { ok: true, data: { ...outcome.status, note: outcome.note } }
      },
    ),
  )

  ctx.effect(() =>
    bus.register(
      { name: 'registry.down', plugin: name, description: '停本机插件源（按 pid 文件，核对映像名与端口持有者再杀）——这台机器上别的仓也在用它。无参数' },
      async () => {
        const dir = dirOf()
        if (dir === undefined) return { ok: false, error: MISSING_DIR }
        const outcome = await bringDown(dir, deps)
        // 停完这个 pid 就不是「我们起的那个」了，留着会让下一次状态把别人起的算成自己的
        if (outcome.killed !== null && outcome.killed === ownPid) ownPid = undefined
        // 没停成得当成失败回：跑着的源跟已停的源混成一句话，人会转头去查别的
        if (!outcome.ok) {
          log.warn(`registry.down 没成：${outcome.note}`)
          return { ok: false, error: outcome.note }
        }
        log.info(`registry.down：${outcome.note}`)
        return { ok: true, data: { ...outcome, status: await readStatus(dir, deps, ownPid) } }
      },
    ),
  )

  // ── home 那半 ──────────────────────────────────────────────────────────────

  const homeDeps: HomeDeps = {
    fs: homeFs,
    spawn: makeGuiSpawn((message) => log.warn(message)),
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
        plugin: name,
        description:
          '开一个测试 home：{short 必给（kebab-case）}——名字长成 <short>-<yyMMddHHmm>，先 build 内核（产物不新就起＝验旧代码），调试口自动挑一个空的。返回里带着现有 home 清单，开新那一刻正好清旧的',
      },
      async (args) => {
        const kernelDir = kernelDirOf()
        if (kernelDir === undefined) return { ok: false, error: MISSING_KERNEL_DIR }
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
        // **build 不可跳过**：产物不新就起等于验旧代码，而屏幕上一切正常
        const outcome = await launchHome(
          {
            name,
            homesRoot: root,
            kernelDir,
            cdp: port.cdp,
            build: buildPlan(appDirOf(kernelDir), homeDeps.platform),
          },
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
    bus.register(
      {
        name: 'devkit.home.open',
        plugin: name,
        description: '重开一个已有的测试 home：{name 必给}——不 build，调试口自动挑。机器重启之后回到原来那个现场只有这一条路（home.new 永远造新目录，件得全部重装一遍）',
      },
      async (args) => {
        const kernelDir = kernelDirOf()
        if (kernelDir === undefined) return { ok: false, error: MISSING_KERNEL_DIR }
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
          { name, homesRoot: root, kernelDir, cdp: port.cdp },
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
        plugin: name,
        description:
          '删一个测试 home：{name，force?}——没在跑的直接删；**还在跑的要 force**，那时连停带删（按它 runtime.json 里的 pid，核对映像名与记录里那个 CDP 端口再杀）。default 是日常那份：不 force 不删，而且它在跑的时候 force 也不删，自己关掉那扇窗再来',
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
      { name: 'devkit.home.list', plugin: name, description: '列出 home 根下全部测试 home：名字（带时间戳）、谁还在跑、CDP 口、MCP 口。无参数' },
      async () => {
        const root = homesRoot()
        return { ok: true, data: { root, homes: await listHomes(root, homeDeps) } }
      },
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
      description:
        '在一个工作台页面里动手：{"args":["<home 名>","<动作>","<参数…>"]}。**第一个位置只收 home 名，给数字当场拒**——口从那个 home 的 runtime.json 里查，连上之后还拿页面自报的名字核对一次。动作 eval <文件> [JSON 参数] / shot [图.png] [选择器] / move / click / rclick / drag / type / key / scroll <点> / cmd <命令名> [JSON 参数] / reload [选择器] [秒] / home。点写成 .sel、.sel@=文字、.a@=文字 >> .b，或 x,y。开关 --target / --mod / --pad / --size / --timeout。**只对隔离 home 用，绝不打 default**：这儿发的是真操作。够不着的 home 是起的时候没带 --remote-debugging-port，停掉重开一次',
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
        plugin: name,
        description:
          '改一版看一版：{home 必给（目标 home 名，**只认名字不认端口**——口从它的 runtime.json 里查并验活）, dir 必给（仓根绝对路径）, packages?（包目录，相对仓根，按依赖顺序；不给就是仓根自己）, waitFor?（刷新后等这个选择器出现）}。一条走完：仓根 pnpm build → 发开发版（<patch+1>-dev.<戳>，标 dev 不动 latest）→ 在目标 home 里 pnpm add 那个准确号 → 条目停用再启用重挂 → 整页重载 → 取证（条目真 ACTIVE、日志增量里没有 error），取不到证就回 ok:false。**构建与源都不可给**：跳过构建就是发上一版，而这台机器只有一个源。**目标是 default 或本件自己所在的 home 都当场拒；页面自报的名字跟你给的对不上也拒**',
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

  // ── 建仓那半 ───────────────────────────────────────────────────────────────

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.scaffold',
        plugin: name,
        description:
          `把一个新 gwb 件的骨架落进一个新文件夹，默认连文档站一起建：{name（必给，kebab-case 短名）, dir（必给，绝对路径且必须还不存在）, title?, docs?（缺省 true）, port?}。件那半的模板在本包；站那半是两步，都经命令总线转出去——${CREATE_SITE_COMMAND}（站件）铺 fumadocs 骨架，${ATTACH_SITE_COMMAND}（docfirst 件）在骨架上装配六区。哪个件没装就跳过那一步、回执里说怎么补，件那半照样落盘。参数不对会把完整说明回给你`,
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
        log.info(`devkit.scaffold：${plan.pkg} → ${plan.dir}（${files.length} 个文件）`)

        // ── 站那半：知识不在本包，两步都经总线转出去 ──────────────────────
        // **件那半已经在盘上了，站没建成不算建仓失败**——回执里说清楚，人补一条命令就是
        const docs = await buildDocsSite(plan)
        return {
          ok: true,
          data: {
            repoDir: plan.dir,
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
          : `没建站：这个 home 没装站件（命令总线上没有 ${CREATE_SITE_COMMAND}）。件那半已经落盘了——装上 @godcreator02/gwb-docs-site（plugins.install）之后自己补两步：${CREATE_SITE_COMMAND} {"dir":"${siteDir}","title":"${plan.title}"} 铺骨架，再 ${attachHint} 装六区`,
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
        note: `骨架铺好了，六区没装：这个 home 没装 docfirst 件（命令总线上没有 ${ATTACH_SITE_COMMAND}）。装上 @godcreator02/gwb-docfirst-workflow 之后**立刻**跑 ${attachHint}——它只在还没写过内容的骨架上装得了，往里写过东西就得人工接线`,
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
