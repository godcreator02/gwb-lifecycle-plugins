import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DAILY_HOME,
  DEFAULT_REGISTRY,
  DEFERRED_POLL_MS,
  DEFERRED_TIMEOUT_MS,
  collect,
  devVersion,
  entriesOf,
  errorLines,
  guardHome,
  literalArtifacts,
  parseManifest,
  pnpmPlan,
  runDev,
  samePath,
  type DevDeps,
  type DevInput,
} from '../src/dev.js'

/**
 * 「改一版看一版」那条链最不该靠真跑一遍来确认：拒不拒 default、拒不拒自己所在的 home、
 * 一个包挂了两条条目重不重挂全部、取证到底判的是什么——全是只在边角上现形的判断，而每
 * 演一遍都要一次真发版加一个真 home。所以盘、进程、CDP 三样全注入，整条时序在这儿跑得完。
 */

const REPO = 'D:/fake-repo'
const HOME = 'D:/fake-homes/bn-2609111200'
/**
 * 本件自己住的那个 home。真机上它多半就是 `default`，那时 default 那道守卫先拦下；
 * 这儿故意起个别的名字，为的是让「目标就是自己」那道守卫单独演得出来。
 */
const OWN = 'D:/fake-homes/console-2609111100'
const PKG = '@godcreator/gwb-fake'

/** 一份最小清单：名字、号、一个产物目录 */
const MANIFEST = JSON.stringify({ name: PKG, version: '0.3.1', files: ['dist'] })

interface FakeOptions {
  /** 页面自报的 home。null＝问不出来 */
  home?: string | null
  /** `plugin-manager.list` 回的那张表 */
  packages?: unknown
  /** 第二趟 `plugin-manager.list`（取证那次）。不给就跟第一趟一样 */
  packagesAfter?: unknown
  files?: Record<string, string>
  /** 已经在源上的号 */
  published?: string[]
  /** 日志增量 */
  log?: string
  /** 哪条命令要失败：键是 `<动作> <参数>` 的前缀 */
  failCdp?: string
  failRun?: string
  /** `plugin-manager.remount` 回什么。不给就是普通条目那种：回执之前做完、ACTIVE */
  remount?: (entryId: string) => unknown
  /** remount 之后头几趟 `plugin-manager.list` 没人答（plugin-manager 自己正在回执之后重挂） */
  silentLists?: number
}

function fake(options: FakeOptions = {}): DevDeps & { calls: string[] } {
  const calls: string[] = []
  let listed = 0
  let silent = 0
  const files: Record<string, string> = { [path.resolve(REPO, 'package.json')]: MANIFEST, ...options.files }
  return {
    calls,
    platform: 'win32',
    now: () => Date.UTC(2026, 8, 11, 12, 0),
    readText: (file) => files[path.resolve(file)],
    // 产物照 `files` 白名单问，测试里 dist 一律当在
    exists: (target) => path.resolve(target) in files || target.endsWith('dist') || path.resolve(target) === path.resolve(REPO),
    size: () => 0,
    slice: () => options.log ?? '',
    async sleep(ms) {
      calls.push(`sleep ${String(ms)}`)
    },
    async run(plan, _timeoutMs) {
      calls.push(`run ${plan.args.join(' ')} @${plan.cwd}`)
      const ok = options.failRun === undefined || !plan.args.join(' ').includes(options.failRun)
      return { ok, tail: ok ? '' : '假的失败' }
    },
    async cdp(port, args, _timeoutMs) {
      calls.push(`cdp ${String(port)} ${args.join(' ')}`)
      const key = args.join(' ')
      if (options.failCdp !== undefined && key.startsWith(options.failCdp)) {
        return { ok: false, data: { 回执: { ok: false, error: '假的失败' } }, tail: '' }
      }
      if (args[0] === 'home') {
        const home = options.home === undefined ? HOME : options.home
        return { ok: home !== null, data: { did: 'home', home, why: home === null ? '没有带 homes 的地址' : undefined }, tail: '' }
      }
      if (args[0] === 'cmd' && args[1] === 'plugin-manager.remount') {
        silent = options.silentLists ?? 0
        const entryId = (JSON.parse(args[2] ?? '{}') as { entryId: string }).entryId
        const receipt = options.remount?.(entryId) ?? { ok: true, data: { id: entryId, action: 'remounted', state: 'ACTIVE' } }
        return { ok: true, data: { 回执: receipt }, tail: '' }
      }
      if (args[0] === 'cmd' && args[1] === 'plugin-manager.list') {
        if (silent > 0) {
          silent -= 1
          return { ok: false, data: { 回执: { ok: false, error: '没有这条命令：plugin-manager.list' } }, tail: '' }
        }
        listed += 1
        const table = listed > 1 && options.packagesAfter !== undefined ? options.packagesAfter : options.packages
        return { ok: true, data: { 回执: { ok: true, data: { packages: table ?? [] } } }, tail: '' }
      }
      if (args[0] === 'cmd') return { ok: true, data: { 回执: { ok: true, data: {} } }, tail: '' }
      return { ok: true, data: { did: args[0], 等到了: true }, tail: '' }
    },
    async publish(input) {
      calls.push(`publish ${input.version} @${input.pkgDir}`)
      return { ok: true, tail: '' }
    },
    async published(spec) {
      return (options.published ?? []).includes(spec)
    },
  }
}

function input(over: Partial<DevInput> = {}): DevInput {
  return { home: 'bn-2609111200', repoDir: REPO, packages: [], build: true, registry: DEFAULT_REGISTRY, ownHome: OWN, ...over }
}

/** 一个包挂着一条活条目的清单 */
const ONE_ENTRY = [{ pkg: PKG, entries: [{ entryId: 'home:fake', active: true }] }]

describe('版本号', () => {
  it('patch 加一，戳到分钟', () => {
    expect(devVersion('0.3.1', Date.UTC(2026, 8, 11, 12, 34))).toMatch(/^0\.3\.2-dev\.20260911\d{4}$/)
  })

  it('底版本本身是预发布号时，接着往下走而不是套一层', () => {
    expect(devVersion('0.3.1-dev.202609111200', 0)).toMatch(/^0\.3\.2-dev\./)
  })
})

describe('守卫', () => {
  it('问不出 home 就停——那张页可能根本不是外壳页', () => {
    expect(guardHome({ home: null, why: '没地址' }, OWN, 'win32')).toMatchObject({ ok: false })
  })

  it('default 当场拒', () => {
    const out = guardHome({ home: `D:/homes/${DAILY_HOME}` }, OWN, 'win32')
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('日常')
  })

  it('目标就是自己所在那个 home 也拒——停用条目会把这条命令自己停掉', () => {
    const out = guardHome({ home: OWN }, OWN, 'win32')
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('plugin-manager.update-all')
  })

  it('隔离 home 放行，名字取末段', () => {
    expect(guardHome({ home: HOME }, OWN, 'win32')).toMatchObject({ ok: true, name: 'bn-2609111200' })
  })

  it('Windows 上路径不分大小写，别的平台分', () => {
    expect(samePath('D:/A/b', 'd:/a/B', 'win32')).toBe(true)
    expect(samePath('/A/b', '/a/B', 'linux')).toBe(false)
  })
})

describe('清单与条目', () => {
  it('缺 name 或 version 就不是个能发的包', () => {
    expect(parseManifest('{"name":"x"}')).toBeUndefined()
    expect(parseManifest('半截 json')).toBeUndefined()
    expect(parseManifest(MANIFEST)).toMatchObject({ name: PKG, version: '0.3.1' })
  })

  it('files 里的否定式与通配不算产物——拿它们去问「在不在」必然回不在', () => {
    // 实跑第一趟就撞在 hello 那条 `!py/**/__pycache__` 上：一个好好的包被判成产物不全
    expect(literalArtifacts(['dist', 'skills', 'src', 'py', '!py/**/__pycache__', 'lib/*.js'])).toEqual(['dist', 'skills', 'src', 'py'])
  })

  it('一个包挂了两条条目，两条都要报——只重挂一条的话另一条还攥着旧模块', () => {
    const table = [{ pkg: PKG, entries: [{ entryId: 'home:a', active: true }, { entryId: 'home:a-2', active: false }] }]
    expect(entriesOf({ packages: table }, PKG)).toHaveLength(2)
  })

  it('裸数组的回执也认', () => {
    expect(entriesOf(ONE_ENTRY, PKG)).toEqual([{ entryId: 'home:fake', active: true }])
  })

  it('没有这个包就是空表', () => {
    expect(entriesOf({ packages: ONE_ENTRY }, '@godcreator/别的')).toEqual([])
  })
})

describe('日志', () => {
  it('只有 error 算失败，warn 另报', () => {
    const out = errorLines('2026-09-11T08:00:00.000Z error gwb-fake 炸了\n2026-09-11T08:00:01.000Z warn gwb-fake 少个可选服务\n2026-09-11T08:00:02.000Z info gwb-fake 好着')
    expect(out.errors).toHaveLength(1)
    expect(out.warns).toHaveLength(1)
  })
})

describe('pnpm 的命令行', () => {
  it('Windows 上借 cmd /c 一层，不然 ENOENT', () => {
    expect(pnpmPlan(['add', 'x'], 'D:/h', 'win32')).toMatchObject({ command: 'cmd', args: ['/c', 'pnpm', 'add', 'x'] })
    expect(pnpmPlan(['add', 'x'], '/h', 'linux')).toMatchObject({ command: 'pnpm', args: ['add', 'x'] })
  })
})

describe('一趟', () => {
  it('走完全程：构建、发版、装、重挂、刷新、取证', async () => {
    const deps = fake({ packages: ONE_ENTRY })
    const out = await runDev(input(), deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.shipped[0]?.remounted).toEqual(['home:fake'])
    expect(out.data.evidence.ok).toBe(true)
    // 顺序是硬要求：先问 home，最后一趟 plugin-manager.list 是取证
    expect(deps.calls[0]).toContain('cdp bn-2609111200 home')
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(true)
    expect(deps.calls.at(-1)).toContain('plugin-manager.list')
  })

  it('装了不重挂比没装还糟：每条条目一条 remount，不拆成停用加启用两条', async () => {
    const deps = fake({ packages: ONE_ENTRY })
    await runDev(input(), deps)
    expect(deps.calls.filter((one) => one.includes('plugin-manager.remount'))).toHaveLength(1)
    expect(deps.calls.some((one) => one.includes('plugin-manager.disable') || one.includes('plugin-manager.enable'))).toBe(false)
  })

  it('构建没成就一步都不往下走', async () => {
    const deps = fake({ failRun: 'build' })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('这个号已经在源上就拒，一个包都不发', async () => {
    // 号现算，不写死：devVersion 用的是本地时间，写死的戳换台机器就对不上
    const deps = fake({ published: [`${PKG}@${devVersion('0.3.1', Date.UTC(2026, 8, 11, 12, 0))}`] })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('目标 home 里没有条目：装了，不重挂，回执里说怎么补', async () => {
    const deps = fake({ packages: [] })
    const out = await runDev(input(), deps)
    // 没条目就没东西可判活，但这不是成功——取证那头看不到任何一条活着的条目
    if (out.ok) expect(out.data.shipped[0]?.note).toContain('plugin-manager.install')
    else expect(out.error).toBeTruthy()
  })

  it('重挂之后条目没活过来，当场判失败——这正是「看着成了」的那一种', async () => {
    const deps = fake({ packages: ONE_ENTRY, packagesAfter: [{ pkg: PKG, entries: [{ entryId: 'home:fake', active: false }] }] })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('没挂上')
  })

  it('日志增量里冒出 error 也判失败——挂上了不等于干了活', async () => {
    const deps = fake({ packages: ONE_ENTRY, log: '2026-09-11T08:00:00.000Z error gwb-fake apply 里那条链炸了' })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('error')
  })

  it('目标 home 的 plugin-manager 没有 remount（旧版）：当场停，说清要几版', async () => {
    const deps = fake({ packages: ONE_ENTRY, failCdp: 'cmd plugin-manager.remount' })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('0.4.0')
    expect(deps.calls.some((one) => one.startsWith('cdp bn-2609111200 reload'))).toBe(false)
  })

  it('重挂回执说做完了但没到 ACTIVE，当场判失败', async () => {
    const deps = fake({ packages: ONE_ENTRY, remount: (id) => ({ ok: true, data: { id, action: 'remounted', state: 'PENDING' } }) })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('PENDING')
  })

  it('取证只看这一趟的日志增量，不看全量', async () => {
    const deps = fake({ packages: ONE_ENTRY })
    const evidence = await collect('bn-2609111200', [{ pkg: PKG, version: '0.3.2-dev.x', dir: REPO, remounted: [] }], 'D:/h/gwb.log', 0, deps)
    expect(evidence.ok).toBe(true)
    expect(evidence.entries).toHaveLength(1)
  })
})

describe('部署的正是重挂那条路上的件', () => {
  const PM = '@godcreator/gwb-plugin-manager'
  const COMMANDS = '@godcreator/gwb-commands'
  const manifestOf = (name: string): Record<string, string> => ({
    [path.resolve(REPO, 'package.json')]: JSON.stringify({ name, version: '0.4.0', files: ['dist'] }),
  })
  const deferred = (): unknown => ({ ok: true, data: { id: 'plugin-manager', action: 'deferred', state: 'ACTIVE' } })

  it('plugin-manager 自己：回执先回（deferred），轮询 list 到它重新答话且 active，一趟成', async () => {
    const table = [{ pkg: PM, entries: [{ entryId: 'home:plugin-manager', active: true }] }]
    const deps = fake({ files: manifestOf(PM), packages: table, remount: deferred, silentLists: 3 })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: true })
    if (!out.ok) return
    expect(out.data.shipped[0]?.remounted).toEqual(['home:plugin-manager'])
    // 没人答的那三趟都等过，第四趟答了才往下走
    expect(deps.calls.filter((one) => one.startsWith('sleep'))).toHaveLength(4)
    expect(deps.calls.some((one) => one.includes('plugin-manager.enable'))).toBe(false)
  })

  it('plugin-manager 自己一直没回来：到点 ok:false，说清卡在哪', async () => {
    const table = [{ pkg: PM, entries: [{ entryId: 'home:plugin-manager', active: true }] }]
    const deps = fake({ files: manifestOf(PM), packages: table, remount: deferred, silentLists: Number.MAX_SAFE_INTEGER })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('没有这条命令')
    expect(deps.calls.filter((one) => one.startsWith('sleep'))).toHaveLength(Math.ceil(DEFERRED_TIMEOUT_MS / DEFERRED_POLL_MS))
  })

  it('命令总线：一条 remount 在回执里做完，不轮询', async () => {
    const table = [{ pkg: COMMANDS, entries: [{ entryId: 'home:commands', active: true }] }]
    const deps = fake({ files: manifestOf(COMMANDS), packages: table })
    const out = await runDev(input(), deps)
    expect(out).toMatchObject({ ok: true })
    if (!out.ok) return
    expect(out.data.shipped[0]?.remounted).toEqual(['home:commands'])
    expect(deps.calls.some((one) => one.startsWith('sleep'))).toBe(false)
  })
})