import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALIVE_POLL_MS,
  ALIVE_TIMEOUT_MS,
  BASE_INSTALL_TIMEOUT_MS,
  BASE_PLUGINS,
  CDP_PORT_BASE,
  EXIT_POLL_MS,
  EXIT_TIMEOUT_MS,
  REMOVE_RETRY_MS,
  REMOVE_TRIES,
  asHomeName,
  baseInstallPlan,
  bringDownHome,
  composeName,
  cordisInstallPlan,
  cordisVersionForKernel,
  guiChildEnv,
  hostAppSpawnPlan,
  installedManifestAtVersion,
  isHomeProcess,
  kernelInstallPlan,
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
import { KERNEL_PACKAGE, homePnpmEnv } from '@godcreator/gwb-plugin-manager'
import { DAILY_HOME, installedManifest } from '../src/dev.js'

/**
 * 启动、停止、删除 home 最不该靠手工点几遍来确认：名字重不重复、装不上时启不启动、查得出的 pid
 * 才结束、default 删不删得掉——都是只在边界情况里出现的判断。文件系统与启动进程都是注入的，
 * 整个流程在这里跑得完，不用真的启动一个 electron 窗口。
 */

const ROOT = 'D:/fake-homes'
const NAME = 'data-2609081430'
const HOME = path.join(ROOT, NAME)
const HOST = 'C:/apps/gwb-kernel.exe'
const PNPM = 'C:\\Users\\u\\AppData\\Local\\pnpm\\bin\\pnpm.exe'
const RECORD: HomeRecord = { pid: 4242, startedAt: 1_000 }

/** 内核往 home 里写的运行时记录。**devkit 只读它**，所以测试里由测试自己写 */
const write = (record: HomeRecord): string => JSON.stringify(record)

/** 内存里的文件系统：文件表 + 目录表。removeDir 的错误由测试给定，EBUSY 那种情况才测得到 */
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
  /** 列进程表失败（tasklist 超时或出错）：查不出不是「不在」，照实抛 */
  processTableFails?: boolean
  spawnPid?: number | undefined
  spawnFails?: boolean
  /** run 的答案，按顺序取；用完了重复最后一个 */
  runs?: { ok: boolean; tail: string }[]
  /** kill 的结果：默认结束成功；'gone' 是结束时进程已经不在，给一个 Error 就是它抛出 */
  kill?: 'killed' | 'gone' | Error
  /** 停成了之后进程还要被查到几次 running 才真退；Infinity＝一直不退 */
  exitAfterPolls?: number
  /** 在 CDP 端口上监听的那个 pid；不给就是没人监听 */
  portOwner?: number
  /** 查端口持有者失败（netstat 出错）：照实抛 */
  portOwnerFails?: boolean
  execPath?: string
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
    processTableCalls: 0,
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
      return hostAppSpawnPlan(execPath, cdp)
    },
    async run(plan, timeoutMs) {
      state.runCalls.push({ plan, timeoutMs })
      return runs[Math.min(state.runCalls.length - 1, runs.length - 1)] ?? { ok: true, tail: '' }
    },
    processTable() {
      state.processTableCalls += 1
      if (options.processTableFails === true) return Promise.reject(new Error('tasklist 超时'))
      const table = new Map<number, string>()
      for (const [pid, name] of Object.entries(options.processes ?? {})) {
        if (state.killed.includes(Number(pid))) {
          // 停过的进程：再被查到 exitAfterPolls 次之后才从表里消失
          state.pollsAfterKill += 1
          if (state.pollsAfterKill > (options.exitAfterPolls ?? 0)) continue
        }
        table.set(Number(pid), name)
      }
      return Promise.resolve(table)
    },
    portOwner(port) {
      state.portsAsked.push(port)
      if (options.portOwnerFails === true) return Promise.reject(new Error('netstat 出错'))
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
  }
  return { deps, state }
}

/** 运行 home.new 的内核版本号：装进新 home 的就是这个精确版本 */
const KERNEL_VERSION = '0.3.0'

/** 装进 home 的内核包清单原文；给了 overrides 就覆盖对应字段 */
function kernelManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: KERNEL_PACKAGE, version: KERNEL_VERSION, peerDependencies: { cordis: '4.0.0-rc.9' }, ...overrides })
}

/** 装上的 cordis 清单原文 */
function cordisManifest(version = '4.0.0-rc.9'): string {
  return JSON.stringify({ name: 'cordis', version })
}

/** 第一条 run（装内核包）之后内核包的清单才出现在 home 的 node_modules 里，第二条（装 cordis）之后 cordis 的清单才出现 */
function installsOnRuns(deps: HomeDeps, fs: HomeFs, kernelManifestText: string, cordisManifestText = cordisManifest()): void {
  const run = deps.run
  let calls = 0
  deps.run = async (plan, timeoutMs) => {
    const outcome = await run(plan, timeoutMs)
    calls += 1
    if (calls === 1) fs.writeText(installedManifest(HOME, KERNEL_PACKAGE), kernelManifestText)
    if (calls === 2) fs.writeText(installedManifest(HOME, 'cordis'), cordisManifestText)
    return outcome
  }
}

describe('装进新 home 的东西：内核包、cordis 与基础插件', () => {
  const HOST_ENV = { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', pnpm_config_auto_install_peers: 'true' }
  const HOME_PNPM_ENV = homePnpmEnv(HOST_ENV)

  it('三条 pnpm add 的环境都由插件管理的 homePnpmEnv 从宿主环境算出：不自动补装 peer，不带 ELECTRON_RUN_AS_NODE', () => {
    for (const plan of [kernelInstallPlan(HOME, KERNEL_VERSION, PNPM, HOST_ENV), cordisInstallPlan(HOME, '4.0.0-rc.9', PNPM, HOST_ENV), baseInstallPlan(HOME, PNPM, HOST_ENV)]) {
      expect(plan.env).toEqual(HOME_PNPM_ENV)
      expect(plan.env?.['pnpm_config_auto_install_peers']).toBe('false')
      expect(plan.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
      expect(plan.env?.['PATH']).toBe('x')
    }
  })

  it('装内核包：直接启动找到的 pnpm，add 运行中内核的版本（不带 --save-exact）', () => {
    expect(kernelInstallPlan(HOME, KERNEL_VERSION, PNPM, HOST_ENV)).toEqual({
      command: PNPM,
      args: ['add', `${KERNEL_PACKAGE}@${KERNEL_VERSION}`],
      cwd: HOME,
      env: HOME_PNPM_ENV,
    })
    expect(kernelInstallPlan(HOME, '0.3.1-dev.202609241500', PNPM, HOST_ENV)).toEqual({
      command: PNPM,
      args: ['add', `${KERNEL_PACKAGE}@0.3.1-dev.202609241500`],
      cwd: HOME,
      env: HOME_PNPM_ENV,
    })
  })

  it('装 cordis：pnpm add --save-exact 精确版本（只有它带：要正好等于内核包 peer 里那个版本）', () => {
    expect(cordisInstallPlan(HOME, '4.0.0-rc.9', PNPM, HOST_ENV)).toEqual({ command: PNPM, args: ['add', '--save-exact', 'cordis@4.0.0-rc.9'], cwd: HOME, env: HOME_PNPM_ENV })
  })

  it('装基础插件：只装插件，不写版本（取 latest）、不带 --save-exact', () => {
    const plan = baseInstallPlan(HOME, PNPM, HOST_ENV)
    expect(plan.command).toBe(PNPM)
    expect(plan.cwd).toBe(HOME)
    expect(plan.args).toEqual(['add', ...BASE_PLUGINS.map((one) => one.pkg)])
  })

  it('装上的包清单：版本是要装的那个才回清单；读不到、不是 JSON、版本对不上都拒，说清是哪个文件、装上的是哪个版本', () => {
    expect(installedManifestAtVersion(cordisManifest(), 'cordis', '4.0.0-rc.9', HOME)).toMatchObject({ ok: true, manifest: { version: '4.0.0-rc.9' } })
    expect(installedManifestAtVersion(undefined, 'cordis', '4.0.0-rc.9', HOME)).toMatchObject({
      ok: false,
      error: expect.stringContaining(installedManifest(HOME, 'cordis')),
    })
    expect(installedManifestAtVersion('{ half', 'cordis', '4.0.0-rc.9', HOME)).toMatchObject({ ok: false })
    expect(installedManifestAtVersion(cordisManifest('4.0.0-rc.10'), 'cordis', '4.0.0-rc.9', HOME)).toMatchObject({
      ok: false,
      error: expect.stringContaining('4.0.0-rc.10'),
    })
  })

  it('cordis 版本取装上的内核包 peerDependencies.cordis', () => {
    expect(cordisVersionForKernel(kernelManifest(), KERNEL_VERSION, HOME)).toEqual({ ok: true, cordis: '4.0.0-rc.9' })
  })

  it('内核包清单读不到、装上的版本对不上、peer 里 cordis 没写或不是精确版本号：都拒，说清是哪一条', () => {
    const missing = cordisVersionForKernel(undefined, KERNEL_VERSION, HOME)
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining(installedManifest(HOME, KERNEL_PACKAGE)) })
    expect(cordisVersionForKernel('{ half', KERNEL_VERSION, HOME)).toMatchObject({ ok: false })
    const otherVersion = cordisVersionForKernel(kernelManifest({ version: '0.3.1' }), KERNEL_VERSION, HOME)
    expect(otherVersion).toMatchObject({ ok: false, error: expect.stringContaining('0.3.1') })
    for (const peers of [undefined, {}, { cordis: '^4.0.0-rc.9' }, { cordis: 'latest' }]) {
      const got = cordisVersionForKernel(kernelManifest({ peerDependencies: peers }), KERNEL_VERSION, HOME)
      expect(got, JSON.stringify(peers)).toMatchObject({ ok: false, error: expect.stringContaining('不是精确版本号') })
    }
  })
})

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
    }
    expect(parseRecord(JSON.stringify(full))).toEqual(full)
    expect(parseRecord(undefined)).toBeUndefined()
    expect(parseRecord('{ half')).toBeUndefined()
    expect(parseRecord('[]')).toBeUndefined()
    expect(parseRecord(JSON.stringify({ pid: -1, startedAt: 1 }))).toBeUndefined()
    expect(parseRecord(JSON.stringify({ pid: 4242 }))).toBeUndefined()
  })

  it('缺一个可选字段不算坏：cdp 与 mcp 缺了是「那件事没发生」，不是这份记录不能用', () => {
    // 启动时没带调试端口，或者那个 home 根本没装 MCP 入口插件——两样都是常态
    expect(parseRecord(JSON.stringify({ ...RECORD, cdp: 'x' }))).toEqual(RECORD)
    expect(parseRecord(JSON.stringify({ ...RECORD, mcp: { port: 2870 } }))).toEqual(RECORD)
    expect(parseRecord(JSON.stringify({ ...RECORD, mcp: 'nope' }))).toEqual(RECORD)
    // 认不出的字段不影响读取，也不进记录
    expect(parseRecord(JSON.stringify({ ...RECORD, appDir: 'D:/fake-app', 'command-http': { port: 2871, url: 'http://127.0.0.1:2871' }, 将来: 1 }))).toEqual(RECORD)
  })

  it('名字的收窄：内核那道正则说了算', () => {
    expect(asHomeName('data-2609081430')).toBe('data-2609081430')
    for (const bad of ['../../x', 'Data', 'data--x', 'data-', 42, undefined]) {
      expect(asHomeName(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('启动计划：拉宿主自己那个 exe', () => {
  it('安装版（exe 不叫 electron）：直起本体，调试端口与遮挡开关放在命令行上', () => {
    expect(hostAppSpawnPlan(HOST, 9400)).toEqual({
      command: HOST,
      args: ['--remote-debugging-port=9400', '--disable-backgrounding-occluded-windows'],
      cwd: 'C:/apps',
    })
  })

  it('宿主是 electron（从内核源码启动的开发态）：拒——devkit 只从安装版起 home', () => {
    for (const execPath of ['C:/apps/electron.exe', 'D:/kernel/node_modules/electron/dist/Electron.exe']) {
      expect(() => hostAppSpawnPlan(execPath, 9400), execPath).toThrow(/安装版/)
    }
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
  it('宿主是 electron（开发态）：拒，一个动作都不做', async () => {
    const { deps, state } = fakeDeps({ execPath: 'C:/apps/electron.exe' })
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400 }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('安装版')
    expect(state.spawned).toEqual([])
    expect(state.runCalls).toEqual([])
  })

  it('内核包装不上：不装 cordis 与基础插件、不启动宿主，输出的最后几行带回来', async () => {
    const { deps, state } = fakeDeps({ runs: [{ ok: false, tail: 'ERR!坏的' }] })
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400, install: { kernelVersion: KERNEL_VERSION, pnpm: PNPM } }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('ERR!坏的')
      expect(outcome.error).toContain(`${KERNEL_PACKAGE}@${KERNEL_VERSION}`)
    }
    expect(state.runCalls).toHaveLength(1)
    expect(state.spawned).toEqual([])
  })

  it('install：先写 cordis.yml，再装内核包，读装上的内核包清单定 cordis 版本，再装 cordis、核对版本，最后装基础插件，然后才启动宿主', async () => {
    const fs = fakeFs({}, { [ROOT]: [] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'gwb-kernel.exe' } })
    installsOnRuns(deps, fs, kernelManifest())
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400, install: { kernelVersion: KERNEL_VERSION, pnpm: PNPM } }, deps)
    expect(outcome.ok).toBe(true)
    expect(state.runCalls.map((call) => call.timeoutMs)).toEqual([BASE_INSTALL_TIMEOUT_MS, BASE_INSTALL_TIMEOUT_MS, BASE_INSTALL_TIMEOUT_MS])
    expect(state.runCalls.map((call) => call.plan.cwd)).toEqual([HOME, HOME, HOME])
    expect(state.runCalls[0]?.plan).toMatchObject({ command: PNPM, args: ['add', `${KERNEL_PACKAGE}@${KERNEL_VERSION}`] })
    expect(state.runCalls[1]?.plan).toMatchObject({ command: PNPM, args: ['add', '--save-exact', 'cordis@4.0.0-rc.9'] })
    expect(state.runCalls[2]?.plan.args).toContain('@godcreator/gwb-commands')
    expect(state.runCalls[2]?.plan.args).not.toContain('--save-exact')
    expect(deps.fs.exists(path.join(HOME, 'cordis.yml'))).toBe(true)
    expect(state.spawned).toHaveLength(1)
  })

  it('装上的内核包清单里 cordis 不是精确版本号：不装 cordis 与基础插件、不启动宿主', async () => {
    const fs = fakeFs({}, { [ROOT]: [] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'gwb-kernel.exe' } })
    installsOnRuns(deps, fs, kernelManifest({ peerDependencies: { cordis: '^4.0.0-rc.9' } }))
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400, install: { kernelVersion: KERNEL_VERSION, pnpm: PNPM } }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('不是精确版本号')
    expect(state.runCalls).toHaveLength(1)
    expect(state.spawned).toEqual([])
  })

  it('装上的内核包版本对不上：不装 cordis 与基础插件、不启动宿主', async () => {
    const fs = fakeFs({}, { [ROOT]: [] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'gwb-kernel.exe' } })
    installsOnRuns(deps, fs, kernelManifest({ version: '0.3.1' }))
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400, install: { kernelVersion: KERNEL_VERSION, pnpm: PNPM } }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('home 里装上的却是 0.3.1')
    expect(state.runCalls).toHaveLength(1)
    expect(state.spawned).toEqual([])
  })

  it('装上的 cordis 版本对不上：不装基础插件、不启动宿主', async () => {
    const fs = fakeFs({}, { [ROOT]: [] })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'gwb-kernel.exe' } })
    installsOnRuns(deps, fs, kernelManifest(), cordisManifest('4.0.0-rc.10'))
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400, install: { kernelVersion: KERNEL_VERSION, pnpm: PNPM } }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('home 里装上的却是 4.0.0-rc.10')
    expect(state.runCalls).toHaveLength(2)
    expect(state.spawned).toEqual([])
  })

  it('cordis 装不上、基础插件装不上：都不启动宿主，输出的最后几行带回来', async () => {
    for (const runs of [
      [{ ok: true, tail: '' }, { ok: false, tail: 'ERR!坏的' }],
      [{ ok: true, tail: '' }, { ok: true, tail: '' }, { ok: false, tail: 'ERR!坏的' }],
    ]) {
      const fs = fakeFs({}, { [ROOT]: [] })
      const { deps, state } = fakeDeps({ fs, runs })
      installsOnRuns(deps, fs, kernelManifest())
      const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400, install: { kernelVersion: KERNEL_VERSION, pnpm: PNPM } }, deps)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain('ERR!坏的')
      expect(state.runCalls).toHaveLength(runs.length)
      expect(state.spawned).toEqual([])
    }
  })

  it('起得来：环境与观察窗全对，记录由内核写、这儿只读回来报给人', async () => {
    const fs = fakeFs()
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'gwb-kernel.exe' } })
    // 记录是**启动之后**才出现的（内核启动时写入），所以让假的 spawn 顺带把它写上——
    // 一开始就在磁盘上的话，那份记录会被当成「已经有一个实例在运行」
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
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400 }, deps)
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
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400 }, deps)
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
    const outcome = await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400 }, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('4242')
    expect(state.spawned).toEqual([])
  })

  it('记录陈旧(上一轮的实例早停了):不拦,照常起', async () => {
    // 表里没有 999:记录里那个 pid 已经不在了
    const fs = fakeFs({ [recordFile(HOME)]: write({ ...RECORD, pid: 999 }) })
    const { deps, state } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    expect((await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400 }, deps)).ok).toBe(true)
    expect(state.spawned).toHaveLength(1)
  })

  it('spawn 拿不到 pid：当场失败', async () => {
    const fs = fakeFs()
    const { deps } = fakeDeps({ fs, spawnFails: true })
    expect((await launchHome({ name: NAME, homesRoot: ROOT, cdp: 9400 }, deps)).ok).toBe(false)
    expect(fs.files.has(recordFile(HOME))).toBe(false)
  })
})

describe('listHomes：谁在跑看记录里的 pid', () => {
  it('有记录且 pid 认得出的报 running；没记录的就是没在跑，cdp 与 mcp 如实报', async () => {
    const other = path.join(ROOT, 'shell-2609081430')
    const mcp = { port: 2870, url: 'http://127.0.0.1:2870/mcp' }
    const fs = fakeFs(
      { [recordFile(HOME)]: write({ ...RECORD, cdp: 9222, mcp }) },
      { [ROOT]: [NAME, 'shell-2609081430'] },
    )
    const { deps } = fakeDeps({ fs, processes: { 4242: 'electron.exe' } })
    expect(await listHomes(ROOT, deps)).toEqual([
      { name: NAME, home: HOME, pid: 4242, running: true, cdp: 9222, mcp },
      { name: 'shell-2609081430', home: other, pid: null, running: false, cdp: null, mcp: null },
    ])
  })

  it('home 再多也只列一次进程表，不逐个 pid 去查', async () => {
    const names = ['a-2609250001', 'b-2609250002', 'c-2609250003']
    const fs = fakeFs(
      Object.fromEntries(names.map((name, i) => [recordFile(path.join(ROOT, name)), write({ ...RECORD, pid: 5000 + i })])),
      { [ROOT]: names },
    )
    const { deps, state } = fakeDeps({ fs, processes: { 5000: 'electron.exe', 5002: 'notepad.exe' } })
    const homes = await listHomes(ROOT, deps)
    expect(homes.map((entry) => [entry.name, entry.running])).toEqual([
      ['a-2609250001', true],
      ['b-2609250002', false],
      ['c-2609250003', false],
    ])
    expect(state.processTableCalls).toBe(1)
  })

  it('进程表查不出：照实抛，不把有记录的 home 报成没在跑', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, { [ROOT]: [NAME] })
    const { deps } = fakeDeps({ fs, processes: { 4242: 'electron.exe' }, processTableFails: true })
    await expect(listHomes(ROOT, deps)).rejects.toThrow(/tasklist/)
  })

  it('一个有记录的 home 都没有：不列进程表', async () => {
    const fs = fakeFs({}, { [ROOT]: [NAME] })
    const { deps, state } = fakeDeps({ fs })
    await listHomes(ROOT, deps)
    expect(state.processTableCalls).toBe(0)
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
    // 第一次问的是它自己上次用的端口（有人监听），之后每个候选都空
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
    // 自己上次用的端口空着就沿用，哪怕记录已经过时
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

  it('进程表查不出：照实抛，不导出动作', async () => {
    const { deps } = fakeDeps({ fs: fakeFs(base, dirs), processTableFails: true })
    await expect(resolveTarget(ROOT, NAME, deps)).rejects.toThrow(/tasklist/)
  })

  it('查不出端口上是谁在监听：照实抛，不当成没人监听', async () => {
    const { deps } = fakeDeps({ fs: fakeFs(base, dirs), processes: { 4242: 'electron.exe' }, portOwnerFails: true })
    await expect(resolveTarget(ROOT, NAME, deps)).rejects.toThrow(/netstat/)
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

  it('进程表查不出：照实抛，不杀、不删记录', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) })
    const { deps, state } = fakeDeps({ fs, processTableFails: true })
    await expect(bringDownHome(HOME, deps)).rejects.toThrow(/tasklist/)
    expect(state.killed).toEqual([])
    // 当成「进程不在」把记录删了的话，那个还在运行的 home 就再也找不到了
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
    // 记录里带着 CDP 端口，而那个端口上监听的是另一个 pid：bringDownHome 的第二道核对拒绝结束进程
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

  it('进程表查不出：照实抛，不删', async () => {
    const fs = fakeFs({ [recordFile(HOME)]: write(RECORD) }, { [ROOT]: [NAME] })
    const { deps } = fakeDeps({ fs, processTableFails: true })
    await expect(removeHome(HOME, NAME, false, deps)).rejects.toThrow(/tasklist/)
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
