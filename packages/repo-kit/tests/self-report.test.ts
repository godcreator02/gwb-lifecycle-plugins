import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { injectServicesOf, providedServicesOf, registerSelfReportGuard } from '../src/self-report-guard.js'
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

/** 造一个迷你包：package.json + src/index.ts（+ 可选 skills/ 与站现状区） */
function fixtureRepo(description: string, src: string, extra: { skills?: number; docs?: string; provides?: Record<string, unknown> } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-kit-'))
  tmps.push(root)
  fs.mkdirSync(path.join(root, 'src'))
  const manifest: Record<string, unknown> = {
    name: '@godcreator/gwb-demo',
    version: '1.0.0',
    description,
    keywords: ['gwb', 'gwb-plugin'],
    ...(extra.provides === undefined ? {} : { gwb: { provides: extra.provides } }),
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), src)
  for (let i = 0; i < (extra.skills ?? 0); i++) {
    fs.mkdirSync(path.join(root, 'skills', `s${String(i)}`), { recursive: true })
    fs.writeFileSync(path.join(root, 'skills', `s${String(i)}`, 'SKILL.md'), '# s\n')
  }
  if (extra.docs !== undefined) {
    fs.mkdirSync(path.join(root, 'docs-site/content/docs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs-site/content/docs/index.mdx'), extra.docs)
  }
  return root
}

const GOOD_DESC = '演示件：最小完整形状。服务 gwbDemo；skill 1 份；命令 1 条。'
const GOOD_SRC = [
  "import { ctx } from './x.js'",
  "export const inject = ['gwbCommands', 'gwbShell']",
  "class GwbDemo { constructor(ctx) { super(ctx, 'gwbDemo') } }",
].join('\n')
const GOOD_DOCS = '## 服务 ctx.gwbDemo\n\n用了 gwbCommands 与 gwbShell。\n'
const GOOD_PROVIDES = { gwbDemo: { summary: '演示服务', usage: 'ctx.gwbDemo.demo()' } }

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

describe('providedServicesOf：三种写法都扫到', () => {
  it('super / provide / new', () => {
    const src = [
      "class A { constructor(ctx) { super(ctx, 'gwbA') } }",
      "ctx.provide('gwbB', api)",
      "new GwbLogger(ctx, 'gwbC')",
    ].join('\n')
    expect([...providedServicesOf(src)].sort()).toEqual(['gwbA', 'gwbB', 'gwbC'])
    expect(providedServicesOf('export const name = 1')).toEqual(new Set())
  })
})

describe('registerSelfReportGuard', () => {
  it('自述齐全：五条用例都过', () => {
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, { root: fixtureRepo(GOOD_DESC, GOOD_SRC, { skills: 1, docs: GOOD_DOCS, provides: GOOD_PROVIDES }) })
    expect(cases).toHaveLength(5)
    const r = replay(cases)
    r.pass('三格齐全')
    r.pass('提供的服务名')
    r.pass('gwb.provides')
    r.pass('说明书份数')
    r.pass('站现状区')
  })
  it('gwb.provides 漏声明源码提供的服务：那条炸，且报出名字', () => {
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, { root: fixtureRepo(GOOD_DESC, GOOD_SRC, { skills: 1, docs: GOOD_DOCS }) })
    replay(cases).failsWith('gwb.provides', 'gwbDemo')
  })
  it('gwb.provides 声明了源码不提供的服务：那条炸', () => {
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, {
      root: fixtureRepo(GOOD_DESC, GOOD_SRC, {
        skills: 1,
        docs: GOOD_DOCS,
        provides: { ...GOOD_PROVIDES, gwbGhost: { summary: '没有的服务', usage: 'x' } },
      }),
    })
    replay(cases).failsWith('gwb.provides', 'gwbGhost')
  })
  it('gwb.provides 的 usage 是空串：那条炸', () => {
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, {
      root: fixtureRepo(GOOD_DESC, GOOD_SRC, { skills: 1, docs: GOOD_DOCS, provides: { gwbDemo: { summary: '演示服务', usage: '' } } }),
    })
    replay(cases).failsWith('gwb.provides', 'usage')
  })
  it('description 没提提供的服务：点名那条炸，且报出名字', () => {
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, { root: fixtureRepo(GOOD_DESC.replace('服务 gwbDemo；', '服务无；'), GOOD_SRC, { skills: 1, docs: GOOD_DOCS }) })
    replay(cases).failsWith('提供的服务名', 'gwbDemo')
  })
  it('说明书份数对不上：那条炸', () => {
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, { root: fixtureRepo(GOOD_DESC, GOOD_SRC, { skills: 2, docs: GOOD_DOCS }) })
    replay(cases).failsWith('说明书份数', 'skill 2 份')
  })
  it('inject 的服务没进站现状区：那条炸', () => {
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, { root: fixtureRepo(GOOD_DESC, GOOD_SRC, { skills: 1, docs: '## 服务 ctx.gwbDemo\n\n只写了 gwbCommands。\n' }) })
    replay(cases).failsWith('站现状区', 'gwbShell')
  })
  it('库（keywords 里没有 gwb-plugin）跳过：一条用例都不注册', () => {
    const root = fixtureRepo('演示库：不属于件。', GOOD_SRC, { skills: 0 })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@godcreator/gwb-demo', version: '1.0.0', description: '演示库：不属于件。', keywords: ['gwb'] }))
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, { root })
    expect(cases).toHaveLength(0)
  })
  it('description 三格缺一：第一条炸', () => {
    const { vt, cases } = recorder()
    registerSelfReportGuard(vt, { root: fixtureRepo('演示件：最小完整形状。', GOOD_SRC, { skills: 1, docs: GOOD_DOCS }) })
    replay(cases).failsWith('三格齐全', '服务')
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
      c.gwbCommands.register({ name: 'demo.ping', description: '回个话：无参数', plugin: '@godcreator/gwb-demo' }, () => {})
    })
  }

  it('登记齐全：三条用例都过', () => {
    const { vt, cases } = recorder()
    registerPluginGuard(vt, { apply: goodApply, name: 'gwb-demo', pkg: '@godcreator/gwb-demo', pkgName: 'gwb-demo', short: 'demo' })
    expect(cases).toHaveLength(3)
    const r = replay(cases)
    r.pass('同一个短名')
    r.pass('一格窗格')
    r.pass('ping 命令')
  })
  it('名字与包名不同源：第一条炸', () => {
    const { vt, cases } = recorder()
    registerPluginGuard(vt, { apply: goodApply, name: 'gwb-other', pkg: '@godcreator/gwb-demo', pkgName: 'gwb-demo', short: 'demo' })
    replay(cases).failsWith('同一个短名', '≠')
  })
  it('描述没写参数形状：第三条炸在「无参数」', () => {
    const badApply = (ctx: unknown): void => {
      const c = ctx as ReturnType<typeof goodApply> extends never ? never : {
        effect(f: () => unknown): () => void
        gwbCommands: { register(d: unknown, h: unknown): () => void }
      }
      c.effect(() => {
        c.gwbCommands.register({ name: 'demo.ping', description: '回个话', plugin: '@godcreator/gwb-demo' }, () => {})
      })
    }
    const { vt, cases } = recorder()
    registerPluginGuard(vt, { apply: badApply, name: 'gwb-demo', pkg: '@godcreator/gwb-demo', pkgName: 'gwb-demo', short: 'demo' })
    replay(cases).failsWith('ping 命令', '无参数')
  })
  it('mountHarness 独立可用：注册即发生', () => {
    const h = mountHarness(goodApply)
    expect(h.panes).toHaveLength(1)
    expect(h.commands[0]?.name).toBe('demo.ping')
  })
})
