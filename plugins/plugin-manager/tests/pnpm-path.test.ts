import { describe, expect, it } from 'vitest'
import { describePnpm, findPnpm, pnpmPackageOf, spawnPlan, type Lookup } from '../src/pnpm-path.js'
import { tailLines } from '../src/pnpm.js'

/** 这台机器上的典型布局：npm 全局装的 pnpm */
const NPM_GLOBAL = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const PKG = `${NPM_GLOBAL}\\node_modules\\pnpm`
/** npm 全局装完（preinstall 跑过）包根有 pnpm.exe */
const EXE = `${PKG}\\pnpm.exe`
/** 原生二进制本体：可选依赖 @pnpm/exe.win32-x64 */
const EXE_OPTIONAL = `${PKG}\\node_modules\\@pnpm\\exe.win32-x64\\pnpm.exe`

interface Disk {
  files?: readonly string[]
  dirs?: readonly string[]
  /** pnpm 包目录 → 版本号 */
  packages?: Readonly<Record<string, string>>
  /** 软链 → 真实路径 */
  links?: Readonly<Record<string, string>>
}

function disk(d: Disk): Pick<Lookup, 'stat' | 'realpath' | 'pnpmVersion'> {
  const files = new Set(d.files)
  const dirs = new Set([...(d.dirs ?? []), ...Object.keys(d.packages ?? {})])
  return {
    stat: (file) => (files.has(file) ? 'file' : dirs.has(file) ? 'dir' : undefined),
    realpath: (file) => d.links?.[file] ?? file,
    pnpmVersion: (dir) => d.packages?.[dir],
  }
}

function win(d: Disk, extra: Partial<Lookup> = {}): Lookup {
  return { delimiter: ';', sep: '\\', platform: 'win32', arch: 'x64', ...disk(d), ...extra }
}

/** npm 全局装了 pnpm 12 的盘 */
const WITH_12: Disk = { files: [`${NPM_GLOBAL}\\pnpm.cmd`, EXE, EXE_OPTIONAL], packages: { [PKG]: '12.4.2' } }
/** npm 全局装的是 pnpm 11：包里只有 bin/pnpm.cjs，没有原生二进制 */
const WITH_11: Disk = { files: [`${NPM_GLOBAL}\\pnpm.cmd`, `${PKG}\\bin\\pnpm.cjs`], packages: { [PKG]: '11.21.0' } }

describe('从 PATH 里找 pnpm', () => {
  it('垫片旁边推出原生 pnpm.exe', () => {
    const lookup = win(WITH_12, { pathEnv: `C:\\Windows\\system32;${NPM_GLOBAL}` })
    expect(findPnpm(lookup)).toEqual({ ok: true, file: EXE, version: '12.4.2', from: 'path' })
  })

  it('包根没有 pnpm.exe（preinstall 没跑）时，用可选依赖 @pnpm/exe 里那份', () => {
    const lookup = win({ ...WITH_12, files: [`${NPM_GLOBAL}\\pnpm.cmd`, EXE_OPTIONAL] }, { pathEnv: NPM_GLOBAL })
    expect(findPnpm(lookup)).toMatchObject({ ok: true, file: EXE_OPTIONAL })
  })

  it('连 @pnpm/exe 都没装上：报出缺的是原生二进制', () => {
    const lookup = win({ files: [`${NPM_GLOBAL}\\pnpm.cmd`], packages: { [PKG]: '12.4.2' } }, { pathEnv: NPM_GLOBAL })
    const result = findPnpm(lookup)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/原生二进制.*win32-x64/)
  })

  it('版本 <12 明确报错、说清要装 12+，不试着跑它的 pnpm.cjs', () => {
    const result = findPnpm(win(WITH_11, { pathEnv: NPM_GLOBAL }))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/pnpm 11\.21\.0.*只支持 pnpm 12 及以上/)
  })

  it('PATH 前面是 pnpm 11、后面是 12：跳过 11 用 12', () => {
    const other = 'D:\\tools\\pnpm12'
    const otherPkg = `${other}\\node_modules\\pnpm`
    const both: Disk = {
      files: [...(WITH_11.files ?? []), `${other}\\pnpm.cmd`, `${otherPkg}\\pnpm.exe`],
      packages: { [PKG]: '11.21.0', [otherPkg]: '12.4.2' },
    }
    expect(findPnpm(win(both, { pathEnv: `${NPM_GLOBAL};${other}` }))).toMatchObject({ ok: true, file: `${otherPkg}\\pnpm.exe` })
  })

  it('目录里直接有 pnpm.exe 就用它（standalone 装法）', () => {
    const home = 'C:\\Users\\me\\AppData\\Local\\pnpm'
    const lookup = win({ files: [`${home}\\pnpm.exe`] }, { pathEnv: home })
    expect(findPnpm(lookup)).toEqual({ ok: true, file: `${home}\\pnpm.exe`, from: 'path' })
  })

  it('第一个命中的垫片推不出 pnpm 包时继续往后扫——corepack/volta 的垫片不是这个布局', () => {
    const lookup = win({ ...WITH_12, files: ['C:\\volta\\bin\\pnpm.cmd', ...(WITH_12.files ?? [])] }, {
      pathEnv: `C:\\volta\\bin;${NPM_GLOBAL}`,
    })
    expect(findPnpm(lookup)).toMatchObject({ ok: true, file: EXE })
  })

  it('PATH 里带引号的目录也认——Windows 上很常见', () => {
    const lookup = win(WITH_12, { pathEnv: `"${NPM_GLOBAL}"` })
    expect(findPnpm(lookup)).toMatchObject({ ok: true, file: EXE })
  })

  it('非 Windows：解开垫片软链，落到的 pnpm 包作数（npm 全局是 <prefix>/lib/node_modules）', () => {
    const lookup: Lookup = {
      delimiter: ':',
      sep: '/',
      platform: 'linux',
      arch: 'x64',
      pathEnv: '/usr/local/bin',
      ...disk({
        files: ['/usr/local/bin/pnpm', '/usr/local/lib/node_modules/pnpm/node_modules/@pnpm/exe.linux-x64/pnpm'],
        packages: { '/usr/local/lib/node_modules/pnpm': '12.4.2' },
        links: { '/usr/local/bin/pnpm': '/usr/local/lib/node_modules/pnpm/pnpm' },
      }),
    }
    expect(findPnpm(lookup)).toMatchObject({ ok: true, file: '/usr/local/lib/node_modules/pnpm/node_modules/@pnpm/exe.linux-x64/pnpm' })
  })

  it('一条都不命中就回一句明确的错,指向设置项——不静默失败', () => {
    const result = findPnpm(win({}, { pathEnv: 'C:\\Windows\\system32' }))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/pnpm-path/)
  })

  it('PATH 整个没有也不炸', () => {
    expect(findPnpm(win({})).ok).toBe(false)
  })
})

describe('设置项那一路', () => {
  it('填 pnpm.exe', () => {
    expect(findPnpm(win(WITH_12, { configured: EXE }))).toEqual({ ok: true, file: EXE, version: '12.4.2', from: 'setting' })
  })

  it('填包外的一个可执行文件（比如 @pnpm/exe 独立装的）也照填的起', () => {
    const exe = 'D:\\tools\\pnpm.exe'
    expect(findPnpm(win({ files: [exe] }, { configured: exe }))).toEqual({ ok: true, file: exe, from: 'setting' })
  })

  it('填 bin/pnpm.mjs（corepack 入口）也落到原生可执行，不去跑那个会下载二进制的脚本', () => {
    const lookup = win({ ...WITH_12, files: [...(WITH_12.files ?? []), `${PKG}\\bin\\pnpm.mjs`] }, { configured: `${PKG}\\bin\\pnpm.mjs` })
    expect(findPnpm(lookup)).toMatchObject({ ok: true, file: EXE })
  })

  it('填 pnpm 11 包里的 pnpm.cjs：报版本太老，不跑', () => {
    const result = findPnpm(win(WITH_11, { configured: `${PKG}\\bin\\pnpm.cjs` }))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/只支持 pnpm 12 及以上/)
  })

  it('填 pnpm.cmd 那个垫片', () => {
    expect(findPnpm(win(WITH_12, { configured: `${NPM_GLOBAL}\\pnpm.cmd` }))).toMatchObject({ ok: true, file: EXE })
  })

  it('填垫片所在的那个目录也认', () => {
    expect(findPnpm(win({ ...WITH_12, dirs: [NPM_GLOBAL] }, { configured: NPM_GLOBAL }))).toMatchObject({ ok: true, file: EXE })
  })

  it('填 pnpm 包目录本身也认', () => {
    expect(findPnpm(win(WITH_12, { configured: PKG }))).toMatchObject({ ok: true, file: EXE })
  })

  it('填了就不再回退去扫 PATH——填错了要当场看见,不是悄悄用了另一份', () => {
    const result = findPnpm(win(WITH_12, { configured: 'D:\\nope\\pnpm.exe', pathEnv: NPM_GLOBAL }))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/pnpm-path.*不存在/)
  })

  it('空串当没填,照样走 PATH', () => {
    expect(findPnpm(win(WITH_12, { configured: '', pathEnv: NPM_GLOBAL }))).toMatchObject({ from: 'path' })
  })
})

describe('怎么起', () => {
  const env = { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' }

  it('直接起可执行，环境原样透传但不带 ELECTRON_RUN_AS_NODE', () => {
    expect(spawnPlan(EXE, ['outdated', '--json'], env)).toEqual({
      command: EXE,
      args: ['outdated', '--json'],
      env: { PATH: 'x', HOME: 'h' },
    })
  })

  it('不改调用方给的环境', () => {
    spawnPlan(EXE, [], env)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('日志那句带版本与出处', () => {
    expect(describePnpm({ file: EXE, version: '12.4.2', from: 'path' })).toBe(`pnpm 12.4.2（${EXE}，PATH 里找到的）`)
  })
})

describe('推路径', () => {
  it('路径落在 node_modules/pnpm 里就回那个包目录', () => {
    expect(pnpmPackageOf(`${PKG}\\bin\\pnpm.mjs`, '\\')).toBe(PKG)
    expect(pnpmPackageOf(PKG, '\\')).toBe(PKG)
    expect(pnpmPackageOf('D:\\tools\\pnpm.exe', '\\')).toBeUndefined()
  })

  it('不把 node_modules/pnpm-foo 当成 pnpm 包', () => {
    expect(pnpmPackageOf('C:\\x\\node_modules\\pnpm-foo\\bin\\a.js', '\\')).toBeUndefined()
  })
})

describe('pnpm 输出留尾巴', () => {
  it('只留最后几行——pnpm 把原因放在最后', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(tailLines(text, 3)).toBe('line 37\nline 38\nline 39')
  })

  it('两头的空行削掉', () => {
    expect(tailLines('\n\na\nb\n\n\n', 10)).toBe('a\nb')
  })

  it('CRLF 归一', () => {
    expect(tailLines('a\r\nb\r\n', 10)).toBe('a\nb')
  })

  it('短的原样', () => {
    expect(tailLines('boom', 12)).toBe('boom')
  })

  it('全是空白时回空串', () => {
    expect(tailLines('\n \n', 12)).toBe('')
  })
})
