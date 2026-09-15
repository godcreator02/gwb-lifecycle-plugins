import type { GwbContext } from '@godcreator/gwb-plugin-api'
// 只为激活那两个件的 `declare module 'cordis'`——它们给 ctx 加上 gwbCommands / gwbShell
import type {} from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-shell'

/**
 * node 半：挂上、一格窗格、一条 ping 命令——模板插件的最小完整形状。
 * 每往里加东西都实机验一次，见 skill「gwb-devkit」。
 */
export const name = '{{pkgName}}'

/** 浏览器半与样式表的地址，注册窗格时报给外壳。dist/ 下它们与 index.js 是邻居，从本模块算 */
const CLIENT_URL = new URL('./client.js', import.meta.url).href
const STYLE_URL = new URL('./style.css', import.meta.url).href

/** 缺哪个都不挂——inject 是 cordis 的等待机制，不是建议 */
export const inject = ['gwbCommands', 'gwbShell']

export function apply(ctx: GwbContext): void {
  // 件说话的正规出口：logger 进得了日志窗格，console 进不了
  const log = ctx.logger(name)
  const shell = ctx.gwbShell
  const commands = ctx.gwbCommands
  // inject 保证了它们在，这两句只是把类型收窄
  if (shell === undefined || commands === undefined) return
  log.info('{{title}} 起来了')

  // 注册窗格：同步动作，卸载时自动从表上摘掉，不用自己包 effect。
  // 地址从 import.meta.url 算——内核不认识任何包名、角色名、导出名
  shell.registerPane({ id: 'main', title: '{{title}}', client: CLIENT_URL, style: STYLE_URL })

  // 命令面：件与外界（界面、agent）的交互口。register 回注销函数，要包 ctx.effect——
  // 不包的话条目停了、fiber 灭了，名字还留在表上（2026-09-09 撞过）
  ctx.effect(() =>
    commands.register(
      {
        name: '{{name}}.ping',
        description: '模板起手命令：回插件名与时刻，证明这个件活着。无参数',
        plugin: name,
      },
      async () => ({ ok: true, data: { plugin: name, time: new Date().toISOString() } }),
    ),
  )
}
