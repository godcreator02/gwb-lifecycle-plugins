import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { injectServicesOf, registerCatalogGuard } from '../src/catalog-guard.js'
import { mountHarness, registerPluginGuard } from '../src/plugin-guard.js'
import type { GuardVt } from '../src/vitest-context.js'

/**
 * 守卫的守卫：假一套 vitest 三件套把用例录音，再在真 it 里逐条回放——
 * 正本守卫挑错的行为本身得先被钉住，不然薄壳挂了个寂寞。
 */

interface Case {
  name: string
  fn: () => void
}

function recorder(): { vt: GuardVt; cases: Case[] } {
  const cases: Case[] = []
  const vt: GuardVt = {
    describe: (_name, fn) => fn(),
    it: (name, fn) => {
      cases.push({ name, fn: fn as () => void })
    },
    expect: (actual: unknown, message?: string) => ({
      toBe: (expected: unknown) => {
        if (actual !== expected) throw new Error(`${message ?? 'toBe'}：${String(actual)} ≠ ${String(expected)}`)
      },
      toEqual: (expected: unknown) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`${message ?? 'toEqual'}：${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`)
        }
      },
      toContain: (part: string) => {
        if (typeof actual !== 'string' || !actual.includes(part)) {
          throw new Error(`${message ?? 'toContain'}：缺「${part}」`)
        }
      },
      toMatch: (pattern: RegExp) => {
        if (typeof actual !== 'string' || !pattern.test(actual)) {
          throw new Error(`${message ?? 'toMatch'}：${String(actual)} 不配 ${String(pattern)}`)
        }
      },
      toHaveLength: (n: number) => {
        if (!Array.isArray(actual) || actual.length !== n) {
          throw new Error(`${message ?? 'toHaveLength'}：长度 ${String(actual?.length)} ≠ ${String(n)}`)
        }
      },
    }),
  }
  return { vt, cases }
}

/** 每条录音用例都在真 it 里跑一遍，断言它按预期过/炸 */
function replay(cases: Case[]): { pass: (namePart: string) => void; failsWith: (namePart: string, part: string) => void } {
  return {
    pass: (namePart) => {
      const found = cases.filter((c) => c.name.includes(namePart))
      if (found.length === 0) throw new Error(`没有叫「${namePart}」的用例`)
      for (const c of found) expect(() => c.fn()).not.toThrow()
    },
    failsWith: (namePart, part) => {
      const found = cases.filter((c) => c.name.includes(namePart))
      if (found.length === 0) throw new Error(`没有叫「${namePart}」的用例`)
      for (const c of found) expect(() => c.fn()).toThrow(part)
    },
  }
}

const tmps: string[] = []
afterAll(() => {
  for (const dir of tmps) fs.rmSync(dir, { recursive: true, force: true })
})

/** 造一个迷你仓：catalog.md + src/index.ts */
function fixtureRepo(card: string, src: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-kit-'))
  tmps.push(root)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'catalog.md'), card)
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), src)
  return root
}

const GOOD_CARD = ['插件的身份卡。', '**定位**：模板插件的最小完整形状。', '## 提供', '## 依赖', '命令清单不存卡——现扫门的 index。', '用到 gwbCommands 与 gwbShell。', ''].join('\n')
const GOOD_SRC = "import { ctx } from './x.js'\nexport const inject = ['gwbCommands', 'gwbShell']\n"

describe('injectServicesOf：三种 inject 写法都扫到', () => {
  it('export const 与 static 与局部 ctx.inject', () => {
    const src = [
      "export const inject = ['gwbA', 'gwbB']",
      "class X { static inject = ['gwbC'] }",
      "ctx.inject(['gwbD'], () => {})",
    ].join('\n')
    expect([...injectServicesOf(src)].sort()).toEqual(['gwbA', 'gwbB', 'gwbC', 'gwbD'])
  })
  it('没有 inject 就是空表', () => {
    expect(injectServicesOf('export const name = 1')).toEqual(new Set())
  })
})

describe('registerCatalogGuard', () => {
  it('卡齐全：两条用例都过', () => {
    const { vt, cases } = recorder()
    registerCatalogGuard(vt, { root: fixtureRepo(GOOD_CARD, GOOD_SRC) })
    expect(cases).toHaveLength(2)
    const r = replay(cases)
    r.pass('三段都在')
    r.pass('服务名')
  })
  it('卡漏了一个服务：点名那条炸，且报出漏的名字', () => {
    const card = GOOD_CARD.replace('gwbShell。', '。')
    const { vt, cases } = recorder()
    registerCatalogGuard(vt, { root: fixtureRepo(card, GOOD_SRC) })
    replay(cases).failsWith('服务名', 'gwbShell')
  })
  it('命令去向还指着旧门：第一条炸', () => {
    const card = GOOD_CARD.replace('现扫门的 index', '现扫 /surface')
    const { vt, cases } = recorder()
    registerCatalogGuard(vt, { root: fixtureRepo(card, GOOD_SRC) })
    replay(cases).failsWith('三段都在', 'index')
  })
})

describe('registerPluginGuard + mountHarness', () => {
  const goodApply = (ctx: unknown): void => {
    const c = ctx as {
      effect(f: () => unknown): () => void
      gwbShell: { registerPane(d: unknown): void }
      gwbCommands: { register(d: unknown, h: unknown): () => void }
    }
    c.effect(() => {
      c.gwbShell.registerPane({ id: 'main', client: 'file:///x/dist/client.js', style: 'file:///x/dist/style.css' })
      c.gwbCommands.register({ name: 'demo.ping', description: '回个话：无参数', plugin: 'gwb-demo' }, () => {})
    })
  }

  it('登记齐全：三条用例都过', () => {
    const { vt, cases } = recorder()
    registerPluginGuard(vt, { apply: goodApply, name: 'gwb-demo', pkgName: 'gwb-demo', short: 'demo' })
    expect(cases).toHaveLength(3)
    const r = replay(cases)
    r.pass('同一个短名')
    r.pass('一格窗格')
    r.pass('ping 命令')
  })
  it('名字与包名不同源：第一条炸', () => {
    const { vt, cases } = recorder()
    registerPluginGuard(vt, { apply: goodApply, name: 'gwb-other', pkgName: 'gwb-demo', short: 'demo' })
    replay(cases).failsWith('同一个短名', '≠')
  })
  it('描述没写参数形状：第三条炸在「无参数」', () => {
    const badApply = (ctx: unknown): void => {
      const c = ctx as ReturnType<typeof goodApply> extends never ? never : {
        effect(f: () => unknown): () => void
        gwbCommands: { register(d: unknown, h: unknown): () => void }
      }
      c.effect(() => {
        c.gwbCommands.register({ name: 'demo.ping', description: '回个话', plugin: 'gwb-demo' }, () => {})
      })
    }
    const { vt, cases } = recorder()
    registerPluginGuard(vt, { apply: badApply, name: 'gwb-demo', pkgName: 'gwb-demo', short: 'demo' })
    replay(cases).failsWith('ping 命令', '无参数')
  })
  it('mountHarness 独立可用：注册即发生', () => {
    const h = mountHarness(goodApply)
    expect(h.panes).toHaveLength(1)
    expect(h.commands[0]?.name).toBe('demo.ping')
  })
})
