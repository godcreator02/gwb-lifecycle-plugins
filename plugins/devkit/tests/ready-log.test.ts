import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

/** devkit 自己的包名，从 package.json 读，和命令登记时写的 plugin 比对 */
const PACKAGE_NAME = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name

interface RegisteredCommand {
  name: string
  plugin: string
}

/** 挂载 devkit：命令总线记下登记的命令，list() 回它们；logger 记下 info 的每一行 */
function mountDevkit(): { commands: RegisteredCommand[]; infoLines: string[] } {
  const commands: RegisteredCommand[] = []
  const infoLines: string[] = []
  const ctx = {
    logger: () => ({ info: (line: string) => infoLines.push(line), warn() {}, error() {} }),
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    inject: () => {},
    gwbCommands: {
      register: (def: RegisteredCommand) => {
        commands.push({ name: def.name, plugin: def.plugin })
        return () => {}
      },
      list: () => commands,
    },
  }
  apply(ctx as never)
  return { commands, infoLines }
}

describe('就绪日志', () => {
  it('列出总线上 plugin 是本包包名的全部命令', () => {
    const { commands, infoLines } = mountDevkit()
    const mine = commands.filter((entry) => entry.plugin === PACKAGE_NAME)
    expect(mine.length).toBeGreaterThan(0)
    const ready = infoLines.find((line) => line.startsWith('开发套件就绪'))
    expect(ready).toContain(`此刻在总线上的 ${String(mine.length)} 条`)
    for (const entry of mine) expect(ready).toContain(entry.name)
  })
})
