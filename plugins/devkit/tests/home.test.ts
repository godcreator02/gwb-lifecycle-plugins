import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALIVE_POLL_MS,
  ALIVE_TIMEOUT_MS,
  BASE_INSTALL_TIMEOUT_MS,
  CDP_PORT_BASE,
  DAILY_HOME,
  EXIT_POLL_MS,
  EXIT_TIMEOUT_MS,
  REMOVE_RETRY_MS,
  REMOVE_TRIES,
  asCdpPort,
  asHomeName,
  bringDownHome,
  composeName,
  guiChildEnv,
  hostAppFacts,
  hostAppSpawnPlan,
  isHomeProcess,
  launchHome,
  listHomes,
  minuteStamp,
  nextName,
  pickCdpPort,
  portsInRecords,
  parseRecord,
  recordFile,
  removeHome,
  resolveTarget,
  secondStamp,
  type HomeDeps,
  type HomeFs,
  type HomeRecord,
} from '../src/home.js'

/**
 * 起停删这件事最不该靠手工点几遍来确认：名字撞不撞、build 失败起不起、查得出的 pid
 * 才敢不敢杀、default 守不守得住——全是只在边角上才现形的判断。fs 与开进程都是注入的，
 * 整条时序在这里跑得完，不必真拉起一扇 electron 窗。
 */

const ROOT = 'D:/fake-homes'
const NAME = 'data-2609081430'
const HOME = path.join(ROOT, NAME)
const HOST = 'C:/apps/gwb-kernel.exe'
const RECORD: HomeRecord = { pid: 4242, startedAt: 1_000, appDir: 'D:/fake-app' }

/** 内核会往 home 里写的那份。**devkit 只读它**，所以测试里由测试自己摆 */
const write = (record: HomeRecord): string => JSON.stringify(record)

/** 一个内存盘：文件表 + 目录表。removeDir 的错误是注进去的——EBUSY 那条路要能演出来 */
function fakeFs(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
  removeDirError?: string,
  /** removeDir 回 ok（或回 removeDirError）、目录却还在（剩下这几个子目录） */
  leftAfterRemove?: string[],
  /** 前几次删是上面那样没删掉，之后删得掉；不给＝一直删不掉 */
  stubbornTimes = Number.POSITIVE_INFINITY,
): HomeFs & { files: Map<string, string>; removed: string[]; removeCalls: number } {
  const table = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k), v]))
  const dirTable = new Map(Object.entries(dirs).map(([k, v]) => [path.resolve(k), v]))
  const removed: string[] = []
  return {
    files: table,
    removed,
    removeCalls: 0,
    exists: (target) => {
      const key = path.resolve(target)
      if (table.has(key) || dirTable.has(key)) return true
      // 目录表记的是「父目录 → 子目录名」:名字在册就算存在
      for (const [parent, names] of dirTable) {
        if (names.includes(path.basename(key)) && path.dirname(key) === parent) return true
      }
      return false
    },
    readText: (file) => table.get(path.resolve(file)),
    writeText: (file, text) => {
      table.set(path.resolve(file), text)
    },
    remove: (file) => {
      table.delete(path.resolve(file))
    },
    ensureDir: (dir) => {
      dirTable.set(path.resolve(dir), dirTable.get(path.resolve(dir)) ?? [])
    },
    dirs: (target) => dirTable.get(path.resolve(target)) ?? [],
    removeDir(dir) {
      const key = path.resolve(dir)
      this.removeCalls += 1
      if (leftAfterRemove !== undefined && this.removeCalls <= stubbornTimes) {
        dirTable.set(key, leftAfterRemove)
        return removeDirError === undefined ? { ok: true } : { ok: false, error: removeDirError }
      }
      if (removeDirError !== undefined && leftAfterRemove === undefined) return { ok: false, error: removeDirError }
      removed.push(key)
      dirTable.delete(key)
      const parent = dirTable.get(path.dirname(key))
      if (parent !== undefined) dirTable.set(path.dirname(key), parent.filter((one) => one !== path.basename(key)))
      return { ok: true }
    },
  }
}

interface FakeOptions {
  fs?: HomeFs
  /** pid → 映像名。表里没有的 pid 就是「进程不在」 */
  processes?: Record<number, string>
  /** 这些 pid 查不出（tasklist 超时或出错），跟「不在」是两回事 */
  unknownPids?: number[]
  spawnPid?: number | undefined
  spawnFails?: boolean
  /** 宿主命令行（argv），appSpawnPlan 的事实来源；缺省＝安装版形态（命令行上只有 exe 自己） */
  argv?: string[]
  /** run 的答案，按顺序取；用完了重复最后一个 */
  runs?: { ok: boolean; tail: string }[]
  /** kill 的收场：默认停成了；'gone' 是下手时已经不在，给一个 Error 是它抛 */
  kill?: 'killed' | 'gone' | Error
  /** 停成了之后进程还要被查到几次 running 才真退；Infinity＝一直不退 */
  exitAfterPolls?: number
  /** CDP 口上 listen 的那个 pid；不给就是「取不出来」（那时只按映像名那道判据走） */
  portOwner?: number
  execPath?: string
  platform?: NodeJS.Platform
}

function fakeDeps(options: FakeOptions = {}) {
  const runs = options.runs ?? []
  const state = {
    clock: 1_000,
    killed: [] as number[],
    portsAsked: [] as number[],
    spawned: [] as { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[],
    runCalls: [] as { plan: { command: string; args: string[]; cwd: string }; timeoutMs: number }[],
    slept: [] as number[],
    pollsAfterKill: 0,
  }
  const execPath = options.execPath ?? HOST
  const deps: HomeDeps = {
    fs: options.fs ?? fakeFs(),
    spawn(plan, env) {
      state.spawned.push({ ...plan, env })
      if (options.spawnFails === true) return undefined
      return options.spawnPid === undefined && !('spawnPid' in options) ? 4242 : options.spawnPid
    },
    async appSpawnPlan(cdp) {
      return hostAppSpawnPlan({ execPath, ...hostAppFacts(execPath, options.argv ?? [execPath]) }, cdp)
    },
    async run(plan, timeoutMs) {
      state.runCalls.push({ plan, timeoutMs })
      return runs[Math.min(state.runCalls.length - 1, runs.length - 1)] ?? { ok: true, tail: '' }
    },
    processName(pid) {
      if (options.unknownPids?.includes(pid) === true) return Promise.resolve({ state: 'unknown' })
      const name = options.processes?.[pid]
      if (name !== undefined && state.killed.includes(pid)) {
        // 停过的进程：再被查到 exitAfterPolls 次 running 之后才不在
        state.pollsAfterKill += 1
        if (state.pollsAfterKill > (options.exitAfterPolls ?? 0)) return Promise.resolve({ state: 'gone' })
      }
      return Promise.resolve(name === undefined ? { state: 'gone' } : { state: 'running', name })
    },
    portOwner(port) {
      state.portsAsked.push(port)
      return Promise.resolve(options.portOwner)
    },
    kill(pid) {
      state.killed.push(pid)
      const outcome = options.kill ?? 'killed'
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    sleep(ms) {
      state.slept.push(ms)
      state.clock += ms
      return Promise.resolve()
    },
    now: () => state.clock,
    execPath,
    env: { PATH: 'x', npm_config_registry: 'http://nope/', ELECTRON_RUN_AS_NODE: '1' },
    platform: options.platform ?? 'win32',
  }
  return { deps, state }
}

describe('命名：本地时间的 yyMMddHHmm，撞了退到秒，再撞就拒', () => {
  it('时间半段用本地时间，两位补零', () => {
    const at = new Date(2026, 8, 8, 7, 5).getTime()
    expect(minuteStamp(at)).toBe('2609080705')
    expect(composeName('data', at)).toBe('data-2609080705')
    expect(secondStamp(new Date(2026, 8, 8, 7, 5, 9).getTime())).toBe('260908070509')
  })

  it('分钟名字空着就用分钟；被占了退到秒', () => {
    const at = new Date(2026, 8, 8, 7, 5).getTime()
    expect(nextName('data', at, () => false)).toBe('data-2609080705')
    expect(nextName('data', at, (n) => n === 'data-2609080705')).toBe('data-260908070500')
  })

  it('秒也被占：照实拒，不静默加序号', () => {
    const at = new Date(2026, 8, 8, 7, 5).getTime()
    expect(() => nextName('data', at, (n) => n === 'data-2609080705' || n === 'data-260908070500')).toThrow(
      /换个 short/,
    )
  })
})

describe('运行时记录与参数收窄', () => {
  it('读得回来的是内核写的那份；半截 JSON、形状不对、pid 不像样都当没有', () => {
    const full: HomeRecord = {
      ...RECORD,
      cdp: 9222,
      mcp: { port: 2870, url: 'http://127.0.0.1:2870/mcp' },
      commandHttp: { port: 2871, url: 'http://127.0.0.1:2871' },
    }
    expect(parseRecord(JSON.stringify({ ...full, 'command-http': full.commandHttp, mcp: full.mcp }))).toEqual(full)
    expect(parseRecord(undefined)).toBeUndefined()
    expect(parseRecord('{ half')).toBeUndefined()
    expect(parseRecord('[]')).toBeUndefined()
    expect(parseRecord(JSON.stringify({ pid: -1, startedAt: 1 }))).toBeUndefined()
    expect(parseRecord(JSON.stringify({ pid: 4242 }))).toBeUndefined()
  })

  it('缺一格不算坏：cdp 与两道门是「那件事没发生」，不是这份记录不能用', () => {
    // 起的时候没带调试口，或者那个 home 根本没装门插件——两样都是常态
    expect(parseRecord(JSON.stringify({ ...RECORD, cdp: 'x' }))).toEqual(RECORD)
    expect(parseRecord(JSON.stringify({ ...RECORD, mcp: { port: 2870 } }))).toEqual(RECORD)
    expect(parseRecord(JSON.stringify({ ...RECORD, mcp: 'nope' }))).toEqual(RECORD)
    expect(parseRecord(JSON.stringify({ ...RECORD, 'command-http': { url: 'http://x' } }))).toEqual(RECORD)
    // 老格遗物（换门时代的写者留的）是认不得的字段，随它去
    expect(parseRecord(JSON.stringify({ ...RECORD, 将来: 1 }))).toEqual(RECORD)
  })

  it('名字的收窄：内核那道正则说了算', () => {
    expect(asHomeName('data-2609081430')).toBe('data-2609081430')
    for (const bad of ['../../x', 'Data', 'data--x', 'data-', 42, undefined]) {
      expect(asHomeName(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('启动计划：拉宿主自己那个 exe', () => {
  it('安装版（exe 不叫 electron）：直起本体，不带应用路径参数', () => {
    expect(hostAppFacts(HOST, [HOST])).toEqual({ packaged: true })
    expect(hostAppSpawnPlan({ execPath: HOST, packaged: true }, 9400)).toEqual({
      command: HOST,
      args: ['--remote-debugging-port=9400', '--disable-backgrounding-occluded-windows'],
      cwd: 'C:/apps',
    })
  })

  it('带调试口必带遮挡开关：窗口被盖住时 Chromium 停止产帧，取证的输入与截图会挂住或拿陈旧帧', () => {
    expect(hostAppSpawnPlan({ execPath: HOST, packaged: true }, 9400).args).toContain(
      '--disable-backgrounding-occluded-windows',
    )
  })

  it('不带调试口：命令行上就没有那个开关', () => {
    expect(hostAppSpawnPlan({ execPath: HOST, packaged: true }).args).toEqual([])
  })

  it('开发态 electron：argv[1] 是应用目录，作为参数带上', () => {
    const facts = hostAppFacts('C:/apps/electron.exe', ['C:/apps/electron.exe', 'D:/kernel/apps/desktop'])
    expect(facts).toEqual({ packaged: false, appPath: 'D:/kernel/apps/desktop' })
    expect(hostAppSpawnPlan({ execPath: 'C:/apps/electron.exe', ...facts }, 9400)).toEqual({
      command: 'C:/apps/electron.exe',
      args: ['D:/kernel/apps/desktop', '--remote-debugging-port=9400', '--disable-backgrounding-occluded-windows'],
      cwd: 'D:/kernel/apps/desktop',
    })
  })

  it('开发态却读不出应用目录：拒——devkit 只从安装版起 home', () => {
    expect(hostAppFacts('C:/apps/electron.exe', ['C:/apps/electron.exe'])).toEqual({ packaged: false })
    expect(() => hostAppSpawnPlan({ execPath: 'C:/apps/electron.exe', packaged: false }, 9400)).toThrow(/安装版/)
  })

  it('环境剥 ELECTRON_RUN_AS_NODE 与 npm_config_*，给 GWB_HOME', () => {
    const env = guiChildEnv(
      { PATH: 'x', npm_config_registry: 'http://nope/', NPM_CONFIG_USERCONFIG: 'C:/leak', ELECTRON_RUN_AS_NODE: '1' },
      NAME,
    )
    expect(env.GWB_HOME).toBe(NAME)
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.npm_config_registry).toBeUndefined()
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined()
    expect(env.PATH).toBe('x')
  })

  it('映像名：认 electron 与宿主自己，不认 node——那是 registry 的判据，这半的子进程不是 node', () => {
    expect(isHomeProcess('electron.exe', 'C:/apps/electron.exe')).toBe(true)
    // 打包后的宿主：名字对不上 electron，但子进程永远是仓里那份 electron
    expect(isHomeProcess('electron.exe', 'C:/apps/gwb-kernel.exe')).toBe(true)
    expect(isHomeProcess('node.exe', 'C:/apps/electron.exe')).toBe(false)
    expect(isHomeProcess('chrome.exe', 'C:/apps/electron.exe')).toBe(false)
    expect(isHomeProcess(undefined, 'C:/apps/electron.exe')).toBe(false)
  })
})

describe('launchHome：拼宿主拉起计划、起它、落记录、看五秒', () => {
  it('开发态 electron 上读不出应用目录：拒，一个动作都不做', async () => {
    const { deps, state } = fakeDeps({ execPath: 'C:/apps/electron.exe', argv: ['C:/apps/electron.exe'] })
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('安装版')
    expect(state.spawned).toEqual([])
    expect(state.runCalls).toEqual([])
  })

  it('底座装不上：不起宿主，尾巴带回来', async () => {
    const { deps, state } = fakeDeps({ runs: [{ ok: false, tail: 'ERR!坏的' }] })
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, base: true }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('ERR!坏的')
    expect(state.spawned).toEqual([])
  })

  it('base：先写 cordis.yml 再 pnpm add 底座（超时上限 BASE_INSTALL_TIMEOUT_MS），然后才拉宿主', async () => {
    const fs = fakeFs({}, { [ROOT]: [] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'gwb-kernel.exe' } })
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, base: true }, deps)
    expect(outcome.ok).toBe(true)
    expect(state.runCalls).toHaveLength(1)
    expect(state.runCalls[0]?.timeoutMs).toBe(BASE_INSTALL_TIMEOUT_MS)
    expect(state.runCalls[0]?.plan.cwd).toBe(HOME)
    expect(state.runCalls[0]?.plan.args).toContain('@godcreator/gwb-commands')
    expect(deps.fs.exists(path.join(HOME, 'cordis.yml'))).toBe(true)
    expect(state.spawned).toHaveLength(1)
  })

  it('起得来：环境与观察窗全对，记录由内核写、这儿只读回来报给人', async () => {
    const fs = fakeFs()
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'gwb-kernel.exe' } })
    // 记录是**起来之后**才出现的（内核开机写的那一下），所以让假的 spawn 顺手把它摆上——
    // 一开始就摆在盘上的话，那份记录会被当成「已经有一个实例在跑」
    const spawn = deps.spawn
    deps.spawn = (plan, env) => {
      const pid = spawn(plan, env)
      fs.writeText(recordFile(HOME), write({ ...RECORD, cdp: 9222 }))
      return pid
    }
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9222 }, deps)
    expect(outcome).toMatchObject({ ok: true, name: NAME, home: HOME, pid: 4242 })
    if (outcome.ok) {
      expect(outcome.note).toContain('9222')
      expect(outcome.record).toEqual({ ...RECORD, cdp: 9222 })
    }
    expect(state.spawned[0]?.command).toBe(HOST)
    expect(state.spawned[0]?.cwd).toBe('C:/apps')
    expect(state.spawned[0]?.args).toEqual(['--remote-debugging-port=9222', '--disable-backgrounding-occluded-windows'])
    expect(state.spawned[0]?.env.GWB_HOME).toBe(NAME)
    expect(state.spawned[0]?.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(state.slept).toEqual(new Array(ALIVE_TIMEOUT_MS / ALIVE_POLL_MS).fill(ALIVE_POLL_MS))
  })

  it('记录没出现不算起失败，但回执要明说——那时按名字定位用不了', async () => {
    const fs = fakeFs()
    const { deps } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT }, deps)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.record).toBeUndefined()
      expect(outcome.note).toContain('runtime.json')
    }
  })

  it('秒退：立刻报并指向 home 的日志', async () => {
    const fs = fakeFs()
    // 进程表里没有 4242：spawn 回了 pid，但那个进程转眼就退了
    const { deps, state } = fakeDeps({ fs })
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('秒退')
      expect(outcome.error).toContain(path.join(HOME, 'gwb.log'))
    }
    expect(state.slept).toEqual([])
  })

  it('同一个 home 已有实例在跑:拒,不起第二个', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('4242')
    expect(state.spawned).toEqual([])
  })

  it('记录陈旧(上一轮的实例早停了):不拦,照常起', async () => {
    // 表里没有 999:记录里那个 pid 已经不在了
    const fs = fakeFs({ [recordFile(HOME)]: write({ ...RECORD, pid: 999 }) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    expect((await launchHome({ name: NAME, homesRoot: ROOT }, deps)).ok).toBe(true)
    expect(state.spawned).toHaveLength(1)
  })

  it('spawn 拿不到 pid：当场失败', async () => {
    const fs = fakeFs()
    const { deps } = fakeDeps({ fs, spawnFails: true })
    expect((await launchHome({ name: NAME, homesRoot: ROOT }, deps)).ok).toBe(false)
    expect(fs.files.has(recordFile(HOME))).toBe(false)
  })
})

describe('listHomes：谁在跑看记录里的 pid', () => {
  it('有记录且 pid 认得出的报 running；没记录的就是没在跑，门那两格如实报', async () => {
    const other = path.join(ROOT, 'shell-2609081430')
    const mcp = { port: 2870, url: 'http://127.0.0.1:2870/mcp' }
    const commandHttp = { port: 2871, url: 'http://127.0.0.1:2871' }
    const fs = fakeFs(
      { [recordFile(HOME)]: write({ ...RECORD, cdp: 9222, mcp, 'command-http': commandHttp }) },
      { [ROOT]: [NAME, 'shell-2609081430'] },
    )
    const { deps } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    expect(await listHomes(ROOT, deps)).toEqual([
      { name: NAME, home: HOME, pid: 4242, running: true, cdp: 9222, mcp, commandHttp },
      { name: 'shell-2609081430', home: other, pid: null, running: false, cdp: null, mcp: null, commandHttp: null },
    ])
  })
})

describe('pickCdpPort：起 home 时自动挑一个空口', () => {
  const other = path.join(ROOT, 'shell-2609081430')

  it('一个空口都没有：照实回 undefined，让上头拒掉这次启动', async () => {
    const fs = fakeFs({}, { [ROOT]: [NAME, 'shell-2609081430'] })
    // portOwner 一律回「有人」，所以每个候选都被占着
    const { deps } = fakeDeps({ fs, portOwner: 777 })
    expect(await pickCdpPort(ROOT, deps, NAME)).toBeUndefined()
  })

  it('先沿用这个 home 自己上次那个口——重开一次不该换地址', async () => {
    const fs = fakeFs(
      { [recordFile(HOME)]: write({ ...RECORD, cdp: CDP_PORT_BASE + 7 }) },
      { [ROOT]: [NAME] },
    )
    const { deps } = fakeDeps({ fs })
    expect(await pickCdpPort(ROOT, deps, NAME)).toEqual({ port: CDP_PORT_BASE + 7, reused: true })
  })

  it('上次那个口被别人占着：另挑一个，并报出「换了」', async () => {
    const fs = fakeFs(
      { [recordFile(HOME)]: write({ ...RECORD, cdp: CDP_PORT_BASE }) },
      { [ROOT]: [NAME] },
    )
    // 第一次问的是它自己那个口（有人），之后每个候选都空
    let asked = 0
    const { deps } = fakeDeps({ fs })
    const owner = deps.portOwner.bind(deps)
    deps.portOwner = (port) => {
      asked += 1
      return asked === 1 ? Promise.resolve(777) : owner(port)
    }
    expect(await pickCdpPort(ROOT, deps, NAME)).toEqual({ port: CDP_PORT_BASE, reused: false })
  })

  it('别的 home 记录里那个口算占着，自己那份不算——不然重开一次就被自己挤走', async () => {
    const fs = fakeFs(
      {
        // 这个 home 的 pid 早没了，但记录还指着 CDP_PORT_BASE
        [recordFile(HOME)]: write({ ...RECORD, pid: 999, cdp: CDP_PORT_BASE }),
        [recordFile(other)]: write({ ...RECORD, cdp: CDP_PORT_BASE + 1 }),
      },
      { [ROOT]: [NAME, 'shell-2609081430'] },
    )
    const { deps } = fakeDeps({ fs })
    expect(portsInRecords(ROOT, deps)).toEqual(new Set([CDP_PORT_BASE, CDP_PORT_BASE + 1]))
    expect(portsInRecords(ROOT, deps, NAME)).toEqual(new Set([CDP_PORT_BASE + 1]))
    // 自己那个口空着就沿用，哪怕记录是陈旧的
    expect(await pickCdpPort(ROOT, deps, NAME)).toEqual({ port: CDP_PORT_BASE, reused: true })
  })
})

describe('resolveTarget：「我要操作哪个 home」→ 够得着它的那个口', () => {
  const base = { [recordFile(HOME)]: write({ ...RECORD, cdp: 9222 }) }
  const dirs = { [ROOT]: [NAME] }

  it('记录在、pid 活着、口上就是它：给出那个口', async () => {
    const { deps } = fakeDeps({ fs: fakeFs(base, dirs), processes: { 4242: 'electron.exe' }, portOwner: 4242 })
    expect(await resolveTarget(ROOT, NAME, deps)).toMatchObject({ ok: true, name: NAME, cdp: 9222 })
  })

  it('口上 listen 的是别人：记录陈旧，不给——端口会被下一个进程占走', async () => {
    const { deps } = fakeDeps({ fs: fakeFs(base, dirs), processes: { 4242: 'electron.exe' }, portOwner: 9001 })
    const out = await resolveTarget(ROOT, NAME, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('9001')
  })

  it('pid 已经不在：说它没在跑，指去 open', async () => {
    const { deps } = fakeDeps({ fs: fakeFs(base, dirs) })
    const out = await resolveTarget(ROOT, NAME, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('open')
  })

  it('查不出那个 pid 是什么：不导出动作', async () => {
    const { deps } = fakeDeps({ fs: fakeFs(base, dirs), unknownPids: [4242] })
    expect((await resolveTarget(ROOT, NAME, deps)).ok).toBe(false)
  })

  it('在跑但记录里没有 cdp：够不着，说清是起的时候没带开关', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, dirs)
    const { deps } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    const out = await resolveTarget(ROOT, NAME, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain('remote-debugging-port')
      expect(out.error).toContain('devkit.home.open')
      expect(out.error).not.toContain('cdp 参数')
    }
  })

  it('压根没有记录：说清要停掉重开，不猜端口', async () => {
    const { deps } = fakeDeps({ fs: fakeFs({}, dirs) })
    const out = await resolveTarget(ROOT, NAME, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain('runtime.json')
      expect(out.error).toContain('重开')
    }
  })
})

describe('bringDownHome：核对映像名再杀', () => {
  it('pid 活着且认得出：杀它，记录留着（下一次开机内核整份重写）', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    expect(await bringDownHome(HOME, deps)).toMatchObject({ ok: true, killed: 4242 })
    expect(state.killed).toEqual([4242])
    expect(fs.files.has(recordFile(HOME))).toBe(true)
  })

  it('记录里没记 cdp：不问端口，一道核对就够了', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, portOwner: 9001 })
    await bringDownHome(HOME, deps)
    expect(state.portsAsked).toEqual([])
    expect(state.killed).toEqual([4242])
  })

  it('记录里带着 cdp、端口上 listen 的是别人：不杀、记录留着', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write({ ...RECORD, cdp: 9222 }) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, portOwner: 9001 })
    const outcome = await bringDownHome(HOME, deps)
    expect(outcome).toMatchObject({ ok: false, killed: null })
    expect(outcome.note).toContain('9001')
    expect(state.portsAsked).toEqual([9222])
    expect(state.killed).toEqual([])
    expect(fs.files.get(recordFile(HOME))).toBe(write({ ...RECORD, cdp: 9222 }))
  })

  it('端口上 listen 的就是记录里那个：两道都过，照杀', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write({ ...RECORD, cdp: 9222 }) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, portOwner: 4242 })
    expect(await bringDownHome(HOME, deps)).toMatchObject({ ok: true, killed: 4242 })
    expect(state.killed).toEqual([4242])
  })

  it('pid 号被别人复用（node 也算别人）：一个都不杀', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'chrome.exe' } })
    const outcome = await bringDownHome(HOME, deps)
    expect(outcome.killed).toBeNull()
    expect(state.killed).toEqual([])
    expect(fs.files.has(recordFile(HOME))).toBe(true)
  })

  it('查不出那个 pid 是什么：不杀、不删记录，回 ok:false', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps, state } = fakeDeps({ fs, unknownPids: [4242] })
    const outcome = await bringDownHome(HOME, deps)
    expect(outcome).toMatchObject({ ok: false, killed: null })
    expect(state.killed).toEqual([])
    // 当成「进程不在」把记录删了的话，那个还跑着的 home 就此没人管得着
    expect(fs.files.has(recordFile(HOME))).toBe(true)
  })

  it('kill 抛了（EPERM 之类）：记录留着，回 ok:false', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps } = fakeDeps({
      fs,
      processes: { 4242: 'electron.exe' },
      kill: Object.assign(new Error('kill EPERM'), { code: 'EPERM' }),
    })
    const outcome = await bringDownHome(HOME, deps)
    expect(outcome).toMatchObject({ ok: false, killed: null })
    expect(outcome.note).toContain('EPERM')
    expect(fs.files.has(recordFile(HOME))).toBe(true)
  })

  it('下手时进程已经不在（ESRCH）：算停成了，killed 报 null', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, kill: 'gone' })
    expect(await bringDownHome(HOME, deps)).toMatchObject({ ok: true, killed: null })
    expect(fs.files.has(recordFile(HOME))).toBe(true)
  })

  it('没有记录：没有可停的——不猜、不按名字扫进程', async () => {
    const { deps, state } = fakeDeps({})
    const outcome = await bringDownHome(HOME, deps)
    expect(outcome).toMatchObject({ ok: true, killed: null })
    expect(state.killed).toEqual([])
  })

  it('发了停止信号要等进程真退：按 pid 轮询到 gone 才算停了', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, exitAfterPolls: 3 })
    expect(await bringDownHome(HOME, deps)).toMatchObject({ ok: true, killed: 4242 })
    expect(state.slept).toEqual([EXIT_POLL_MS, EXIT_POLL_MS, EXIT_POLL_MS])
  })

  it('信号发了进程到点还不退：ok:false，说清没退', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, exitAfterPolls: Number.POSITIVE_INFINITY })
    const outcome = await bringDownHome(HOME, deps)
    expect(outcome).toMatchObject({ ok: false, killed: null })
    expect(outcome.note).toContain('还在')
    expect(state.slept).toHaveLength(Math.ceil(EXIT_TIMEOUT_MS / EXIT_POLL_MS))
    expect(fs.files.has(recordFile(HOME))).toBe(true)
  })
})

describe('removeHome：default 守得住，跑着的要 force 才连停带删', () => {
  it('default 不带 force 拒；force 就放行', async () => {
    const daily = path.join(ROOT, DAILY_HOME)
    const fs = fakeFs({}, { [ROOT]: [DAILY_HOME] })
    const { deps } = fakeDeps({ fs })
    const refused = await removeHome(daily, DAILY_HOME, false, deps)
    expect(refused.ok).toBe(false)
    expect(refused.note).toContain(DAILY_HOME)
    expect(fs.removed).toEqual([])
    expect((await removeHome(daily, DAILY_HOME, true, deps)).ok).toBe(true)
    expect(fs.removed).toEqual([path.resolve(daily)])
  })

  it('home 不在：照实说，不动手', async () => {
    const { deps } = fakeDeps({})
    const outcome = await removeHome(HOME, NAME, false, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain('不在')
  })

  it('还在跑、没带 force：拒删，指去 force', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, { [ROOT]: [NAME] })
    const { deps } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    const outcome = await removeHome(HOME, NAME, false, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain('force')
    expect(fs.removed).toEqual([])
  })

  it('还在跑、带了 force：先停再删，停了哪个 pid 写在回执里', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, { [ROOT]: [NAME] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    const outcome = await removeHome(HOME, NAME, true, deps)
    expect(outcome.ok).toBe(true)
    expect(state.killed).toEqual([4242])
    expect(outcome.note).toContain('4242')
    expect(fs.removed).toEqual([path.resolve(HOME)])
  })

  it('停不掉就不删：半个目录加一屏 EBUSY 比「没删成」难收拾得多', async () => {
    // 记录里带着 CDP 口，而那个口上 listen 的是另一个 pid：bringDownHome 第二道核对拦下来
    const fs = fakeFs({ [recordFile(HOME)]: write({ ...RECORD, cdp: 9400 }) }, { [ROOT]: [NAME] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, portOwner: 9001 })
    const outcome = await removeHome(HOME, NAME, true, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain('停它没成')
    expect(state.killed).toEqual([])
    expect(fs.removed).toEqual([])
  })

  it('default 正跑着：force 也不删——不替人关他正在用的那扇窗', async () => {
    const daily = path.join(ROOT, DAILY_HOME)
    const fs = fakeFs({ [recordFile(daily)]: write(RECORD) }, { [ROOT]: [DAILY_HOME] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    const outcome = await removeHome(daily, DAILY_HOME, true, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain('自己关')
    expect(state.killed).toEqual([])
    expect(fs.removed).toEqual([])
  })

  it('查不出记录里的 pid 还在不在：不删', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, { [ROOT]: [NAME] })
    const { deps } = fakeDeps({ fs, unknownPids: [4242] })
    const outcome = await removeHome(HOME, NAME, false, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain('查不出')
    expect(fs.removed).toEqual([])
  })

  it('记录陈旧（进程早没了）：删', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, { [ROOT]: [NAME] })
    const { deps } = fakeDeps({ fs })
    expect(await removeHome(HOME, NAME, false, deps)).toMatchObject({ ok: true })
    expect(fs.removed).toEqual([path.resolve(HOME)])
  })

  it('removeDir 报错（EBUSY 之类）：原话带回来', async () => {
    const fs = fakeFs({}, { [ROOT]: [NAME] }, 'EBUSY: resource busy or locked')
    const { deps } = fakeDeps({ fs })
    const outcome = await removeHome(HOME, NAME, false, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain('EBUSY')
  })

  it('删的调用回 ok、目录却一直还在：试满次数不说「已删」，说清还剩什么', async () => {
    const fs = fakeFs({}, { [ROOT]: [NAME] }, undefined, ['data', 'node_modules'])
    const { deps, state } = fakeDeps({ fs })
    const outcome = await removeHome(HOME, NAME, false, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).not.toContain('已删')
    expect(outcome.note).toContain('还在')
    expect(outcome.note).toContain('node_modules')
    expect(fs.removeCalls).toBe(REMOVE_TRIES)
    expect(state.slept).toEqual(Array.from({ length: REMOVE_TRIES - 1 }, () => REMOVE_RETRY_MS))
  })

  it('第一次删回 ok 却只删了一半（子进程还握着句柄），等一会儿再删掉了：回已删', async () => {
    const fs = fakeFs({}, { [ROOT]: [NAME] }, undefined, ['node_modules'], 1)
    const { deps, state } = fakeDeps({ fs })
    const outcome = await removeHome(HOME, NAME, false, deps)
    expect(outcome.ok).toBe(true)
    expect(fs.removeCalls).toBe(2)
    expect(state.slept).toEqual([REMOVE_RETRY_MS])
  })

  it('force 连停带删：进程没退净之前不下手删，退了再删', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, { [ROOT]: [NAME] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, exitAfterPolls: 2 })
    const outcome = await removeHome(HOME, NAME, true, deps)
    expect(outcome.ok).toBe(true)
    expect(state.slept).toEqual([EXIT_POLL_MS, EXIT_POLL_MS])
    expect(fs.removed).toEqual([path.resolve(HOME)])
  })

  it('force 停了进程却一直不退：不删，回 ok:false', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, { [ROOT]: [NAME] })
    const { deps } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, exitAfterPolls: Number.POSITIVE_INFINITY })
    const outcome = await removeHome(HOME, NAME, true, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain('停它没成')
    expect(fs.removed).toEqual([])
  })
})
