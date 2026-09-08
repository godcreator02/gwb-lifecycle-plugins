import fs from 'node:fs'
import path from 'node:path'
import type { GwbContext } from '@godcreator02/gwb-plugin-api'
import { isRecord } from '@godcreator02/gwb-plugin-api'
// 只为激活对方包里的 declare module 'cordis'——ctx 上那几个名字的类型从那儿来
import type {} from '@godcreator02/gwb-commands'
import type {} from '@godcreator02/gwb-settings'
import type {} from '@godcreator02/gwb-shell'
import type {} from '@godcreator02/gwb-skills'
import type {} from '@godcreator02/gwb-status'
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
 * 开发套件。三件事，全 服务同一个理由——「在新文件夹里开发新件」这条路的地基：
 *
 * - **建仓**：`devkit.scaffold` 把一个新件的骨架落进一个新文件夹
 * - **手册**：`skills/gwb-devkit/SKILL.md` 随件分发，经 gwb-skills 挂载
 * - **源**：本机 Verdaccio 的起/停/状态/日志（`registry.*`），状态在 gwb-status 的
 *   格子墙上有一颗「插件源」格
 *
 * `apply` 里只剩接线；建仓的校验、渲染、落盘在 `scaffold.ts`，起停时序在 `daemon.ts`
 * （纯机，可单测），真机器的盘与进程在 `node-registry-deps.ts`。
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
    settings = scoped.gwbSettings
  })

  /** 设置里那个目录。**不给默认值**：目录是这台机器的事实，编一个只会是「配置了但不在」的假象 */
  function dirOf(): string | undefined {
    const raw = settings?.get('registry-dir')
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

  // 状态格子：身份由 gwb-status 从 fiber 取，件卸载自动摘，不用自己包 effect
  ctx.inject(['gwbStatus'], (scoped) => {
    scoped.gwbStatus.registerCell({ id: 'registry', title: '插件源', size: 'lg' })
  })

  // 给人看的名字（件清单里显示用）。外壳不在就算了，那半本来就不是它的脸
  ctx.inject(['gwbShell'], (scoped) => {
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

  log.info('开发套件就绪（devkit.scaffold 与 registry.status/up/down/log 经命令总线；手册挂在本件 skills/ 下）')
}
