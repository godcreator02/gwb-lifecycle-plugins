import type { GuardVt } from './vitest-context.js'

export interface PluginGuardOptions {
  /** 被测插件的 `apply`。参数写 `never`：各插件把参数收窄成 GwbContext，写 `unknown` 在逆变下接收不了（TS2322） */
  apply: (ctx: never) => void
  /** 插件导出的 `name` */
  name: string
  /** 包名 `@godcreator/gwb-<短名>`，命令登记的 `plugin` 字段写它 */
  pkg: string
  /** 包名去掉 scope 的部分，`gwb-<短名>` */
  pkgName: string
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

/** effect 立刻执行、inject 在点名的服务都在替身上时立刻回调，所以 `apply` 一返回，注册就都记下了 */
export function mountHarness(apply: (ctx: never) => void): { panes: PaneDef[]; commands: CommandDef[] } {
  const registeredPanes: PaneDef[] = []
  const registeredCommands: CommandDef[] = []
  const stubContext: Record<string, unknown> = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    inject: (serviceNames: string[], callback: (scopedContext: unknown) => void) => {
      if (serviceNames.every((serviceName) => serviceName in stubContext)) callback(stubContext)
      return () => {}
    },
    gwbShell: {
      registerPane: (def: PaneDef) => {
        registeredPanes.push(def)
        return () => {}
      },
    },
    gwbCommands: {
      register: (def: CommandDef, _handler: unknown) => {
        registeredCommands.push(def)
        return () => {}
      },
    },
  }
  apply(stubContext as never)
  return { panes: registeredPanes, commands: registeredCommands }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value !== ''
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
      for (const command of mountHarness(options.apply).commands) {
        const label = `命令 ${String(command.name)}`
        vt.expect(isNonEmptyString(command.name), '命令的 name 要是非空字符串').toBe(true)
        vt.expect(command.plugin, `${label} 的 plugin 要写包名`).toBe(options.pkg)
        vt.expect(isNonEmptyString(command.description), `${label} 的 description 要写一句话说它做什么`).toBe(true)
        vt.expect(isNonEmptyString(command.usage), `${label} 的 usage 要写参数形状，无参数写「无参数」`).toBe(true)
      }
    })

    vt.it('注册的每个窗格：id 非空，client / style 是 file: 地址', () => {
      for (const pane of mountHarness(options.apply).panes) {
        const label = `窗格 ${String(pane.id)}`
        vt.expect(isNonEmptyString(pane.id), '窗格的 id 要是非空字符串').toBe(true)
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
