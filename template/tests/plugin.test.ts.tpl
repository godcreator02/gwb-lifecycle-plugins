import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/index.js'
import type { GwbContext } from '@godcreator02/gwb-plugin-api'

/**
 * 起手的两条测试：件的身份对不对；挂载时窗格与命令是不是真的登记上了。
 *
 * 判据只有一条——**这段逻辑能不能不起进程、不开窗、只喂输入看输出**。能，就写在这儿；
 * 不能（要起子进程、要 Electron、要真装进 home），那不是不测，是走实机验证那条路。
 * 两者不互相替代：`pnpm check` 全绿从来不代表装出来能跑。
 */

/** 挂载时登记下来的东西 */
interface Harness {
  ctx: GwbContext
  panes: Array<{ id: string; title?: string; client?: string; style?: string }>
  commands: Array<{ name: string; description: string; plugin: string }>
}

/** 最小的 ctx 替身：logger、effect、两个服务各给一个记录器 */
function harness(): Harness {
  const panes: Harness['panes'] = []
  const commands: Harness['commands'] = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    // effect 立刻跑：挂载路径上的注册马上发生，测试好断言
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    gwbShell: { registerPane: (def: Harness['panes'][number]) => { panes.push(def) } },
    gwbCommands: {
      register: (def: Harness['commands'][number], _handler: unknown) => {
        commands.push(def)
        return () => {}
      },
    },
  } as unknown as GwbContext
  return { ctx, panes, commands }
}

describe('{{pkgName}}', () => {
  it('插件名跟包名派生自同一个短名', () => {
    expect(name).toBe('{{pkgName}}')
  })

  it('挂载时登记了一格窗格，浏览器半与样式表都报了地址', () => {
    const h = harness()
    apply(h.ctx)
    expect(h.panes).toHaveLength(1)
    expect(h.panes[0]?.id).toBe('main')
    expect(h.panes[0]?.client).toMatch(/^file:\/\/.+\/client\.js$/)
    expect(h.panes[0]?.style).toMatch(/^file:\/\/.+\/style\.css$/)
  })

  it('登记了一条 ping 命令：名字、归属与描述里的参数形状', () => {
    const h = harness()
    apply(h.ctx)
    expect(h.commands).toHaveLength(1)
    const cmd = h.commands[0]
    expect(cmd?.name).toBe('{{name}}.ping')
    expect(cmd?.plugin).toBe(name)
    // 描述必须写参数形状（无参数明写「无参数」）——这是命令面的家法
    expect(cmd?.description).toContain('无参数')
  })
})
