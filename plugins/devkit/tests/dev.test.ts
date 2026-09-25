import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DAILY_HOME,
  DEFERRED_POLL_MS,
  DEFERRED_TIMEOUT_MS,
  DEV_PACKS_DIR,
  RESTART_TIMEOUT_MS,
  SHELL_ENV_COMMAND,
  checkInstalled,
  devPackSpec,
  devVersion,
  entriesOf,
  errorLines,
  guardHome,
  homePnpmPlan,
  installedManifest,
  literalArtifacts,
  packFileName,
  parseManifest,
  pluginManagerCallsFor,
  pnpmPlan,
  runDev,
  samePath,
  type DevDeps,
  type DevInput,
  type PlannedDevPackage,
} from '../src/dev.js'

/**
 * 「改一版看一版」的判断都在边角上：拒不拒 default 与自己所在的 home、库包与撞路径的包文件拒不拒、
 * 已装的走 update 还是 install、插件管理回执里的 ok:false / restartRequired / selfDeferred 各怎么接、取证判的是什么。
 * 每走一遍真的要一个隔离 home，所以磁盘、进程、CDP 全部注入，整条流程在这里跑完
 */

const REPO = 'D:/fake-repo'
const HOME = 'D:/fake-homes/bn-2609111200'
const HOME_NAME = 'bn-2609111200'
/** 本插件自己所在的 home。真机上多半是 default，那时 default 那条检查先拒；这里换个名字，让「目标就是自己」那条单独测得到 */
const OWN = 'D:/fake-homes/console-2609111100'
const PKG = '@godcreator/gwb-fake'
const PM = '@godcreator/gwb-plugin-manager'
const KERNEL = '@godcreator/gwb-kernel-desktop'
const PNPM = 'C:\\Users\\u\\AppData\\Local\\pnpm\\bin\\pnpm.exe'
const NOW = Date.UTC(2026, 8, 11, 12, 0, 7)

/** 一个插件包的清单：名字、版本号、一个产物目录、keywords 里有 gwb-plugin */
const pluginManifest = (name: string, version = '0.3.1'): string => JSON.stringify({ name, version, files: ['dist'], keywords: ['gwb-plugin'] })

/** 目标 home 的清单：装过 PKG，写的是 `^` 范围（plugin-manager.install 写出来的样子） */
const homeManifest = (dependencies: Record<string, string>): string => `${JSON.stringify({ name: HOME_NAME, dependencies }, null, 2)}\n`
const HOME_WITH_PKG = homeManifest({ '@godcreator/gwb-commands': '^0.4.1', [PKG]: '^0.3.1', [PM]: '^0.12.0' })

interface FakeOptions {
  /** 页面自报的 home。null＝问不出来 */
  home?: string | null
  /** 取证那次 `plugin-manager.list` 回的表 */
  packages?: unknown
  files?: Record<string, string>
  /** 日志新增部分 */
  log?: string
  failRun?: string
  failPack?: boolean
  /** `plugin-manager.install` 的回执。不给就是装成、新建条目 home:fake */
  install?: (args: { pkg: string; spec: string }) => unknown
  /** `plugin-manager.update` 的回执。不给就是装成、每个包一条 remounted 的条目 */
  update?: (specs: Record<string, string>) => unknown
  /** 插件管理退出码 0 却没换版本：node_modules 里留着上一版 */
  staleInstall?: boolean
  /** update 之后头几次 `plugin-manager.list` 没人答（插件管理自己正在回执之后重新加载） */
  silentLists?: number
  /** `shell.env` 报的内核版本。null＝回执里没有 versions.kernel */
  runningKernel?: string | null
  failRestart?: string
  /** 整页刷新怎么失败：timeout＝驱动等到超时、回执「等到了」是 false；crash＝驱动退出码非零、没打印 JSON */
  failReload?: 'timeout' | 'crash'
}

interface Fake extends DevDeps {
  calls: string[]
  files: Record<string, string>
  /** 每条 `cmd` 的参数（JSON 解析后），按调用顺序 */
  commandArgs: { command: string; args: unknown }[]
}

function fake(options: FakeOptions = {}): Fake {
  const calls: string[] = []
  const commandArgs: { command: string; args: unknown }[] = []
  let silent = 0
  const files: Record<string, string> = {
    [path.resolve(REPO, 'package.json')]: pluginManifest(PKG),
    [path.resolve(HOME, 'package.json')]: HOME_WITH_PKG,
    [path.resolve(installedManifest(HOME, PKG))]: JSON.stringify({ name: PKG, version: '0.3.1' }),
    ...options.files,
  }
  /** 包名 → 这次打包的版本号：假的插件管理照它把版本号写进 node_modules */
  const packed = new Map<string, string>()
  const landInstalled = (pkg: string): void => {
    const version = packed.get(pkg)
    if (version !== undefined && !options.staleInstall) files[path.resolve(installedManifest(HOME, pkg))] = JSON.stringify({ name: pkg, version })
  }
  const receipt = (value: unknown): { ok: boolean; data: unknown; tail: string } => ({ ok: true, data: { 回执: value }, tail: '' })
  return {
    calls,
    files,
    commandArgs,
    pnpm: PNPM,
    now: () => NOW,
    readText: (file) => files[path.resolve(file)],
    // 产物照 `files` 白名单问，测试里 dist 一律当在
    exists: (target) => path.resolve(target) in files || target.endsWith('dist'),
    size: () => 0,
    slice: () => options.log ?? '',
    async sleep(ms) {
      calls.push(`sleep ${String(ms)}`)
    },
    async run(plan) {
      calls.push(`run ${plan.command === PNPM ? 'pnpm' : plan.command} ${plan.args.join(' ')} @${plan.cwd}`)
      const ok = options.failRun === undefined || !plan.args.join(' ').includes(options.failRun)
      return { ok, tail: ok ? '' : '假的失败' }
    },
    async pack(input) {
      calls.push(`pack ${input.version} @${input.pkgDir} → ${input.destination}`)
      if (options.failPack) return { ok: false, tail: '假的打包失败' }
      const name = parseManifest(files[path.resolve(input.pkgDir, 'package.json')])?.name ?? '没有名字'
      packed.set(name, input.version)
      files[path.resolve(input.destination, packFileName(name, input.version))] = '包文件'
      return { ok: true, tail: '' }
    },
    async cdp(home, args) {
      calls.push(`cdp ${home} ${args.join(' ')}`)
      if (args[0] === 'home') {
        const reported = options.home === undefined ? HOME : options.home
        return { ok: reported !== null, data: { did: 'home', home: reported, why: reported === null ? '没有带 homes 的地址' : undefined }, tail: '' }
      }
      if (args[0] === 'reload' && options.failReload === 'timeout') {
        return { ok: false, data: { did: 'reload', 等到了: false, 等的是: args[1] ?? 'readyState', 最后看到: { ready: 'complete', 出来了: false } }, tail: '' }
      }
      if (args[0] === 'reload' && options.failReload === 'crash') return { ok: false, data: undefined, tail: 'WebSocket 连不上调试端口' }
      if (args[0] !== 'cmd') return { ok: true, data: { did: args[0], 等到了: true }, tail: '' }
      const command = args[1] ?? ''
      const commandArg: unknown = args[2] === undefined ? undefined : JSON.parse(args[2])
      commandArgs.push({ command, args: commandArg })
      if (command === 'plugin-manager.install') {
        const one = commandArg as { pkg: string; spec: string }
        const reply = options.install?.(one) ?? { ok: true, data: { ok: true, pkg: one.pkg, entryId: 'home:fake' } }
        if (isOk(reply)) landInstalled(one.pkg)
        return receipt(reply)
      }
      if (command === 'plugin-manager.update') {
        const { specs } = commandArg as { specs: Record<string, string> }
        silent = options.silentLists ?? 0
        const pkgs = Object.keys(specs)
        const reply = options.update?.(specs) ?? {
          ok: true,
          data: { ok: true, updated: pkgs.map((pkg) => ({ pkg, to: packed.get(pkg), entries: [{ id: 'fake', action: 'remounted', state: 'ACTIVE' }] })), dependents: [], selfDeferred: false },
        }
        if (isOk(reply)) pkgs.forEach(landInstalled)
        return receipt(reply)
      }
      if (command === SHELL_ENV_COMMAND) {
        const versions = options.runningKernel === null || options.runningKernel === undefined ? {} : { kernel: options.runningKernel }
        return receipt({ ok: true, data: { versions } })
      }
      if (command === 'plugin-manager.list') {
        if (silent > 0) {
          silent -= 1
          return { ok: false, data: { 回执: { ok: false, error: '没有这条命令：plugin-manager.list' } }, tail: '' }
        }
        return receipt({ ok: true, data: options.packages ?? ONE_ENTRY })
      }
      return receipt({ ok: true, data: {} })
    },
    async restartHome(home) {
      calls.push(`restart ${home}`)
      return options.failRestart === undefined ? { ok: true, note: '已停 pid 1;启动了(pid 2)' } : { ok: false, error: options.failRestart }
    },
  }
}

function isOk(reply: unknown): boolean {
  return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true
}

function input(over: Partial<DevInput> = {}): DevInput {
  return { home: HOME_NAME, repoDir: REPO, packages: [], ownHome: OWN, ...over }
}

/** 一个包有一条正在运行的条目的表 */
const ONE_ENTRY = [{ pkg: PKG, entries: [{ entryId: 'home:fake', active: true }] }]

const DEV = devVersion('0.3.1', NOW)
const PACK_PATH = path.join(HOME, DEV_PACKS_DIR, packFileName(PKG, DEV))

describe('版本号与包文件名', () => {
  it('patch 加一，时间到秒', () => {
    expect(devVersion('0.3.1', Date.UTC(2026, 8, 11, 12, 34, 56))).toMatch(/^0\.3\.2-dev\.20260911\d{6}$/)
  })

  it('底版本本身是预发布号时，接着往下走而不是再套一层', () => {
    expect(devVersion('0.3.1-dev.20260911120000', 0)).toMatch(/^0\.3\.2-dev\./)
  })

  it('包文件名照 pnpm pack 的默认写法：scope 去掉 @、斜杠换成连字符', () => {
    expect(packFileName('@godcreator/gwb-fake', '0.3.2-dev.20260911120007')).toBe('godcreator-gwb-fake-0.3.2-dev.20260911120007.tgz')
  })

  it('交给插件管理的写法相对 home', () => {
    expect(devPackSpec('a-1.0.0.tgz')).toBe('file:./dev-packs/a-1.0.0.tgz')
  })
})

describe('检查目标', () => {
  it('问不出 home 就停——那张页可能根本不是外壳页', () => {
    expect(guardHome({ home: null, why: '没地址' }, OWN)).toMatchObject({ ok: false })
  })

  it('default 当场拒', () => {
    const out = guardHome({ home: `D:/homes/${DAILY_HOME}` }, OWN)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('日常')
  })

  it('目标就是自己所在的 home 也拒，指向发正式版再 update', () => {
    const out = guardHome({ home: OWN }, OWN)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('plugin-manager.update {"all":true}')
  })

  it('页面自报的名字和点名的不一样就拒', () => {
    expect(guardHome({ home: HOME }, OWN, 'other-2609111200')).toMatchObject({ ok: false })
  })

  it('隔离 home 放行，名字取末段', () => {
    expect(guardHome({ home: HOME }, OWN, HOME_NAME)).toMatchObject({ ok: true, name: HOME_NAME })
  })

  it('路径一律不分大小写比较', () => {
    expect(samePath('D:/A/b', 'd:/a/B')).toBe(true)
    expect(samePath('D:/a/b', 'D:/a/c')).toBe(false)
  })
})

describe('清单与条目', () => {
  it('缺 name 或 version 就不是个能装的包；keywords 里有 gwb-plugin 才算插件', () => {
    expect(parseManifest('{"name":"x"}')).toBeUndefined()
    expect(parseManifest('半截 json')).toBeUndefined()
    expect(parseManifest(pluginManifest(PKG))).toMatchObject({ name: PKG, version: '0.3.1', plugin: true })
    expect(parseManifest(JSON.stringify({ name: 'lib', version: '1.0.0' }))).toMatchObject({ plugin: false })
  })

  it('files 里的否定式与通配不算产物——拿它们去问「在不在」必然回不在', () => {
    expect(literalArtifacts(['dist', 'skills', 'src', 'py', '!py/**/__pycache__', 'lib/*.js'])).toEqual(['dist', 'skills', 'src', 'py'])
  })

  it('一个包有两条条目，两条都要报', () => {
    const table = [{ pkg: PKG, entries: [{ entryId: 'home:a', active: true }, { entryId: 'home:a-2', active: false }] }]
    expect(entriesOf(table, PKG)).toHaveLength(2)
  })

  it('list 回执的 data 是包的数组；不是数组、或表里没有这个包，都是空表', () => {
    expect(entriesOf(ONE_ENTRY, PKG)).toEqual([{ entryId: 'home:fake', active: true }])
    expect(entriesOf({ packages: ONE_ENTRY }, PKG)).toEqual([])
    expect(entriesOf(ONE_ENTRY, '@godcreator/别的')).toEqual([])
  })
})

describe('交给插件管理的两种调用', () => {
  const plannedOf = (name: string, extra: Partial<PlannedDevPackage['manifest']> = {}): PlannedDevPackage => ({
    pkgDir: `D:/r/${name}`,
    manifest: { name, version: '0.1.0', plugin: name !== KERNEL, ...extra },
    version: '0.1.1-dev.1',
    packFile: packFileName(name, '0.1.1-dev.1'),
  })

  it('已在 dependencies 里的进 specs，不在的插件逐个 install', () => {
    const out = pluginManagerCallsFor([plannedOf(PKG), plannedOf('@godcreator/gwb-new')], { [PKG]: '^0.1.0' })
    expect(out).toEqual({
      ok: true,
      calls: {
        specs: { [PKG]: 'file:./dev-packs/godcreator-gwb-fake-0.1.1-dev.1.tgz' },
        installs: [{ pkg: '@godcreator/gwb-new', spec: 'file:./dev-packs/godcreator-gwb-new-0.1.1-dev.1.tgz' }],
      },
    })
  })

  it('内核包连同 peer 里 cordis 的精确版本号放进同一条 update', () => {
    const out = pluginManagerCallsFor([plannedOf(KERNEL, { peerCordis: '4.0.0-rc.10' })], { [KERNEL]: '0.5.0', cordis: '4.0.0-rc.9' })
    expect(out.ok && out.calls.specs).toEqual({ [KERNEL]: 'file:./dev-packs/godcreator-gwb-kernel-desktop-0.1.1-dev.1.tgz', cordis: '4.0.0-rc.10' })
  })

  it('内核包不在目标 home 里直接拒', () => {
    expect(pluginManagerCallsFor([plannedOf(KERNEL, { peerCordis: '4.0.0-rc.10' })], {})).toMatchObject({ ok: false })
  })
})

describe('日志', () => {
  it('只有 error 算失败，warn 另报', () => {
    const out = errorLines('2026-09-11T08:00:00.000Z error gwb-fake 出错了\n2026-09-11T08:00:01.000Z warn gwb-fake 少个可选服务\n2026-09-11T08:00:02.000Z info gwb-fake 正常')
    expect(out.errors).toHaveLength(1)
    expect(out.warns).toHaveLength(1)
  })
})

describe('pnpm 的命令行', () => {
  it('直接启动找到的那个 pnpm 可执行文件，不经 shell；在插件仓里运行不改 pnpm 的配置，peer 照 pnpm 默认自动装进仓的 node_modules', () => {
    expect(pnpmPlan(['build'], 'D:/repo', PNPM)).toEqual({ command: PNPM, args: ['build'], cwd: 'D:/repo' })
  })

  it('在 home 里运行的 pnpm 不自动补装缺的 peer：带上关掉它的环境变量', () => {
    expect(homePnpmPlan(['install'], 'D:/h', PNPM)).toEqual({ command: PNPM, args: ['install'], cwd: 'D:/h', env: { pnpm_config_auto_install_peers: 'false' } })
  })
})

describe('一次流程', () => {
  it('已装的包：构建、打包进 dev-packs、一条 update {specs}、带 waitFor 刷新、取证', async () => {
    const deps = fake()
    const out = await runDev(input({ waitFor: '#app' }), deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(deps.calls[0]).toBe(`cdp ${HOME_NAME} home`)
    expect(deps.calls.some((one) => one === `run pnpm build @${REPO}`)).toBe(true)
    expect(deps.commandArgs.map((one) => one.command)).toEqual(['plugin-manager.update', 'plugin-manager.list'])
    expect(deps.commandArgs[0]?.args).toEqual({ specs: { [PKG]: devPackSpec(packFileName(PKG, DEV)) } })
    expect(deps.calls).toContain(`cdp ${HOME_NAME} reload #app`)
    expect(out.data.shipped).toEqual([{ pkg: PKG, version: DEV, dir: path.resolve(REPO), packFile: PACK_PATH, via: 'update' }])
    expect(out.data.update).toMatchObject({ ok: true, selfDeferred: false })
    expect(out.data.evidence).toMatchObject({ ok: true, installed: [{ pkg: PKG, expected: DEV, actual: DEV }] })
    // 最后一步是取证
    expect(deps.calls.at(-1)).toContain('plugin-manager.list')
  })

  it('不在目标 home 里的插件：plugin-manager.install 新建条目，不调 update', async () => {
    const deps = fake({ files: { [path.resolve(HOME, 'package.json')]: homeManifest({ '@godcreator/gwb-commands': '^0.4.1' }) } })
    const out = await runDev(input(), deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(deps.commandArgs[0]).toEqual({ command: 'plugin-manager.install', args: { pkg: PKG, spec: devPackSpec(packFileName(PKG, DEV)) } })
    expect(deps.commandArgs.some((one) => one.command === 'plugin-manager.update')).toBe(false)
    expect(out.data.shipped[0]).toMatchObject({ via: 'install', entryId: 'home:fake' })
    expect(out.data).not.toHaveProperty('update')
  })

  it('install 没成：带上插件管理的原因，不刷新', async () => {
    const deps = fake({
      files: { [path.resolve(HOME, 'package.json')]: homeManifest({}) },
      install: (one) => ({ ok: false, error: `pnpm add ${one.pkg} 失败`, data: { ok: false, pkg: one.pkg } }),
    })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain(`pnpm add ${PKG} 失败`)
    expect(deps.calls.some((one) => one.includes(' reload'))).toBe(false)
  })

  it('构建没成就一步都不往下走', async () => {
    const deps = fake({ failRun: 'build' })
    expect(await runDev(input(), deps)).toMatchObject({ ok: false })
    expect(deps.calls.some((one) => one.startsWith('pack'))).toBe(false)
  })

  it('库包（keywords 里没有 gwb-plugin）直接拒，什么都不打包', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'package.json')]: JSON.stringify({ name: '@godcreator/gwb-lib', version: '0.1.0', files: ['dist'] }) } })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('库打包进用它的插件')
    expect(deps.calls.some((one) => one.startsWith('pack'))).toBe(false)
  })

  it('这次的包文件路径已经存在直接拒：同一路径覆盖写，pnpm 退出码 0 却装着旧代码', async () => {
    const deps = fake({ files: { [path.resolve(PACK_PATH)]: '上一次的包文件' } })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain(PACK_PATH)
    expect(deps.calls.some((one) => one.startsWith('pack'))).toBe(false)
    // 旧包文件原样留着
    expect(deps.files[path.resolve(PACK_PATH)]).toBe('上一次的包文件')
  })

  it('打包没成：不调插件管理', async () => {
    const deps = fake({ failPack: true })
    expect(await runDev(input(), deps)).toMatchObject({ ok: false })
    expect(deps.commandArgs).toEqual([])
  })

  it('update 回执 ok:false：整体失败，带上回执里的 error，不刷新', async () => {
    const deps = fake({ update: () => ({ ok: false, error: 'pnpm add 失败。一条条目都没动', data: { ok: false, updated: [], dependents: [], selfDeferred: false } }) })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('pnpm add 失败。一条条目都没动')
    expect(deps.calls.some((one) => one.includes(' reload'))).toBe(false)
  })

  it('selfDeferred：轮询 plugin-manager.list 到插件管理的条目重新答话且 active，再刷新', async () => {
    const files = { [path.resolve(REPO, 'package.json')]: pluginManifest(PM, '0.12.0'), [path.resolve(installedManifest(HOME, PM))]: JSON.stringify({ name: PM, version: '0.12.0' }) }
    const table = [{ pkg: PM, entries: [{ entryId: 'home:plugin-manager', active: true }] }]
    const deps = fake({
      files,
      packages: table,
      silentLists: 3,
      update: (specs) => ({ ok: true, data: { ok: true, updated: [{ pkg: PM, to: specs[PM], entries: [{ id: 'plugin-manager', action: 'deferred', state: 'ACTIVE' }] }], dependents: [], selfDeferred: true } }),
    })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: true })
    // 没人答的三次都等过，第四次答了才往下走
    expect(deps.calls.filter((one) => one.startsWith('sleep'))).toHaveLength(4)
    expect(deps.calls.some((one) => one.startsWith(`cdp ${HOME_NAME} reload`))).toBe(true)
  })

  it('selfDeferred 之后插件管理一直没回来：到点 ok:false，说清卡在哪，不刷新', async () => {
    const deps = fake({
      silentLists: Number.MAX_SAFE_INTEGER,
      update: () => ({ ok: true, data: { ok: true, updated: [], dependents: [{ pkg: PM, entries: [{ id: 'plugin-manager', action: 'deferred', state: 'ACTIVE' }] }], selfDeferred: true } }),
    })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('没有这条命令')
    expect(deps.calls.filter((one) => one.startsWith('sleep'))).toHaveLength(Math.ceil(DEFERRED_TIMEOUT_MS / DEFERRED_POLL_MS))
    expect(deps.calls.some((one) => one.includes(' reload'))).toBe(false)
  })

  it('没给 waitFor：刷新只带 reload 一个动作', async () => {
    const deps = fake()
    await runDev(input(), deps)
    expect(deps.calls).toContain(`cdp ${HOME_NAME} reload`)
  })

  it('刷新等到超时（等到了 是 false）：整体 ok:false，说清等的是什么、最后看到了什么，不取证', async () => {
    const deps = fake({ failReload: 'timeout' })
    const out = await runDev(input({ waitFor: '#app' }), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) {
      expect(out.error).toContain('整页刷新没成')
      expect(out.error).toContain('#app')
      expect(out.error).toContain('"出来了":false')
    }
    expect(deps.commandArgs.some((one) => one.command === 'plugin-manager.list')).toBe(false)
  })

  it('刷新时驱动退出码非零、没打印 JSON：整体 ok:false，带上驱动的输出', async () => {
    const out = await runDev(input(), fake({ failReload: 'crash' }))
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) {
      expect(out.error).toContain('readyState')
      expect(out.error).toContain('WebSocket 连不上调试端口')
    }
  })
})

describe('取证', () => {
  it('条目没到 ACTIVE，当场判失败', async () => {
    const out = await runDev(input(), fake({ packages: [{ pkg: PKG, entries: [{ entryId: 'home:fake', active: false }] }] }))
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('没加载成功')
  })

  it('装的插件在条目表里一条都没有：判失败，点名那个包', async () => {
    const out = await runDev(input(), fake({ packages: [{ pkg: '@godcreator/别的', entries: [{ entryId: 'home:other', active: true }] }] }))
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain(`${PKG}(条目表里没有它)`)
  })

  it('日志新增部分里有 error 也判失败', async () => {
    const out = await runDev(input(), fake({ log: '2026-09-11T08:00:00.000Z error gwb-fake apply 里那条链出错了' }))
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('error')
  })

  it('装上的版本号不是这次打包的：说清两个版本号', async () => {
    const out = await runDev(input(), fake({ staleInstall: true }))
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) {
      expect(out.error).toContain(DEV)
      expect(out.error).toContain('实际装上的是 0.3.1')
    }
  })

  it('核对装上的版本号：对得上、对不上、读不到三种', () => {
    const files: Record<string, string> = {
      [path.resolve(installedManifest(HOME, '@godcreator/gwb-a'))]: JSON.stringify({ name: '@godcreator/gwb-a', version: '0.7.2-dev.20260917183700' }),
      [path.resolve(installedManifest(HOME, '@godcreator/gwb-b'))]: JSON.stringify({ name: '@godcreator/gwb-b', version: '0.7.2-dev.20260917183400' }),
    }
    const out = checkInstalled(
      HOME,
      [
        { pkg: '@godcreator/gwb-a', version: '0.7.2-dev.20260917183700' },
        { pkg: '@godcreator/gwb-b', version: '0.7.2-dev.20260917183700' },
        { pkg: '@godcreator/gwb-c', version: '1.0.0' },
      ],
      (file) => files[path.resolve(file)],
    )
    expect(out.rows.map((row) => row.actual)).toEqual(['0.7.2-dev.20260917183700', '0.7.2-dev.20260917183400', null])
    expect(out.wrong.map((row) => row.pkg)).toEqual(['@godcreator/gwb-b', '@godcreator/gwb-c'])
  })
})

describe('装内核包', () => {
  const KERNEL_DIR = 'apps/desktop'
  const kernelManifest = (peerCordis: string): string => JSON.stringify({ name: KERNEL, version: '0.5.0', files: ['dist'], peerDependencies: { cordis: peerCordis } })
  const kernelFiles = (peerCordis = '4.0.0-rc.10', dependencies: Record<string, string> = { [KERNEL]: '0.5.0', cordis: '4.0.0-rc.9', [PKG]: '^0.3.1' }): Record<string, string> => ({
    [path.resolve(REPO, KERNEL_DIR, 'package.json')]: kernelManifest(peerCordis),
    [path.resolve(HOME, 'package.json')]: homeManifest(dependencies),
  })
  const kernelDev = devVersion('0.5.0', NOW)
  const restartReceipt = (specs: Record<string, string>): unknown => ({
    ok: true,
    data: { ok: true, updated: Object.keys(specs).map((pkg) => ({ pkg, to: '?', entries: [] })), dependents: [], selfDeferred: false, restartRequired: true },
  })

  it('内核包连同 cordis 放进同一条 update；回执 restartRequired 就重启目标 home，不刷新，页面报出的就是这次的版本号', async () => {
    const deps = fake({ files: kernelFiles(), runningKernel: kernelDev, update: restartReceipt })
    const out = await runDev(input({ packages: [KERNEL_DIR] }), deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(deps.commandArgs[0]?.args).toEqual({ specs: { [KERNEL]: devPackSpec(packFileName(KERNEL, kernelDev)), cordis: '4.0.0-rc.10' } })
    expect(out.data.kernel).toEqual({ version: kernelDev, restart: '已停 pid 1;启动了(pid 2)' })
    expect(out.data).not.toHaveProperty('reload')
    expect(deps.calls).toContain(`restart ${HOME_NAME}`)
    expect(deps.calls.some((one) => one.startsWith(`cdp ${HOME_NAME} reload`))).toBe(false)
  })

  it('内核包和插件一起装：一条 update，重启一次', async () => {
    const files = { ...kernelFiles(), [path.resolve(REPO, 'plugins/fake', 'package.json')]: pluginManifest(PKG) }
    const deps = fake({ files, runningKernel: kernelDev, update: restartReceipt })
    const out = await runDev(input({ packages: [KERNEL_DIR, 'plugins/fake'] }), deps)
    expect(out.ok).toBe(true)
    expect(deps.commandArgs.filter((one) => one.command === 'plugin-manager.update')).toHaveLength(1)
    expect(deps.calls.filter((one) => one.startsWith('restart'))).toHaveLength(1)
  })

  it('内核包不在目标 home 里：直接拒，什么都不打包', async () => {
    const deps = fake({ files: kernelFiles('4.0.0-rc.10', { [PKG]: '^0.3.1' }) })
    const out = await runDev(input({ packages: [KERNEL_DIR] }), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('没有内核包')
    expect(deps.calls.some((one) => one.startsWith('pack'))).toBe(false)
  })

  it('内核包 peer 里的 cordis 写的是范围：什么都不打包', async () => {
    const deps = fake({ files: kernelFiles('^4.0.0-rc.10') })
    const out = await runDev(input({ packages: [KERNEL_DIR] }), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('不是精确版本号')
    expect(deps.calls.some((one) => one.startsWith('pack'))).toBe(false)
  })

  it('装了内核包而回执里没有 restartRequired：判失败，不重启', async () => {
    const deps = fake({ files: kernelFiles(), runningKernel: kernelDev })
    const out = await runDev(input({ packages: [KERNEL_DIR] }), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('restartRequired')
    expect(deps.calls.some((one) => one.startsWith('restart'))).toBe(false)
  })

  it('重启没成：说清是装上之后停在了重启', async () => {
    const out = await runDev(input({ packages: [KERNEL_DIR] }), fake({ files: kernelFiles(), update: restartReceipt, failRestart: 'CDP 9400 端口上监听的是别的进程' }))
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('CDP 9400')
  })

  it('重启之后页面报的内核版本不是这次的：当场判失败，不接着等', async () => {
    const deps = fake({ files: kernelFiles(), update: restartReceipt, runningKernel: '0.5.0' })
    const out = await runDev(input({ packages: [KERNEL_DIR] }), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('0.5.0')
    expect(deps.commandArgs.filter((one) => one.command === SHELL_ENV_COMMAND)).toHaveLength(1)
  })

  it('shell.env 一直报不出内核版本：到点 ok:false，说清卡在哪', async () => {
    const out = await runDev(input({ packages: [KERNEL_DIR] }), fake({ files: kernelFiles(), update: restartReceipt, runningKernel: null }))
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain(`${String(RESTART_TIMEOUT_MS / 1000)} 秒`)
  })
})
