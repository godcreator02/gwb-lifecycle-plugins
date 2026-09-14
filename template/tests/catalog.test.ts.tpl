import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * catalog 身份卡不撒谎：四格都在；node 半登记了的命令，卡上一条不缺。
 * 反向（卡上有、代码没有）由「改代码的人顺手改卡」这条纪律兜着——
 * 加命令不改卡，这条会红；删命令不改卡，读卡的人会去问。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const catalog = fs.readFileSync(path.resolve(here, '../catalog.md'), 'utf8')
const source = fs.readFileSync(path.resolve(here, '../src/index.ts'), 'utf8')

describe('catalog：身份卡', () => {
  it('四格都在（定位 / 提供 / 依赖 / 命令）', () => {
    for (const head of ['定位', '## 提供', '## 依赖', '## 命令']) expect(catalog).toContain(head)
  })

  it('登记的命令，卡上一条不缺', () => {
    const registered = [...source.matchAll(/name: '({{name}}\.[a-z-]+)'/g)].map((m) => m[1])
    expect(registered.length).toBeGreaterThan(0)
    for (const cmd of registered) expect(catalog).toContain(cmd)
  })

  it('卡上说的依赖，inject 里真有', () => {
    for (const dep of ['gwbCommands', 'gwbShell']) expect(source).toContain(`'${dep}'`)
  })
})
