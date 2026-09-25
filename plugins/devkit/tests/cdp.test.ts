import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PACKAGE_ROOT,
  assertWritable,
  evalFileOf,
  homeDirOf,
  homesRootOf,
  isFullPath,
  shotArgsOf,
  shotFileOf,
} from '../bin/cdp.mjs'

/**
 * `bin/cdp.mjs` 里决定写到哪里的纯函数。它一概不看工作目录：截图缺省存到被截的那个 home 自己的
 * `out\cdp\`，给输出与 eval 的文件都只收绝对路径，写磁盘的位置不许在本包目录与任何 node_modules 里。
 */

const SCRIPT = fileURLToPath(new URL('../bin/cdp.mjs', import.meta.url))
const PKG = path.dirname(path.dirname(SCRIPT))
const HOME = path.join(os.tmpdir(), 'gwb-kernel', 'homes', 'cdpshot-2609181130')
const AT = new Date('2026-09-18T03:30:05.123Z')
/** 装进 home 之后那个包的样子：经命令总线运行时进程的工作目录就是这里的 bin */
const INSTALLED = path.join(
  HOME,
  'node_modules',
  '.pnpm',
  '@godcreator+gwb-devkit@0.15.0',
  'node_modules',
  '@godcreator',
  'gwb-devkit',
)

describe('被 import 时不动手', () => {
  it('交出纯函数，不连 CDP、不读 argv 里的 home', () => {
    expect(typeof shotFileOf).toBe('function')
    expect(path.normalize(PACKAGE_ROOT)).toBe(path.normalize(PKG))
  })

  it('整个文件不读工作目录', () => {
    expect(fs.readFileSync(SCRIPT, 'utf8')).not.toMatch(/process\.cwd\s*\(/)
  })
})

describe('home 根与 home 目录', () => {
  it('Windows 上是 %APPDATA%\\gwb-kernel\\homes，没有 APPDATA 就报错', () => {
    expect(homesRootOf({ APPDATA: path.join(os.tmpdir(), 'Roaming') }, 'win32')).toBe(
      path.join(os.tmpdir(), 'Roaming', 'gwb-kernel', 'homes'),
    )
    expect(() => homesRootOf({}, 'win32')).toThrow(/APPDATA/)
  })

  it('不是 Windows：直接抛错，说只支持 Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(() => homesRootOf({ APPDATA: path.join(os.tmpdir(), 'Roaming') }, platform), platform).toThrow(/只支持 Windows/)
    }
  })

  it('home 目录是根目录下同名的子目录', () => {
    expect(homeDirOf('cdpshot-2609181130', path.dirname(HOME))).toBe(HOME)
  })

  it('devkit 插件的 home 根就是这个函数：src/index.ts 从 cdp.mjs import，不另写一份', () => {
    const indexSource = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(indexSource).toContain("import { homesRootOf } from '../bin/cdp.mjs'")
    expect(indexSource).not.toMatch(/dataDir, '\.\.', '\.\.'/)
  })
})

describe('shot 的输出位置', () => {
  it('缺省存到被截的那个 home 自己的 out\\cdp\\，文件名带时刻', () => {
    expect(shotFileOf(undefined, HOME, AT)).toBe(path.join(HOME, 'out', 'cdp', 'shot-2026-09-18T03-30-05.png'))
  })

  it('缺省位置不在本包目录里，也不在任何 node_modules 里', () => {
    const file = shotFileOf(undefined, HOME, AT)
    const rel = path.relative(PKG, file)
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true)
    expect(file.split(/[\\/]/).map((s) => s.toLowerCase())).not.toContain('node_modules')
  })

  it('算出来的缺省位置要是在包目录或 node_modules 里，就抛错，不写磁盘', () => {
    expect(() => shotFileOf(undefined, path.join(PKG, 'bin'), AT)).toThrow(/包目录/)
    expect(() => shotFileOf(undefined, path.join(INSTALLED, 'bin'), AT, PKG)).toThrow(/node_modules/)
  })

  it('给了绝对路径就存到那里', () => {
    const want = path.join(os.tmpdir(), 'evidence', 'a.png')
    expect(shotFileOf(want, HOME, AT)).toBe(want)
  })

  it('给了相对路径直接拒，报错里说清缺省存到哪', () => {
    for (const bad of ['a.png', 'out/cdp/a.png', './a.png', '..\\a.png']) {
      expect(() => shotFileOf(bad, HOME, AT), bad).toThrow(/只收绝对路径[\s\S]*out/)
    }
  })

  it.runIf(process.platform === 'win32')('Windows 上指向当前盘的 \\a.png 与盘符相对的 D:a.png 都算相对', () => {
    for (const bad of ['\\a.png', '/a.png', 'D:a.png']) {
      expect(() => shotFileOf(bad, HOME, AT), bad).toThrow(/只收绝对路径/)
    }
  })

  it('给的绝对路径在包目录或 node_modules 里也拒', () => {
    expect(() => shotFileOf(path.join(PKG, 'out', 'a.png'), HOME, AT)).toThrow(/包目录/)
    expect(() => shotFileOf(path.join(INSTALLED, 'bin', 'out', 'a.png'), HOME, AT)).toThrow(/node_modules/)
  })

  it('第一个参数以 .png 结尾（不分大小写）才是输出，否则是选择器', () => {
    expect(shotArgsOf(['D:\\x\\a.PNG', '.sel'])).toEqual({ given: 'D:\\x\\a.PNG', sel: '.sel' })
    expect(shotArgsOf(['.sel'])).toEqual({ given: undefined, sel: '.sel' })
    expect(shotArgsOf([])).toEqual({ given: undefined, sel: undefined })
  })
})

describe('eval 的文件', () => {
  it('绝对路径原样收（规整过）', () => {
    const want = path.join(os.tmpdir(), 'probe', 'measure.js')
    expect(evalFileOf(want)).toBe(want)
  })

  it('相对路径直接拒，报错里说为什么、怎么拿绝对路径', () => {
    for (const bad of ['measure.js', 'out/measure.js', './measure.js']) {
      expect(() => evalFileOf(bad), bad).toThrow(/只收绝对路径[\s\S]*Resolve-Path/)
    }
  })

  it('没给文件也拒', () => {
    expect(() => evalFileOf(undefined)).toThrow(/绝对路径/)
  })
})

describe('写磁盘前的检查', () => {
  it('完整的绝对路径才过', () => {
    expect(isFullPath(path.join(os.tmpdir(), 'a.png'))).toBe(true)
    expect(isFullPath('a.png')).toBe(false)
    expect(isFullPath(undefined)).toBe(false)
    expect(() => assertWritable('a.png', PKG)).toThrow(/不是完整的绝对路径/)
  })

  it('包根本身与它下面都不许写', () => {
    expect(() => assertWritable(PKG, PKG)).toThrow(/包目录/)
    expect(() => assertWritable(path.join(PKG, 'bin', 'out', 'cdp', 'a.png'), PKG)).toThrow(/包目录/)
  })

  it('跟包根同前缀的兄弟目录不算在包里', () => {
    expect(assertWritable(`${PKG}-evidence${path.sep}a.png`, PKG)).toBe(`${PKG}-evidence${path.sep}a.png`)
  })
})
