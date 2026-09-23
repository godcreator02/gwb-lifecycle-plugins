import { describe, expect, it } from 'vitest'
import { parsePeerCheck } from '../src/peer-warnings.js'
import { describeAddFailure } from '../src/pnpm.js'

/** pnpm 12.4.2 `peers check --json` 的原样输出（probes/2609181422_peer-warnings/runs/a-conflict.3-peers-json.stdout.txt） */
const CONFLICT = `{
  ".": {
    "bad": {
      "@godcreator/gwb-shell": [
        {
          "parents": [
            {
              "name": "@godcreator/gwb-glm-quota",
              "version": "0.1.2"
            }
          ],
          "optional": false,
          "wantedRange": ">=0.8.0",
          "foundVersion": "0.7.2",
          "resolvedFrom": []
        }
      ]
    },
    "missing": {},
    "conflicts": [],
    "intersections": {}
  }
}
`

/** 同一版没问题时（b-clean.3-peers-json.stdout.txt） */
const CLEAN = `{
  ".": {
    "bad": {},
    "missing": {},
    "conflicts": [],
    "intersections": {}
  }
}
`

describe('读 pnpm peers check --json', () => {
  it('bad 一条：peer、home 里那一版、要的范围、谁要', () => {
    expect(parsePeerCheck(CONFLICT)).toEqual([
      { peer: '@godcreator/gwb-shell', installed: '0.7.2', wanted: '>=0.8.0', by: '@godcreator/gwb-glm-quota@0.1.2' },
    ])
  })

  it('没问题是空数组', () => {
    expect(parsePeerCheck(CLEAN)).toEqual([])
  })

  it('missing 没有 installed；可选的不算', () => {
    const out = parsePeerCheck(
      JSON.stringify({
        '.': {
          missing: {
            a: [{ parents: [{ name: 'x', version: '1.0.0' }, { name: 'y', version: '2.0.0' }], wantedRange: '^1.0.0', optional: false }],
            b: [{ parents: [{ name: 'x', version: '1.0.0' }], wantedRange: '*', optional: true }],
          },
        },
      }),
    )
    expect(out).toEqual([{ peer: 'a', wanted: '^1.0.0', by: 'x@1.0.0 > y@2.0.0' }])
  })

  it('认不出来回 undefined', () => {
    expect(parsePeerCheck('')).toBeUndefined()
    expect(parsePeerCheck('No peer dependency issues found')).toBeUndefined()
    expect(parsePeerCheck('[]')).toBeUndefined()
    expect(parsePeerCheck('{".":{"bad":{"a":[{"parents":[]}]}}}')).toBeUndefined()
  })
})

describe('一趟 add 没成时的回执', () => {
  it('退出码与尾巴', () => {
    expect(describeAddFailure('pnpm add x', { ok: false, exitCode: 1, tail: '404' })).toEqual({ error: 'pnpm add x 没成（退出码 1）', tail: '404' })
    expect(describeAddFailure('pnpm add x', { ok: false, exitCode: null })).toEqual({ error: 'pnpm add x 没成（退出码 null）' })
  })
})
