import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIBER_STATE, fiberStateOf } from '../src/fiber'

/**
 * cordis 的 `FiberState` 是 `const enum`，运行时没有这个对象，插件只能照抄一份名字表。
 * 这里读已安装的 cordis 的 `lib/fiber.d.ts`，按声明里的数字排出成员名，保证照抄的那份没过时：
 * 升级 cordis 后成员增删或换了顺序，这里先失败。
 */
function fiberStateMembersDeclaredByCordis(): string[] {
  const cordisPackageJson = createRequire(import.meta.url).resolve('cordis/package.json')
  const declarationFile = path.join(path.dirname(cordisPackageJson), 'lib', 'fiber.d.ts')
  const declaration = fs.readFileSync(declarationFile, 'utf8')
  const enumBody = /export declare const enum FiberState \{([^}]*)\}/.exec(declaration)?.[1]
  if (enumBody === undefined) throw new Error(`${declarationFile} 里找不到 const enum FiberState 的声明`)
  const members = [...enumBody.matchAll(/(\w+)\s*=\s*(\d+)/g)].map((m) => ({ name: m[1]!, value: Number(m[2]) }))
  if (members.length === 0) throw new Error(`${declarationFile} 的 FiberState 里没有「名字 = 数字」形式的成员`)
  members.sort((a, b) => a.value - b.value)
  members.forEach((member, index) => {
    if (member.value !== index) throw new Error(`FiberState 的数字不是从 0 连续排的：${member.name} = ${member.value}`)
  })
  return members.map((member) => member.name)
}

describe('条目状态名和 cordis 的 FiberState 一致', () => {
  const declared = fiberStateMembersDeclaredByCordis()

  it('名字表与 cordis 声明的成员按数字顺序完全相同', () => {
    expect([...FIBER_STATE]).toEqual(declared)
  })

  it('fiberStateOf 按 cordis 声明的数字报状态名', () => {
    declared.forEach((name, state) => {
      expect(fiberStateOf({ fiber: { state } })).toBe(name)
    })
  })
})
