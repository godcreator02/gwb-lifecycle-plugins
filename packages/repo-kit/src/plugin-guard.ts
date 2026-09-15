import type { GuardVt } from './vitest-context.js'

/**
 * 件的身份与挂载登记：名字跟包名同源；apply 时窗格与命令真的登记上了。
 * 判据只有一条——这段逻辑不起进程、不开窗、只喂输入看输出。正本自模板
 * tests/plugin.test.ts.tpl 迁来（2026-09-15）。
 *
 * ctx 替身用结构本地类型，不 import gwb-plugin-api——repo-kit 零依赖，
 * 消费仓自己已经解析着那份类型。
 */

export interface PluginGuardOptions {
  /**
   * 被测件的挂载函数（薄壳从 ../src/index.js import 进来）。参数收 `never`：消费仓的
   * apply 各自把参数收窄成 GwbContext，`unknown` 那个形状在逆变下收不下它们，模板
   * 开箱 check 就红（TS2322）——`never` 是底线类型，谁的参数都装得下
   */
  apply: (ctx: never) => void
  /** 件自报的名字：export const name */
  name: string
  /** 包名 @godcreator/gwb-<短名>——命令登记的 plugin 字段认它（commands 0.4 起的规范） */
  pkg: string
  /** 包名派生的插件名，gwb-<短名> */
  pkgName: string
  /** 短名：命令前缀 <短名>.<动作> */
  short: string
}

interface PaneDef {
  id: string
  title?: string
  client?: string
  style?: string
}

interface CommandDef {
  name: string
  description: string
  plugin: string
}

/**
 * 最小的 ctx 替身：logger、effect、两个服务各给一个记录器。
 * effect 立刻跑：挂载路径上的注册马上发生，测试好断言。
 * 导出给消费仓用——本仓特有的挂载断言别抄正本，直接拿它写。
 */
export function mountHarness(apply: (ctx: never) => void): { panes: PaneDef[]; commands: CommandDef[] } {
  const panes: PaneDef[] = []
  const commands: CommandDef[] = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    gwbShell: { registerPane: (def: PaneDef) => { panes.push(def) } },
    gwbCommands: {
      register: (def: CommandDef, _handler: unknown) => {
        commands.push(def)
        return () => {}
      },
    },
  }
  apply(ctx as never)
  return { panes, commands }
}

export function registerPluginGuard(vt: GuardVt, options: PluginGuardOptions): void {
  vt.describe(options.pkgName, () => {
    vt.it('插件名跟包名派生自同一个短名', () => {
      vt.expect(options.name).toBe(options.pkgName)
    })

    vt.it('挂载时登记了一格窗格，浏览器半与样式表都报了地址', () => {
      const h = mountHarness(options.apply)
      vt.expect(h.panes).toHaveLength(1)
      vt.expect(h.panes[0]?.id).toBe('main')
      vt.expect(h.panes[0]?.client).toMatch(/^file:\/\/.+\/client\.js$/)
      vt.expect(h.panes[0]?.style).toMatch(/^file:\/\/.+\/style\.css$/)
    })

    vt.it('登记了一条 ping 命令：名字、归属与描述里的参数形状', () => {
      const h = mountHarness(options.apply)
      vt.expect(h.commands).toHaveLength(1)
      const cmd = h.commands[0]
      vt.expect(cmd?.name).toBe(`${options.short}.ping`)
      vt.expect(cmd?.plugin).toBe(options.pkg)
      // 描述必须写参数形状（无参数明写「无参数」）——这是命令面的家法
      vt.expect(cmd?.description).toContain('无参数')
    })
  })
}
