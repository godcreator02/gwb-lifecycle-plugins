import fs from 'node:fs'
import path from 'node:path'
import type { GwbContext } from '@godcreator02/gwb-plugin-api'
import { isRecord, requireKernel } from '@godcreator02/gwb-plugin-api'
// 只为激活对方包里的 declare module 'cordis'——ctx 上那几个名字的类型从那儿来
import type {} from '@godcreator02/gwb-commands'
import type {} from '@godcreator02/gwb-settings'
import type {} from '@godcreator02/gwb-shell'
import type {} from '@godcreator02/gwb-skills'
import {
  DEFAULT_LOG_LINES,
  bringDown,
  bringUp,
  readLog,
  readStatus,
  type RegistryDeps,
} from './daemon.js'
import { kill, makeSpawn, nodeFs, ping, portOwner, processName } from './node-registry-deps.js'
import {
  appDirOf,
  asCdpPort,
  asHomeName,
  bringDownHome,
  buildPlan,
  type HomeDeps,
  launchHome,
  listHomes,
  nextName,
  removeHome,
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
 * 「插件源」窗格那半的地址，注册窗格时报给外壳。本模块住 `dist/index.js`，浏览器半是
 * `dist/client/index.js`（tsc 直出，零依赖，没有样式表要注）。
 */
const CLIENT_URL = new URL('./client/index.js', import.meta.url).href

/**
 * 开发套件。四件事，全 服务同一个理由——「在新文件夹里开发新件」这条路的地基：
 *
 * - **建仓**：`devkit.scaffold` 把一个新件的骨架落进一个新文件夹
 * - **手册**：`skills/gwb-devkit/SKILL.md` 随件分发，经 gwb-skills 挂载
 * - **源**：本机 Verdaccio 的起/停/状态/日志（`registry.*`），有一扇「插件源」窗格
 *   可视化（registry.status，10 秒一轮）
 * - **home**：测试 home 的开/列/重开/停/删（`devkit.home.*`）——实机验证那几步的
 *   命令化（一次验开一个新 home、清理放在开新那一刻）
 *
 * `apply` 里只剩接线；建仓的校验、渲染、落盘在 `scaffold.ts`；registry 的起停时序在
 * `daemon.ts`、home 的在 `home.ts`（两处皆纯机，可单测），真机器的盘与进程在
 * `node-registry-deps.ts` 与 `node-home-deps.ts`。
 */

/** `devkit.scaffold` 的参数说明。参数错的时候连它一起回——错误即文档 */
const SCAFFOLD_USAGE = [
  'devkit.scaffold 的参数：',
  // 规则从 NAME_RE 现取，不在这儿手抄一份——抄的那份必然跟真源漂开
  `  name   必给，短名，kebab-case（${String(NAME_RE)}）。它派生出包名 @godcreator02/gwb-<短名>、插件名 gwb-<短名>、命令名 <短名>.<动作> 的前半`,
  '  dir    必给，目标目录的绝对路径，必须还不存在（存在就拒，不覆盖任何东西）',
  '  title  可选，显示名，缺省用 name',
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
  '  devkit.home.new  { short 必给（kebab-case 短名），cdp?（调试口），skipBuild? }——开 <short>-<yyMMddHHmm> 的新 home，默认先 build 内核（产物不新就起＝验旧代码）',
  '  devkit.home.open { name 必给（完整 home 名），cdp? }——重开一个已有的 home，不 build',
  '  devkit.home.stop { name }——停 devkit 起的那个（按 home 里 devkit.json 的 pid，核对映像名再杀）',
  '  devkit.home.rm   { name，force? }——删一个 home；default 是日常那份，force 才删',
  '  devkit.home.list {}——列出 home 根下全部 home 与谁在跑',
  '例：{"short":"data"}、{"name":"data-2609081430"}',
].join('\n')

export function apply(ctx: GwbContext): void {
  const log = ctx.logger(name)
  const bus = ctx.gwbCommands
  if (bus === undefined) {
    // export const inject 在，理论上走不到这儿；走到就直说，别让命令面无声地空着
    log.warn('gwbCommands 服务不在（inject 没生效？）——命令一条没挂')
    return
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
      { name: 'registry.status', plugin: 'devkit', description: '查本机插件源：{running, url, port 由 url 看, pid, adopted, dir}' },
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
      { name: 'registry.up', plugin: 'devkit', description: '拉起本机插件源（已经在跑就直接接管），轮询 /-/ping 最多 30 秒' },
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
      { name: 'registry.down', plugin: 'devkit', description: '停本机插件源（按 pid 文件，核对映像名与端口持有者再杀）——这台机器上别的仓也在用它' },
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

  ctx.effect(() =>
    bus.register(
      { name: 'registry.log', plugin: 'devkit', description: `源的运行日志尾巴（默认最后 ${DEFAULT_LOG_LINES} 行）：{lines?}` },
      (args) => {
        const dir = dirOf()
        if (dir === undefined) return { ok: false, error: MISSING_DIR }
        const lines = isRecord(args) ? args.lines : undefined
        const want = typeof lines === 'number' && lines > 0 ? Math.floor(lines) : DEFAULT_LOG_LINES
        return { ok: true, data: readLog(dir, deps, want) }
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

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.home.new',
        plugin: 'devkit',
        description:
          '开一个测试 home：{short 必给（kebab-case），cdp?（调试口），skipBuild?}——名字长成 <short>-<yyMMddHHmm>，默认先 build 内核（产物不新就起＝验旧代码）。返回里带着现有 home 清单，开新那一刻正好清旧的',
      },
      async (args) => {
        const kernelDir = kernelDirOf()
        if (kernelDir === undefined) return { ok: false, error: MISSING_KERNEL_DIR }
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const short = asHomeName(args.short)
        if (short === undefined) return { ok: false, error: `short 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const cdp = args.cdp === undefined ? undefined : asCdpPort(args.cdp)
        if (args.cdp !== undefined && cdp === undefined) {
          return { ok: false, error: `cdp 要是 1–65535 的整数。\n${HOME_USAGE}` }
        }
        const root = homesRoot()
        let name: string
        try {
          name = nextName(short, homeDeps.now(), (candidate) => homeDeps.fs.exists(path.join(root, candidate)))
        } catch (err) {
          return { ok: false, error: String(err instanceof Error ? err.message : err) }
        }
        const outcome = await launchHome(
          {
            name,
            homesRoot: root,
            kernelDir,
            ...(cdp === undefined ? {} : { cdp }),
            ...(args.skipBuild === true ? {} : { build: buildPlan(appDirOf(kernelDir), homeDeps.platform) }),
          },
          homeDeps,
        )
        if (!outcome.ok) {
          log.warn(`home.new 没成：${outcome.error}`)
          return outcome
        }
        log.info(`devkit.home.new：${outcome.note}`)
        return { ok: true, data: { ...outcome, homes: await listHomes(root, homeDeps) } }
      },
    ),
  )

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.home.open',
        plugin: 'devkit',
        description: '重开一个已有的测试 home：{name 必给，cdp?}——不 build，人要亲自看一眼的那条路',
      },
      async (args) => {
        const kernelDir = kernelDirOf()
        if (kernelDir === undefined) return { ok: false, error: MISSING_KERNEL_DIR }
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const name = asHomeName(args.name)
        if (name === undefined) return { ok: false, error: `name 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const cdp = args.cdp === undefined ? undefined : asCdpPort(args.cdp)
        if (args.cdp !== undefined && cdp === undefined) {
          return { ok: false, error: `cdp 要是 1–65535 的整数。\n${HOME_USAGE}` }
        }
        const root = homesRoot()
        if (!homeDeps.fs.exists(path.join(root, name))) {
          return { ok: false, error: `${path.join(root, name)} 不在——没有这个 home（看 devkit.home.list）` }
        }
        const outcome = await launchHome(
          { name, homesRoot: root, kernelDir, ...(cdp === undefined ? {} : { cdp }) },
          homeDeps,
        )
        if (!outcome.ok) {
          log.warn(`home.open 没成：${outcome.error}`)
          return outcome
        }
        log.info(`devkit.home.open：${outcome.note}`)
        return { ok: true, data: outcome }
      },
    ),
  )

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.home.stop',
        plugin: 'devkit',
        description: '停一个 devkit 起的测试 home：{name}——按 home 里 devkit.json 的 pid，核对映像名（与记录过的 CDP 端口）再杀',
      },
      async (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${HOME_USAGE}` }
        const name = asHomeName(args.name)
        if (name === undefined) return { ok: false, error: `name 缺了或不是 kebab-case。\n${HOME_USAGE}` }
        const outcome = await bringDownHome(path.join(homesRoot(), name), homeDeps)
        if (outcome.ok) log.info(`devkit.home.stop：${outcome.note}`)
        else log.warn(`devkit.home.stop 没成：${outcome.note}`)
        return outcome.ok ? { ok: true, data: outcome } : { ok: false, error: outcome.note }
      },
    ),
  )

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.home.rm',
        plugin: 'devkit',
        description: '删一个测试 home：{name，force?}——还在跑的拒删（先 stop）；default 是日常那份，force 才删',
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
      { name: 'devkit.home.list', plugin: 'devkit', description: '列出 home 根下全部测试 home：名字（带时间戳）、谁还在跑、CDP 口' },
      async () => {
        const root = homesRoot()
        return { ok: true, data: { root, homes: await listHomes(root, homeDeps) } }
      },
    ),
  )

  // 插件源窗格：registry 状态的可视面，身体住本件 client 的 mountPane（原先是状态件
  // 的一颗格子，状态格机制 2026-09-08 下架后改开普通窗格）。注册不用自己包 effect。
  // **浏览器半的地址自报**：内核不再替件取货，注册时把 client.js 的 file:// 交出去
  ctx.inject(['gwbShell'], (scoped) => {
    scoped.gwbShell.registerPane({ id: 'registry', title: '插件源', icon: 'server', client: CLIENT_URL })
    // 给人看的名字（件清单里显示用）。外壳不在就算了，那半本来就不是它的脸
    scoped.gwbShell.describeSelf({ title: '开发套件', icon: 'wrench' })
  })

  // ── 建仓那半 ───────────────────────────────────────────────────────────────

  ctx.effect(() =>
    bus.register(
      {
        name: 'devkit.scaffold',
        plugin: 'devkit',
        description: '把一个新 gwb 件的骨架落进一个新文件夹：{name（必给，kebab-case 短名）, dir（必给，绝对路径且必须还不存在）, title?}。参数不对会把完整说明回给你',
      },
      (args) => {
        if (!isRecord(args)) return { ok: false, error: `参数要是个对象。\n${SCAFFOLD_USAGE}` }
        const root = packageRoot()
        const templateRoot = root === null ? null : path.join(root, 'template')
        if (templateRoot === null || !fs.existsSync(templateRoot)) {
          return { ok: false, error: '包内 template/ 不在——这一版没把它带进包（files 白名单漏了），换一版' }
        }
        let plan
        try {
          plan = planScaffold({
            name: typeof args.name === 'string' ? args.name : '',
            dir: typeof args.dir === 'string' ? args.dir : '',
            ...(typeof args.title === 'string' && args.title.trim() !== '' ? { title: args.title } : {}),
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
        return {
          ok: true,
          data: {
            repoDir: plan.dir,
            pkg: plan.pkg,
            name: plan.name,
            title: plan.title,
            files: files.length,
            nextSteps: nextSteps(plan),
          },
        }
      },
    ),
  )

  // 说明书随件走。局部注入 = 可选依赖：skills 件不在，devkit 照常挂
  ctx.inject(['gwbSkills'], (scoped) => {
    scoped.effect(() => scoped.gwbSkills.register(new URL('../skills/', import.meta.url)))
  })

  log.info(
    '开发套件就绪（devkit.scaffold、registry.status/up/down/log、devkit.home.new/list/open/stop/rm 经命令总线；手册挂在本件 skills/ 下）',
  )
}
