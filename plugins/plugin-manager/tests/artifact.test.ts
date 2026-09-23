import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 构建产物的检查：相对 import 带扩展名；包名 import 一个都没有。
 *
 * 「一个都没有」有两层意思：cordis、词汇表包只取类型，编译后就该消失；commands / data / settings /
 * skills 四个插件在这里是**可选**的，源码里只有 `import type {}`。哪天有人把它写成运行时 import，
 * 这条会立即失败——不然的话，home 里没装那四个插件时插件管理加载失败，日志里只有一句
 * ERR_MODULE_NOT_FOUND，看不出是依赖写错了。
 *
 * 缺产物时整组跳过——这组检查不依赖构建。
 */

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const built = fs.existsSync(distDir)

if (!built) console.warn('[gwb-plugin-manager] dist/ 还没构建，产物检查跳过（pnpm build 之后再跑）')

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

  it('有产物可查', () => {
    expect(all.length).toBeGreaterThan(0)
  })

  it('相对 import 一律带扩展名——产物给 node 直接加载，ESM 不做补全', () => {
    const bad: string[] = []
    for (const file of all) {
      for (const spec of specsIn(read(file), RELATIVE)) {
        if (!spec.endsWith('.js')) bad.push(`${file}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('除了 node 内置模块，一个包名 import 都没有', () => {
    const bare = new Set<string>()
    for (const file of all) {
      for (const spec of specsIn(read(file), BARE)) {
        if (!spec.startsWith('node:')) bare.add(spec)
      }
    }
    expect([...bare]).toEqual([])
  })
})
