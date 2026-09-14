import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 身份卡防漏：源码 inject 里的每个服务名必须出现在 catalog.md 里。
 * 防改靠改卡时顺手（将来可挂 docfirst 钉码）；这条管「该写的没写」。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const card = fs.readFileSync(path.resolve(here, '../catalog.md'), 'utf8')

function srcText(): string {
  const dir = path.resolve(here, '../src')
  return fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
}

describe('catalog.md：身份卡防漏', () => {
  it('四段都在（定位 / 提供 / 依赖 / 命令去向）', () => {
    for (const head of ['定位', '## 提供', '## 依赖']) expect(card).toContain(head)
    expect(card).toContain('/surface')
  })

  it('源码 inject 的每个服务名，卡上都点名了', () => {
    const services = new Set<string>()
    for (const m of srcText().matchAll(/(?:export const inject|static inject)\s*=\s*\[([^\]]*)\]/g))
      for (const q of m[1]!.matchAll(/'([^']+)'/g)) services.add(q[1]!)
    for (const m of srcText().matchAll(/\.inject\(\s*\[([^\]]*)\]/g))
      for (const q of m[1]!.matchAll(/'([^']+)'/g)) services.add(q[1]!)
    for (const s of services) expect(card, s ?? "?").toContain(s ?? "?")
  })
})
