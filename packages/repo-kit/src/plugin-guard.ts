import type { GuardVt } from './vitest-context.js'

/**
 * 插件守卫：只查对任何插件都成立的结构，不查模板插件的具体形状（几个窗格、哪条命令）。
 * 这段逻辑不启动进程、不开窗口，只把 `apply` 放在替身上运行、看它注册了什么。
 *
 * 四条判据：
 *
 * 1. 导出的 `name` 等于 `pkgName`，`pkgName` 等于 `gwb-<short>`，`pkg` 以 `/<pkgName>` 结尾
 * 2. `apply` 在替身上运行不抛错
 * 3. 每条登记的命令：`name` 非空，`plugin` 等于包名，`description` 与 `usage` 非空
 *    （参数形状写在 `usage` 里，无参数写「无参数」）
 * 4. 每个注册的窗格：`id` 非空；给了 `client` 就是以 `.js` 结尾的 `file:` 地址，给了 `style`
 *    就是以 `.css` 结尾的 `file:` 地址
 *
 * 不查的两条：命令名以 `<short>.` 开头——说明书插件 `@godcreator/gwb-skills` 登记的是 `skill.list` /
 * `skill.read`，这条不对所有插件成立；`client` 指向的文件在构建产物里——测试里 `apply` 从 `src/`
 * 加载，按 `import.meta.url` 算出的地址落在 `src/` 下，而 `pnpm check` 不构建、`dist/` 可能不在。
 *
 * ctx 替身用本地的结构类型，不 import gwb-plugin-api——repo-kit 零依赖，
 * 使用方的仓里已经解析着那份类型。
 */

export interface PluginGuardOptions {
  /**
   * 被测插件的 `apply`（测试文件从 ../src/index.js import 进来）。参数类型是 `never`：各插件的
   * apply 把参数收窄成 GwbContext，`unknown` 在逆变下接收不了它们，模板生成的仓第一次 check
   * 就报 TS2322——`never` 是底类型，任何参数类型都能赋给它
   */
  apply: (ctx: never) => void
  /** 插件导出的名字：export const name */
  name: string
  /** 包名 @godcreator/gwb-<短名>——命令登记的 plugin 字段写它 */
  pkg: string
  /** 包名去掉 scope 的部分，gwb-<短名> */
  pkgName: string
  /** 短名 */
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
  description?: string
  usage?: string
  plugin: string
}

/**
 * 最小的 ctx 替身：logger、effect、inject，外加外壳与命令总线两个服务的记录器。
 * effect 立刻执行、inject 在点名的服务都在替身上时立刻回调：注册马上发生，测试好断言。
 * 导出给使用方——本仓特有的注册断言直接用它写，不用照抄一份。
 */
export function mountHarness(apply: (ctx: never) => void): { panes: PaneDef[]; commands: CommandDef[] } {
  const panes: PaneDef[] = []
  const commands: CommandDef[] = []
  const ctx: Record<string, unknown> = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    inject: (services: string[], callback: (scoped: unknown) => void) => {
      if (services.every((service) => service in ctx)) callback(ctx)
      return () => {}
    },
    gwbShell: {
      registerPane: (def: PaneDef) => {
        panes.push(def)
        return () => {}
      },
    },
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

function isFileUrlEndingWith(address: string, extension: string): boolean {
  if (!URL.canParse(address)) return false
  const url = new URL(address)
  return url.protocol === 'file:' && url.pathname.endsWith(extension)
}

export function registerPluginGuard(vt: GuardVt, options: PluginGuardOptions): void {
  vt.describe(options.pkgName, () => {
    vt.it('插件名、包名、短名三者对得上', () => {
      vt.expect(options.name, '导出的 name 要等于包名去掉 scope 的部分').toBe(options.pkgName)
      vt.expect(options.pkgName, 'pkgName 要是 gwb-<短名>').toBe(`gwb-${options.short}`)
      vt.expect(options.pkg.endsWith(`/${options.pkgName}`), `包名 ${options.pkg} 要以 /${options.pkgName} 结尾`).toBe(true)
    })

    vt.it('apply 在替身上运行不抛错', () => {
      mountHarness(options.apply)
    })

    vt.it('登记的每条命令：plugin 是包名，name、description、usage 非空', () => {
      for (const cmd of mountHarness(options.apply).commands) {
        const label = `命令 ${String(cmd.name)}`
        vt.expect(typeof cmd.name === 'string' && cmd.name !== '', '命令的 name 要是非空字符串').toBe(true)
        vt.expect(cmd.plugin, `${label} 的 plugin 要写包名`).toBe(options.pkg)
        vt.expect(typeof cmd.description === 'string' && cmd.description !== '', `${label} 的 description 要写一句话说它做什么`).toBe(true)
        vt.expect(typeof cmd.usage === 'string' && cmd.usage !== '', `${label} 的 usage 要写参数形状，无参数写「无参数」`).toBe(true)
      }
    })

    vt.it('注册的每个窗格：id 非空，client / style 是 file: 地址', () => {
      for (const pane of mountHarness(options.apply).panes) {
        const label = `窗格 ${String(pane.id)}`
        vt.expect(typeof pane.id === 'string' && pane.id !== '', '窗格的 id 要是非空字符串').toBe(true)
        if (pane.client !== undefined) {
          vt.expect(isFileUrlEndingWith(pane.client, '.js'), `${label} 的 client 要是以 .js 结尾的 file: 地址，收到 ${pane.client}`).toBe(true)
        }
        if (pane.style !== undefined) {
          vt.expect(isFileUrlEndingWith(pane.style, '.css'), `${label} 的 style 要是以 .css 结尾的 file: 地址，收到 ${pane.style}`).toBe(true)
        }
      }
    })
  })
}
