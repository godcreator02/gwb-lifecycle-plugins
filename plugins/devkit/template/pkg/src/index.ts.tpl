import type { GwbContext } from '@godcreator/gwb-kernel-desktop'
// 空的类型 import 只为让两个包的 `declare module 'cordis'` 生效，ctx 上才有 gwbCommands / gwbShell 的类型
import type {} from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-shell'

/**
 * node 侧：一个窗格、一条 ping 命令，是模板插件的最小完整形状。
 * 每加一样东西都在隔离 home 里实际运行验证一次，见说明书「gwb-devkit」。
 */
export const name = '{{pkgName}}'

/** 浏览器侧脚本与样式表的地址，注册窗格时交给外壳。构建后它们和 index.js 在同一个 dist/ 目录，按本模块的地址算 */
const CLIENT_URL = new URL('./client.js', import.meta.url).href
const STYLE_URL = new URL('./style.css', import.meta.url).href

/** 两个服务都在，cordis 才调用 apply；任何一个重新加载，本插件跟着重新加载 */
export const inject = ['gwbCommands', 'gwbShell']

export function apply(ctx: GwbContext): void {
  // 日志用 ctx.logger：它的输出进日志窗格，console 的不进
  const log = ctx.logger(name)
  const shell = ctx.gwbShell
  const commands = ctx.gwbCommands
  // inject 已保证两个服务都在，这一行只为把可选类型收窄
  if (shell === undefined || commands === undefined) return
  log.info('{{name}} 已加载')

  // 外壳继承 cordis 的 Service：本插件卸载时，窗格自动注销。
  // 地址按 import.meta.url 算，内核不认识任何包名
  shell.registerPane({ id: 'main', title: '{{name}}', client: CLIENT_URL, style: STYLE_URL })

  // 命令是插件向页面和 agent 提供能力的方式。命令总线继承 cordis 的 Service：本插件卸载时，命令自动注销
  commands.register(
    {
      name: '{{name}}.ping',
      // description 一句话说命令做什么（MCP 入口的 index 列它），参数形状写进 usage（search 列它），无参数写「无参数」
      description: '模板自带的命令：返回插件名与当前时间，用来确认插件已加载',
      usage: '无参数',
      plugin: '{{pkg}}',
    },
    async () => ({ ok: true, data: { plugin: name, time: new Date().toISOString() } }),
  )
}
