import { describe, expect, it } from 'vitest'
import { isMinimumVersion as devkitIsMinimumVersion } from '../src/release.js'
import { isMinimumVersion as pluginManagerIsMinimumVersion } from '../../plugin-manager/src/requires.js'

/**
 * `gwb.requires` 里合法最低版本号的判法在 devkit（发版前拒）与插件管理（list 里算没满足）各存一份（不跨包 import）。
 * 这里拿同一组输入跑两份，结果必须相同：发得出去的声明，插件管理必须认得。
 */

const VALUES = ['0.5.0', '0.0.1', '1.2.3', '10.20.30', '', '0.5', '^0.5.0', '~0.5.0', 'v0.5.0', '0.5.0-rc.1', '0.5.0+build', '01.5.0', '0.05.0', 'latest', '0.5.x']

describe('devkit 与插件管理对 gwb.requires 最低版本号的判法相同', () => {
  it('isMinimumVersion：同一组字符串得到同样的结论', () => {
    for (const value of VALUES) {
      expect(devkitIsMinimumVersion(value), value).toBe(pluginManagerIsMinimumVersion(value))
    }
  })
})
