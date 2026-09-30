import { describe, expect, it } from 'vitest'
import { parseConfigList, parseConfigValue } from '../src/pnpm-config.js'

/** pnpm 12.4 的 `config list --json` 与 `config get` 的输出，照实测写 */

describe('parseConfigList', () => {
  it('JSON 对象原样回', () => {
    expect(parseConfigList('{"@godcreator:registry":"https://g.example/npm/","registry":"https://registry.npmjs.org/"}\n')).toEqual({
      '@godcreator:registry': 'https://g.example/npm/',
      registry: 'https://registry.npmjs.org/',
    })
  })

  it('不是 JSON、不是对象：undefined', () => {
    expect(parseConfigList('registry=https://registry.npmjs.org/')).toBeUndefined()
    expect(parseConfigList('[1]')).toBeUndefined()
  })
})

describe('parseConfigValue', () => {
  it('没配时 pnpm 输出 undefined：当作没有', () => {
    expect(parseConfigValue('undefined\n')).toBeUndefined()
    expect(parseConfigValue('')).toBeUndefined()
  })

  it('配了就去掉结尾换行后原样回', () => {
    expect(parseConfigValue('t-secret\r\n')).toBe('t-secret')
  })
})
