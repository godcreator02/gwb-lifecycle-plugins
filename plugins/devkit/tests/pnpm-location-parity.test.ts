import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 找 pnpm 的规则在 devkit 与插件管理各存一份（不跨包 import），两份必须逐字相同：改了一份没改另一份，这条测试就失败。
 * 规则本身的测试在插件管理的 tests/pnpm-location.test.ts
 */
describe('devkit 与插件管理找 pnpm 的规则相同', () => {
  it('src/pnpm-location.ts 两份逐字相同', () => {
    const devkitCopy = fs.readFileSync(new URL('../src/pnpm-location.ts', import.meta.url), 'utf8')
    const pluginManagerCopy = fs.readFileSync(new URL('../../plugin-manager/src/pnpm-location.ts', import.meta.url), 'utf8')
    expect(devkitCopy).toBe(pluginManagerCopy)
  })
})
