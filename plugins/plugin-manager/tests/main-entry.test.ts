import { describe, expect, it } from 'vitest'

describe('主入口', () => {
  it('只导出插件本身（name、apply）与 devkit 复用的几样：找 pnpm、在 home 里启动 pnpm 用的环境、内核包名、peer 范围写法的判定、取输出最后几行、devkit.dev 调的三条命令名', async () => {
    const main = await import('../src/index.js')
    expect(Object.keys(main).sort()).toEqual(
      ['INSTALL_COMMAND', 'KERNEL_PACKAGE', 'LIST_COMMAND', 'UPDATE_COMMAND', 'apply', 'homePnpmEnv', 'isCaretRange', 'locatePnpm', 'name', 'tailLines'].sort(),
    )
  })
})
