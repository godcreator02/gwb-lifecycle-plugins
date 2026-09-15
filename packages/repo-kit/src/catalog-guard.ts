import fs from 'node:fs'
import path from 'node:path'
import type { GuardVt } from './vitest-context.js'

/**
 * 身份卡防漏：源码 inject 里的每个服务名必须出现在 catalog.md 里。
 * 防改靠改卡时顺手（将来可挂 docfirst 钉码）；这条管「该写的没写」。
 * 正本自模板 tests/catalog.test.ts.tpl 迁来（2026-09-15），命令去向的口径随门改 index。
 */

export interface CatalogGuardOptions {
  /** 仓根：catalog.md 与 src/ 的家。薄壳里用 path.resolve(here, '..') 算 */
  root: string
}

/** 源码里 inject 的服务名全表。三种写法都扫：export const / static / 局部 ctx.inject */
export function injectServicesOf(srcText: string): Set<string> {
  const services = new Set<string>()
  for (const m of srcText.matchAll(/(?:export const inject|static inject)\s*=\s*\[([^\]]*)\]/g)) {
    for (const q of m[1]!.matchAll(/'([^']+)'/g)) services.add(q[1]!)
  }
  for (const m of srcText.matchAll(/\.inject\(\s*\[([^\]]*)\]/g)) {
    for (const q of m[1]!.matchAll(/'([^']+)'/g)) services.add(q[1]!)
  }
  return services
}

export function registerCatalogGuard(vt: GuardVt, options: CatalogGuardOptions): void {
  const card = fs.readFileSync(path.join(options.root, 'catalog.md'), 'utf8')
  const srcDir = path.join(options.root, 'src')
  const srcText = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8'))
    .join('\n')

  vt.describe('catalog.md：身份卡防漏', () => {
    vt.it('三段都在（定位 / 提供 / 依赖），命令去向指门', () => {
      for (const head of ['定位', '## 提供', '## 依赖']) vt.expect(card).toContain(head)
      vt.expect(card).toContain('index')
    })

    vt.it('源码 inject 的每个服务名，卡上都点名了', () => {
      for (const s of injectServicesOf(srcText)) vt.expect(card, s).toContain(s)
    })
  })
}
