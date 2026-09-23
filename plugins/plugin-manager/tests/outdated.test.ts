import { describe, expect, it } from 'vitest'
import { parseOutdated } from '../src/outdated'

/**
 * `pnpm outdated --json` 的解析。形状是实测钉的（本机 pnpm，2026-09-08）：有过期包时
 * 退出码 1、stdout 按包名做键、每条带 current / latest / wanted / isDeprecated /
 * dependencyType；全都最新时退出码 0、stdout 为空。别的 pnpm 大版本形状未必一样——
 * 所以这儿钉的是「认得出的收下、认不出的整体回 undefined、单条缺字段只跳过那条」。
 */

const raw = (entries: Record<string, unknown>): string => JSON.stringify(entries)

describe('parseOutdated', () => {
  it('空串是「全都最新」，不是失败', () => {
    expect(parseOutdated('')).toEqual({})
    expect(parseOutdated('   \n')).toEqual({})
  })

  it('一份正经的表原样收下（用不着的字段不看）', () => {
    expect(
      parseOutdated(
        raw({
          '@godcreator/gwb-hello': {
            current: '0.0.13',
            latest: '0.0.19',
            wanted: '0.0.19',
            isDeprecated: false,
            dependencyType: 'dependencies',
          },
        }),
      ),
    ).toEqual({ '@godcreator/gwb-hello': { current: '0.0.13', latest: '0.0.19' } })
  })

  it('不是 JSON、是数组、是标量——整体回 undefined，让调用方给一句人话', () => {
    expect(parseOutdated('pnpm: internal error')).toBeUndefined()
    expect(parseOutdated('[{"current":"1"}]')).toBeUndefined()
    expect(parseOutdated('42')).toBeUndefined()
  })

  it('**单条缺 current 或 latest 只跳过那一条**，别的一律照收——形状漂移不该一票否决', () => {
    const got = parseOutdated(
      raw({
        a: { current: '1.0.0' },
        b: { latest: '2.0.0' },
        c: { current: '', latest: '2.0.0' },
        d: { current: 7, latest: '2.0.0' },
        e: 'not-an-object',
        f: { current: '1.0.0', latest: '2.0.0' },
      }),
    )
    expect(got).toEqual({ f: { current: '1.0.0', latest: '2.0.0' } })
  })
})
