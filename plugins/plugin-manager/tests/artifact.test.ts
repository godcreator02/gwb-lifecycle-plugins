import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 产物守卫（node 半）。这个件 2026-09-12 断代改名时劈掉了浏览器半（搬去
 * @godcreator/gwb-baseui），只剩 node 半的规矩：相对 import 带扩展名、裸名只许那两个。
 *
 * 裸名名单钉死还有第二层意思：commands / data / settings / skills 四个件在这儿是
 * **可选**的，源码里只有 `import type {}`。哪天有人把它写成运行时 import，这条会当场变红——
 * 不然的话，现场是「home 里没装那四个件时这个件挂不上」，而日志里只有一句
 * ERR_MODULE_NOT_FOUND，看不出是依赖写错了档。
 *
 * 缺产物时整组跳过——门禁不依赖 build。
 */

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const built = fs.existsSync(distDir)

if (!built) console.warn('[gwb-plugin-manager] dist/ 还没造出来，产物组跳过（pnpm build 之后再跑）')

/** node 半运行时真 import 的两个，一个都不能少、也不该多 */
const ALLOWED_BARE = new Set(['cordis', '@godcreator/gwb-plugin-api'])

function read(file: string): string {
  return fs.readFileSync(path.join(distDir, file), 'utf8')
}

function specsIn(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1]!)
}

/** 锚在行首：产物里顶层 import 都顶格写，字符串字面量里那种总带着缩进 */
const RELATIVE = /^import\s+(?:[^'"]*from\s*)?['"](\.[^'"]*)['"]/gm
const BARE = /^import\s+(?:[^'"]*from\s*)?['"]([^'".][^'"]*)['"]/gm

describe.skipIf(!built)('产物', () => {
  const all = built ? fs.readdirSync(distDir).filter((f) => f.endsWith('.js')) : []

  it('node 半有产物可查', () => {
    expect(all.length).toBeGreaterThan(0)
  })

  it('node 半：相对 import 一律带扩展名——产物给 node 直接加载，ESM 不做补全', () => {
    const bad: string[] = []
    for (const file of all) {
      for (const spec of specsIn(read(file), RELATIVE)) {
        if (!spec.endsWith('.js')) bad.push(`${file}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('node 半：裸名只有钉死的那两个', () => {
    const bare = new Set<string>()
    for (const file of all) {
      for (const spec of specsIn(read(file), BARE)) {
        if (!spec.startsWith('node:')) bare.add(spec)
      }
    }
    expect([...bare].filter((s) => !ALLOWED_BARE.has(s))).toEqual([])
  })
})
