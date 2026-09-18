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
 * `bin/cdp.mjs` 的落点纯函数。它一概不看工作目录：截图缺省落被截那个 home 自己的
 * `out\cdp\`，给输出与 eval 的文件都只收绝对路径，写盘落点不许在本包目录与任何 node_modules 里。
 */

const SCRIPT = fileURLToPath(new URL('../bin/cdp.mjs', import.meta.url))
const PKG = path.dirname(path.dirname(SCRIPT))
const HOME = path.join(os.tmpdir(), 'gwb-kernel', 'homes', 'cdpshot-2609181130')
const AT = new Date('2026-09-18T03:30:05.123Z')
/** 装进 home 之后那个包的样子：经总线跑时进程的工作目录就是这儿的 bin */
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
  it('Windows 上是 %APPDATA%\\gwb-kernel\\homes，别处认不出就回 undefined', () => {
    expect(homesRootOf({ APPDATA: path.join(os.tmpdir(), 'Roaming') }, 'win32')).toBe(
      path.join(os.tmpdir(), 'Roaming', 'gwb-kernel', 'homes'),
    )
    expect(homesRootOf({}, 'win32')).toBeUndefined()
    expect(homesRootOf({ APPDATA: 'x' }, 'linux')).toBeUndefined()
  })

  it('home 目录是根下同名那一格；根认不出就抛', () => {
    expect(homeDirOf('cdpshot-2609181130', path.dirname(HOME))).toBe(HOME)
    expect(() => homeDirOf('x', undefined)).toThrow(/home 根/)
  })
})

describe('shot 的落点', () => {
  it('缺省落被截那个 home 自己的 out\\cdp\\，文件名带时刻', () => {
    expect(shotFileOf(undefined, HOME, AT)).toBe(path.join(HOME, 'out', 'cdp', 'shot-2026-09-18T03-30-05.png'))
  })

  it('缺省落点不在本包目录里，也不在任何 node_modules 里', () => {
    const file = shotFileOf(undefined, HOME, AT)
    const rel = path.relative(PKG, file)
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true)
    expect(file.split(/[\\/]/).map((s) => s.toLowerCase())).not.toContain('node_modules')
  })

  it('算出来的缺省落点要是掉进包目录或 node_modules，就抛，不落盘', () => {
    expect(() => shotFileOf(undefined, path.join(PKG, 'bin'), AT)).toThrow(/包目录/)
    expect(() => shotFileOf(undefined, path.join(INSTALLED, 'bin'), AT, PKG)).toThrow(/node_modules/)
  })

  it('给了绝对路径就落那儿', () => {
    const want = path.join(os.tmpdir(), 'evidence', 'a.png')
    expect(shotFileOf(want, HOME, AT)).toBe(want)
  })

  it('给了相对路径当场拒，错话里说清缺省落哪', () => {
    for (const bad of ['a.png', 'out/cdp/a.png', './a.png', '..\\a.png']) {
      expect(() => shotFileOf(bad, HOME, AT), bad).toThrow(/只收绝对路径[\s\S]*out/)
    }
  })

  it.runIf(process.platform === 'win32')('Windows 上挂在当前盘的 \\a.png 与盘符相对的 D:a.png 都算相对', () => {
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

  it('相对路径当场拒，错话里说为什么、怎么拿绝对路径', () => {
    for (const bad of ['measure.js', 'out/measure.js', './measure.js']) {
      expect(() => evalFileOf(bad), bad).toThrow(/只收绝对路径[\s\S]*Resolve-Path/)
    }
  })

  it('没给文件也拒', () => {
    expect(() => evalFileOf(undefined)).toThrow(/绝对路径/)
  })
})

describe('写盘守卫', () => {
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
