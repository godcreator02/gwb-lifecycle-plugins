import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MCP_RESULT_CHAR_LIMIT,
  PACKAGE_ROOT,
  READ_ONLY_VERBS,
  WRITE_VERBS,
  assertVerbAllowedOn,
  assertWritable,
  cmdReportOf,
  commandClientUrl,
  mcpReplyLength,
  evalFileOf,
  homeDirOf,
  homesRootOf,
  isFullPath,
  modifiersOf,
  shotArgsOf,
  shotFileOf,
} from '../bin/cdp.mjs'

/**
 * `bin/cdp.mjs` 被 import 时导出的纯函数，管三件事。写磁盘的位置：一概不看工作目录，截图缺省存到被截那个
 * home 自己的 `out\cdp\`，给输出与 eval 的文件都只收绝对路径，位置不许在本包目录与任何 node_modules 里。
 * default 上读写分开：只读动作放行，写动作与 --size 在分发之前拒，表外的动作在哪个 home 上都拒。
 * cmd 的回执上限：与 MCP 入口同一个数、同一种计法，超了不打印回执、退出码非零。
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

describe('目标 home 的命令客户端', () => {
  it('按目标 home 解析纯客户端，旧包缺少子路径时直接失败', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-cdp-client-'))
    try {
      const pkg = path.join(target, 'node_modules', '@godcreator', 'gwb-commands')
      fs.mkdirSync(pkg, { recursive: true })
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ exports: { './client': './client.js' } }))
      fs.writeFileSync(path.join(pkg, 'client.js'), 'export function command() {}')
      expect(fileURLToPath(commandClientUrl(target)!)).toBe(path.join(pkg, 'client.js'))
      // 用另一个包目录，避免 Node 对 exports 的缓存影响这次旧版判断。
      const legacy = path.join(target, 'legacy')
      const legacyPkg = path.join(legacy, 'node_modules', '@godcreator', 'gwb-commands')
      fs.mkdirSync(legacyPkg, { recursive: true })
      fs.writeFileSync(path.join(legacyPkg, 'package.json'), JSON.stringify({ exports: { '.': './index.js' } }))
      expect(() => commandClientUrl(legacy)).toThrow()
    } finally {
      fs.rmSync(target, { recursive: true, force: true })
    }
  })
})

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
    expect(indexSource).toMatch(/import \{[^}]*\bhomesRootOf\b[^}]*\} from '\.\.\/bin\/cdp\.mjs'/)
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

describe('default 上读写分开', () => {
  const ISOLATED = 'cdpguard-2609251000'

  it('只读动作对 default 放行', () => {
    for (const verb of READ_ONLY_VERBS) {
      expect(() => assertVerbAllowedOn('default', verb, undefined), verb).not.toThrow()
    }
  })

  it('写动作对 default 拒，错话写明只许只读、写动作去隔离 home', () => {
    for (const verb of WRITE_VERBS) {
      expect(() => assertVerbAllowedOn('default', verb, undefined), verb).toThrow(/default 上只许只读动作[\s\S]*隔离 home/)
    }
  })

  it('eval 能执行任意代码，一律算写', () => {
    expect(WRITE_VERBS.has('eval')).toBe(true)
    expect(READ_ONLY_VERBS.has('eval')).toBe(false)
  })

  it('--size 会改 default 页面的视口，只读动作带上它也拒', () => {
    expect(() => assertVerbAllowedOn('default', 'shot', '900x800')).toThrow(/--size/)
    expect(() => assertVerbAllowedOn('default', 'shot', 'off')).toThrow(/--size/)
  })

  it('隔离 home 上读写都放行，--size 也放行', () => {
    for (const verb of [...READ_ONLY_VERBS, ...WRITE_VERBS]) {
      expect(() => assertVerbAllowedOn(ISOLATED, verb, undefined), verb).not.toThrow()
    }
    expect(() => assertVerbAllowedOn(ISOLATED, 'shot', '900x800')).not.toThrow()
  })

  it('表外的动作在哪个 home 上都报错，错话要人先分类', () => {
    for (const home of ['default', ISOLATED]) {
      expect(() => assertVerbAllowedOn(home, 'navigate', undefined), home).toThrow(/不认得这个动作：navigate[\s\S]*READ_ONLY_VERBS[\s\S]*WRITE_VERBS/)
      expect(() => assertVerbAllowedOn(home, undefined, undefined), home).toThrow(/不认得这个动作/)
    }
  })

  it('两张表不相交，合起来正好是 run() 里分发的全部动作', () => {
    expect([...READ_ONLY_VERBS].filter((verb) => WRITE_VERBS.has(verb))).toEqual([])
    const dispatched = [...fs.readFileSync(SCRIPT, 'utf8').matchAll(/^ {4}case '([a-z]+)':/gm)].map((m) => m[1]).sort()
    expect(dispatched.length).toBeGreaterThan(0)
    expect([...READ_ONLY_VERBS, ...WRITE_VERBS].sort()).toEqual(dispatched)
  })

  it('入口在核对 home 之后、视口覆盖与分发之前调用它，传的是页面自报的名字', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8')
    const checked = source.indexOf('const pageHome = await assertHome(send)')
    const guarded = source.indexOf('assertVerbAllowedOn(pageHome, verb, opts.size)')
    expect(checked).toBeGreaterThan(0)
    expect(guarded).toBeGreaterThan(checked)
    expect(guarded).toBeLessThan(source.lastIndexOf('await override(send)'))
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

describe('cmd 的回执上限：与 MCP 入口同一个数、同一种计法', () => {
  const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

  it('上限是 MCP 入口的 40000 字符', () => {
    expect(MCP_RESULT_CHAR_LIMIT).toBe(40_000)
  })

  it('标准回执：成功量 {ok:true,data} 缩进两格的 JSON，data 缺省按 null；失败量「执行失败：」加 error', () => {
    expect(mcpReplyLength({ ok: true, data: { a: '中文' } })).toBe(pretty({ ok: true, data: { a: '中文' } }).length)
    expect(mcpReplyLength({ ok: true })).toBe(pretty({ ok: true, data: null }).length)
    expect(mcpReplyLength({ ok: false, error: '没有这条命令：nope' })).toBe('执行失败：没有这条命令：nope'.length)
    expect(mcpReplyLength({ ok: false })).toBe('执行失败：未知错误'.length)
  })

  it('处理函数自己的对象（多出 ok/data/error 以外的键）整张量', () => {
    const own = { ok: true, at: '2026-10-07 12:00:00', view: { level: 'max' } }
    expect(mcpReplyLength(own)).toBe(pretty(own).length)
  })

  it('命令行运行的回执只量 MCP 入口交回的那几个字段', () => {
    const cli = {
      ok: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      timeoutMs: 1000,
      durationMs: 12,
      stdout: { text: 'x'.repeat(50), truncated: false },
      stderr: { text: '', truncated: false },
    }
    const { ok, exitCode, timedOut, durationMs, stdout, stderr } = cli
    expect(mcpReplyLength(cli)).toBe(pretty({ ok, exitCode, timedOut, durationMs, stdout, stderr }).length)
  })

  it('函数源码自成一体：送进页面执行时不引用这个文件里别的名字', () => {
    const inPage = new Function(`return (${mcpReplyLength.toString()})`)() as (reply: unknown) => number
    const reply = { ok: true, data: ['a', 'b'] }
    expect(inPage(reply)).toBe(mcpReplyLength(reply))
  })

  it('不超过上限（含正好等于）：照常打印回执，退出码看回执的 ok', () => {
    const reply = { ok: true, data: 'x' }
    expect(cmdReportOf('demo.small', { length: MCP_RESULT_CHAR_LIMIT, reply })).toEqual({
      failed: false,
      report: { did: 'cmd', 命令: 'demo.small', 回执: reply },
    })
    expect(cmdReportOf('demo.fail', { length: 20, reply: { ok: false, error: '坏了' } }).failed).toBe(true)
  })

  it('超过上限：不打印回执，写明字符数、上限与怎么办，退出码非零', () => {
    const length = MCP_RESULT_CHAR_LIMIT + 1
    const { failed, report } = cmdReportOf('demo.huge', { length })
    expect(failed).toBe(true)
    expect(report).not.toHaveProperty('回执')
    expect(report).toMatchObject({ did: 'cmd', 命令: 'demo.huge', 回执字符数: length, 上限: MCP_RESULT_CHAR_LIMIT })
    expect(report.没有交回).toMatch(new RegExp(`demo\\.huge 已经执行完.*${length} 字符.*超过单次返回的上限 ${MCP_RESULT_CHAR_LIMIT}.*usage`))
  })

  it('cmd 在页面里量长度、超了不传回回执，再交给 cmdReportOf', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8')
    const branch = source.slice(source.indexOf("case 'cmd':"), source.indexOf("case 'reload':"))
    expect(branch).toContain('(${mcpReplyLength})(reply)')
    expect(branch).toContain('length > ${MCP_RESULT_CHAR_LIMIT} ? { length } : { length, reply }')
    expect(branch).toContain('cmdReportOf(args[0], measured)')
  })
})

describe('--mod：修饰键的位掩码', () => {
  it('认得的名字按位相加，大小写与空白不计较', () => {
    expect(modifiersOf(undefined)).toBe(0)
    expect(modifiersOf('ctrl')).toBe(2)
    expect(modifiersOf('Ctrl, shift')).toBe(10)
    expect(modifiersOf('alt,ctrl,meta,shift')).toBe(15)
  })

  it('写错的键名直接拒，报出是哪个，不当它没写', () => {
    expect(() => modifiersOf('ctrl,shfit')).toThrow(/shfit/)
    expect(() => modifiersOf('control')).toThrow(/alt、ctrl、meta、shift/)
  })
})
