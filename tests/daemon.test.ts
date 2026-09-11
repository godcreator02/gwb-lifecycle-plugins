import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONFIG_FILE,
  DEFAULT_LISTEN,
  POLL_MS,
  UP_TIMEOUT_MS,
  bringDown,
  bringUp,
  configFile,
  formatPidFile,
  isOwnedProcess,
  listenToUrl,
  logFileOf,
  nodeChildEnv,
  ownsProcess,
  parseNetstat,
  parsePidFile,
  parseSs,
  parseTasklist,
  pidFile,
  pingUrl,
  portOf,
  readStatus,
  spawnPlan,
  tailLines,
  urlOf,
  verdaccioBin,
} from '../src/daemon.js'
import type { RegistryDeps, RegistryFs } from '../src/daemon.js'

/**
 * 起停这件事最不该靠手工点几遍来确认：轮询几秒、pid 文件写没写、陈旧 pid 认不认，
 * 全是只在边角上才现形的判断。所以 fs 与开进程都是注入的，整条时序在这里跑得完，
 * 不必真拉起一个 Verdaccio。
 */

const DIR = path.resolve('D:/fake-registry')
const CONFIG = ['storage: ./storage', '', 'listen: 127.0.0.1:4873', '', 'log:', '  type: file', '  path: ./verdaccio.log'].join('\n')

/** 一个内存盘：文件表 + 目录表。写与删真改文件表，所以起停时序看得到 pid 文件的进出 */
function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): RegistryFs & {
  files: Map<string, string>
} {
  const table = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k), v]))
  const dirTable = new Map(Object.entries(dirs).map(([k, v]) => [path.resolve(k), v]))
  return {
    files: table,
    exists: (target) => table.has(path.resolve(target)) || dirTable.has(path.resolve(target)),
    readText: (file) => table.get(path.resolve(file)),
    writeText: (file, text) => {
      table.set(path.resolve(file), text)
    },
    remove: (file) => {
      table.delete(path.resolve(file))
    },
    dirs: (target) => dirTable.get(path.resolve(target)) ?? [],
  }
}

interface FakeOptions {
  fs?: RegistryFs
  /** 每次 ping 的答案，按顺序取；用完了重复最后一个 */
  pings?: boolean[]
  /** pid → 映像名。表里没有的 pid 就是「进程不在」 */
  processes?: Record<number, string>
  /** 这些 pid 查不出（tasklist 超时或出错），跟「不在」是两回事 */
  unknownPids?: number[]
  spawnPid?: number | undefined
  execPath?: string
  /** kill 的收场：默认停成了；`'gone'` 是下手时进程已经不在，给一个 Error 是它抛 */
  kill?: 'killed' | 'gone' | Error
  /** 端口上 listen 的那个 pid；不给就是「取不出来」（那时按映像名那道判据走） */
  portOwner?: number
}

function fakeDeps(options: FakeOptions = {}) {
  const pings = options.pings ?? [false]
  const state = {
    clock: 1_000,
    pingCalls: 0,
    killed: [] as number[],
    portsAsked: [] as number[],
    spawned: [] as { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[],
    slept: [] as number[],
  }
  const deps: RegistryDeps = {
    fs: options.fs ?? fakeFs({}),
    spawn(plan, env) {
      state.spawned.push({ ...plan, env })
      return options.spawnPid === undefined && !('spawnPid' in options) ? 4242 : options.spawnPid
    },
    ping() {
      const answer = pings[Math.min(state.pingCalls, pings.length - 1)] ?? false
      state.pingCalls += 1
      return Promise.resolve(answer)
    },
    processName(pid) {
      if (options.unknownPids?.includes(pid) === true) return Promise.resolve({ state: 'unknown' })
      const name = options.processes?.[pid]
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
    execPath: options.execPath ?? 'C:/apps/electron.exe',
    env: { PATH: 'x', npm_config_registry: 'http://nope/', NPM_CONFIG_USERCONFIG: 'C:/leak' },
  }
  return { deps, state }
}

describe('config.yaml：地址与日志位从目录自己那份配置推', () => {
  it('几个键各自读得出，行内注释与引号归 YAML 剥', () => {
    expect(urlOf(CONFIG)).toBe('http://127.0.0.1:4873/')
    expect(logFileOf(DIR, CONFIG)).toBe(path.join(DIR, 'verdaccio.log'))
    expect(urlOf('listen: "0.0.0.0:4873"   # 只听回环')).toBe('http://127.0.0.1:4873/')
    expect(logFileOf(DIR, 'log:\n  type: file\n  path: ./别的.log')).toBe(path.join(DIR, '别的.log'))
  })

  it('listen 的非串写法：光端口是个数，列表形态取第一项', () => {
    expect(urlOf('listen: 4873')).toBe('http://127.0.0.1:4873/')
    expect(urlOf('listen:\n\n  # 注释\n  - localhost:4873\n  - 0.0.0.0:4874')).toBe('http://localhost:4873/')
  })

  it('config.yaml 写坏了：不猜地址，日志位回落默认', () => {
    // 未闭合的引号——一份等人来修的文件，不该被当成「什么都没配」
    const broken = 'listen: "127.0.0.1:4873\nstorage: ./别处'
    expect(urlOf(broken)).toBeUndefined()
    expect(logFileOf(DIR, broken)).toBe(path.join(DIR, 'verdaccio.log'))
    // 顶层不是映射，同样没有可认的键
    expect(urlOf('- 4873')).toBeUndefined()
  })

  it('listen 的四种写法都推得出地址，0.0.0.0 与 [::] 换成回环', () => {
    expect(listenToUrl('4873')).toBe('http://127.0.0.1:4873/')
    expect(listenToUrl('127.0.0.1:4899')).toBe('http://127.0.0.1:4899/')
    expect(listenToUrl('http://localhost:4873/')).toBe('http://localhost:4873/')
    // 「听哪些网卡」不是可以连的地址：拿 0.0.0.0 去 ping 得到的是一句看不懂的拒绝
    expect(listenToUrl('0.0.0.0:4873')).toBe('http://127.0.0.1:4873/')
    expect(listenToUrl('[::]:4873')).toBe('http://127.0.0.1:4873/')
    // 裸写的 :: 连 URL 都解析不出来，走不到换回环那一步
    expect(listenToUrl('::')).toBeUndefined()
    expect(listenToUrl('')).toBeUndefined()
    expect(listenToUrl(undefined)).toBeUndefined()
  })

  it('config.yaml 读不到就没有地址；没写 listen 用 Verdaccio 自己的默认；写了读不成不猜', () => {
    expect(urlOf(undefined)).toBeUndefined()
    expect(urlOf('storage: ./storage')).toBe(DEFAULT_LISTEN)
    expect(DEFAULT_LISTEN).toBe('http://localhost:4873/')
    // 空白或只有注释的文件跟「键一个没写」是同一个局面，不是写坏了
    expect(urlOf('')).toBe(DEFAULT_LISTEN)
    expect(urlOf('# 全是注释\n\n')).toBe(DEFAULT_LISTEN)
    expect(urlOf('listen: "[::1"')).toBeUndefined()
    expect(pingUrl('http://127.0.0.1:4899/')).toBe('http://127.0.0.1:4899/-/ping')
  })

  it('log.path 的相对路径锚在目录上，缺键就用默认名；几路日志的列表第一路是主日志', () => {
    expect(logFileOf(DIR, 'log:\n  - type: file\n    path: ../共用.log')).toBe(path.resolve(DIR, '../共用.log'))
    expect(logFileOf(DIR, 'log:\n  type: stdout')).toBe(path.join(DIR, 'verdaccio.log'))
    expect(logFileOf(DIR, undefined)).toBe(path.join(DIR, 'verdaccio.log'))
  })
})

describe('pid 判活：复用的号不能认，自家 exe 起的也得认', () => {
  it('pid 文件里不是一个像样的数就当没有', () => {
    expect(parsePidFile('14340\n')).toEqual({ pid: 14340 })
    expect(parsePidFile('  14340  ')).toEqual({ pid: 14340 })
    for (const bad of ['', '   ', '-1', '0', '14340x', 'abc', undefined]) {
      expect(parsePidFile(bad), String(bad)).toBeUndefined()
    }
  })

  it('pid 文件第二格是起它那个进程的映像名——两个入口靠它认得出同一个 registry', () => {
    expect(parsePidFile('14340 electron\n')).toEqual({ pid: 14340, image: 'electron' })
    // 记的是裸名：写进去的是 execPath，读出来能跟 tasklist 的映像名直接比
    expect(parsePidFile('14340 C:/apps/Electron.exe')).toEqual({ pid: 14340, image: 'electron' })
    expect(formatPidFile(14340, 'C:/apps/Electron.exe')).toBe('14340 electron\n')
    expect(formatPidFile(14340, '/usr/bin/node')).toBe('14340 node\n')
  })

  it('记了映像名就照记的比：node 起的那个，electron 这头也认得出', () => {
    // 这一条是两个入口的全部要害：件那半跑在 electron 里，命令行那半跑在 node 里
    expect(isOwnedProcess('node.exe', 'C:/apps/electron.exe', 'node')).toBe(true)
    expect(isOwnedProcess('electron.exe', '/usr/bin/node', 'electron')).toBe(true)
    // 记了就只认记的那个：号被另一个 node 复用了也分得出来不是它
    expect(isOwnedProcess('node.exe', '/usr/bin/node', 'electron')).toBe(false)
  })

  it('没记映像名的是老文件：回落到 node 与当前可执行文件两头都认', () => {
    // 起子进程用的是本进程自己的 exe（ELECTRON_RUN_AS_NODE），开发态映像名是 electron.exe
    expect(isOwnedProcess('electron.exe', 'C:/apps/electron.exe')).toBe(true)
    expect(isOwnedProcess('node.exe', 'C:/apps/electron.exe')).toBe(true)
    expect(isOwnedProcess('node', 'C:/apps/electron.exe')).toBe(true)
    // 号被别人复用了
    expect(isOwnedProcess('chrome.exe', 'C:/apps/electron.exe')).toBe(false)
    expect(isOwnedProcess(undefined, 'C:/apps/electron.exe')).toBe(false)
    expect(isOwnedProcess('   ', 'C:/apps/electron.exe')).toBe(false)
  })

  it('「查不出」跟「不是它」得分开：前者回 undefined，不导出任何一个动作', () => {
    expect(ownsProcess({ state: 'running', name: 'node.exe' }, 'C:/apps/electron.exe')).toBe(true)
    expect(ownsProcess({ state: 'running', name: 'chrome.exe' }, 'C:/apps/electron.exe')).toBe(false)
    expect(ownsProcess({ state: 'gone' }, 'C:/apps/electron.exe')).toBe(false)
    expect(ownsProcess({ state: 'unknown' }, 'C:/apps/electron.exe')).toBeUndefined()
  })

  it('tasklist 的 CSV 单行取得出映像名；「没有这个进程」那句取不出', () => {
    expect(parseTasklist('"node.exe","14340","Console","1","123,456 K"')).toBe('node.exe')
    expect(parseTasklist('\r\n"electron.exe","900","Console","1","9 K"\r\n')).toBe('electron.exe')
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.')).toBeUndefined()
  })
})

describe('端口持有者：杀之前的第二道核对', () => {
  const NETSTAT = [
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044',
    '  TCP    127.0.0.1:4873         0.0.0.0:0              LISTENING       14340',
    '  TCP    127.0.0.1:4873         127.0.0.1:52033        ESTABLISHED     14340',
    '  TCP    [::]:445               [::]:0                 LISTENING       4',
  ].join('\r\n')

  const SS = [
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN 0      511    127.0.0.1:4873      0.0.0.0:*         users:(("node",pid=14340,fd=20))',
    'LISTEN 0      4096   [::]:22             [::]:*            users:(("sshd",pid=900,fd=4))',
  ].join('\n')

  it('地址上取得出端口，没写端口就按协议的默认口', () => {
    expect(portOf('http://127.0.0.1:4873/')).toBe(4873)
    expect(portOf('http://localhost/')).toBe(80)
    expect(portOf('https://localhost/')).toBe(443)
    expect(portOf(null)).toBeUndefined()
    expect(portOf(undefined)).toBeUndefined()
  })

  it('netstat：只认 LISTENING 那行的本地地址，外部地址那栏的端口不算', () => {
    expect(parseNetstat(NETSTAT, 4873)).toBe(14340)
    expect(parseNetstat(NETSTAT, 445)).toBe(4)
    // 52033 只在「外部地址」那栏出现过——本机没人听它
    expect(parseNetstat(NETSTAT, 52033)).toBeUndefined()
    expect(parseNetstat(NETSTAT, 4899)).toBeUndefined()
    expect(parseNetstat('', 4873)).toBeUndefined()
  })

  it('ss：本地地址那栏对上端口，pid 从最后那栏的 pid= 里取', () => {
    expect(parseSs(SS, 4873)).toBe(14340)
    expect(parseSs(SS, 22)).toBe(900)
    expect(parseSs(SS, 4899)).toBeUndefined()
    expect(parseSs('', 4873)).toBeUndefined()
  })
})

describe('子进程：命令行与环境', () => {
  it('命令行给相对的 config、cwd 给目录——storage 与 log 是相对路径，按 cwd 解析', () => {
    expect(spawnPlan(DIR, 'C:/apps/electron.exe')).toEqual({
      command: 'C:/apps/electron.exe',
      args: [verdaccioBin(DIR), '--config', CONFIG_FILE],
      cwd: DIR,
    })
  })

  it('环境摘掉 npm_config_*（大小写都算），补 ELECTRON_RUN_AS_NODE', () => {
    const env = nodeChildEnv({ PATH: 'x', npm_config_registry: 'http://nope/', NPM_CONFIG_USERCONFIG: 'C:/leak' })
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.npm_config_registry).toBeUndefined()
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined()
    expect(env.PATH).toBe('x')
  })
})

describe('readStatus：ping 是「在不在跑」的唯一判据，pid 只用来停它', () => {
  it('没起过：pid 文件不在、ping 不通', async () => {
    const { deps } = fakeDeps({ fs: fakeFs({ [configFile(DIR)]: CONFIG }), pings: [false] })
    expect(await readStatus(DIR, deps)).toEqual({
      dir: DIR,
      url: 'http://127.0.0.1:4873/',
      running: false,
      pid: null,
      adopted: false,
      hasConfig: true,
      hasBin: false,
    })
  })

  it('在跑、但不是这次会话起的 → 接管', async () => {
    const { deps } = fakeDeps({
      fs: fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340', [verdaccioBin(DIR)]: '#!' }),
      pings: [true],
      processes: { 14340: 'node.exe' },
    })
    const status = await readStatus(DIR, deps)
    expect(status.running).toBe(true)
    expect(status.pid).toBe(14340)
    expect(status.adopted).toBe(true)
    expect(status.hasBin).toBe(true)
  })

  it('在跑、pid 就是这次会话起的那个 → 不算接管', async () => {
    const { deps } = fakeDeps({
      fs: fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '4242' }),
      pings: [true],
      processes: { 4242: 'electron.exe' },
    })
    expect((await readStatus(DIR, deps, 4242)).adopted).toBe(false)
  })

  it('pid 文件陈旧（进程没了）但地址上有人应答 → 在跑、pid 报 null、算接管', async () => {
    const { deps } = fakeDeps({
      fs: fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '999' }),
      pings: [true],
      processes: {},
    })
    expect(await readStatus(DIR, deps, 999)).toMatchObject({ running: true, pid: null, adopted: true })
  })

  it('查不出那个 pid 是什么：pid 报 null，但 pid 文件一个字都不动', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340' })
    const { deps } = fakeDeps({ fs, pings: [false], unknownPids: [14340] })
    expect((await readStatus(DIR, deps)).pid).toBeNull()
    expect(fs.files.get(pidFile(DIR))).toBe('14340')
  })

  it('目录里没有 config.yaml：没有地址可谈，一次 ping 都不打', async () => {
    const { deps, state } = fakeDeps({ fs: fakeFs({}), pings: [true] })
    expect(await readStatus(DIR, deps)).toMatchObject({ url: null, running: false, hasConfig: false })
    expect(state.pingCalls).toBe(0)
  })
})

describe('bringUp：ping 通就接管，起了就轮询三十秒', () => {
  it('地址上已经有人应答就直接认，不再起一个抢不到端口的进程', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [verdaccioBin(DIR)]: '#!' })
    const { deps, state } = fakeDeps({ fs, pings: [true] })
    const outcome = await bringUp(DIR, deps)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.started).toBe(false)
      expect(outcome.status.adopted).toBe(true)
    }
    expect(state.spawned).toHaveLength(0)
    // pid 文件也不该被动：那个进程不是我们起的
    expect(fs.files.has(pidFile(DIR))).toBe(false)
  })

  it('起得来：写 pid 文件、轮询到通为止，命令行与环境都对', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [verdaccioBin(DIR)]: '#!' })
    // 第一次是 bringUp 开头那次现查（不通），随后两次轮询不通，第四次通
    const { deps, state } = fakeDeps({
      fs,
      pings: [false, false, false, true],
      processes: { 4242: 'electron.exe' },
    })
    const outcome = await bringUp(DIR, deps)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.started).toBe(true)
      expect(outcome.status).toMatchObject({ running: true, pid: 4242, adopted: false })
    }
    // 一行两格：pid 加起它那个进程的映像名（这儿的假 execPath 是 electron）
    expect(fs.files.get(pidFile(DIR))).toBe('4242 electron\n')
    expect(state.spawned[0]?.args).toEqual([verdaccioBin(DIR), '--config', CONFIG_FILE])
    expect(state.spawned[0]?.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(state.spawned[0]?.env.npm_config_registry).toBeUndefined()
    expect(state.slept).toEqual([POLL_MS, POLL_MS])
  })

  it('起的进程当场死掉：立刻报，不空等三十秒', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [verdaccioBin(DIR)]: '#!' })
    // 进程表里没有 4242：spawn 回了 pid，但那个进程转眼就退了（端口被占、配置写错）
    const { deps, state } = fakeDeps({ fs, pings: [false], processes: {} })
    const outcome = await bringUp(DIR, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('已退出')
      expect(outcome.error).toContain('端口被占')
    }
    expect(state.slept).toEqual([])
  })

  it('轮询里查不出进程还在不在：接着等，不当成它已经退了', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [verdaccioBin(DIR)]: '#!' })
    const { deps, state } = fakeDeps({ fs, pings: [false], unknownPids: [4242] })
    expect((await bringUp(DIR, deps)).ok).toBe(false)
    expect(state.slept.length).toBe(UP_TIMEOUT_MS / POLL_MS)
  })

  it('三十秒没通就算失败，报里带日志文件位——进程还留着，收不收由人定', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [verdaccioBin(DIR)]: '#!' })
    // 进程一直活着，只是不应答：这才是「等满三十秒」那条路
    const { deps, state } = fakeDeps({ fs, pings: [false], processes: { 4242: 'electron.exe' } })
    const outcome = await bringUp(DIR, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('4242')
      expect(outcome.error).toContain(logFileOf(DIR, CONFIG))
    }
    expect(state.slept.length).toBe(UP_TIMEOUT_MS / POLL_MS)
    // 起不来不等于该收掉：那个进程可能还在慢慢起，收不收由人定
    expect(state.killed).toEqual([])
    // 一行两格：pid 加起它那个进程的映像名（这儿的假 execPath 是 electron）
    expect(fs.files.get(pidFile(DIR))).toBe('4242 electron\n')
  })

  it('pid 文件里那个活着、地址却不通：不再起一个，也不覆盖 pid 文件', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340', [verdaccioBin(DIR)]: '#!' })
    const { deps, state } = fakeDeps({ fs, pings: [false], processes: { 14340: 'node.exe' } })
    const outcome = await bringUp(DIR, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('14340')
    expect(state.spawned).toHaveLength(0)
    // 覆盖了的话，那个活着的进程就此没人管得着了
    expect(fs.files.get(pidFile(DIR))).toBe('14340')
  })

  it('目录里没有 verdaccio：报「进目录 pnpm install」，不替人装', async () => {
    const { deps, state } = fakeDeps({ fs: fakeFs({ [configFile(DIR)]: CONFIG }), pings: [false] })
    const outcome = await bringUp(DIR, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('pnpm install')
    expect(state.spawned).toHaveLength(0)
  })

  it('目录里没有 config.yaml：说清它不是一个 registry 目录', async () => {
    const { deps } = fakeDeps({ fs: fakeFs({}), pings: [false] })
    const outcome = await bringUp(DIR, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain(CONFIG_FILE)
  })

  it('listen 写坏了：不知道往哪儿 ping，不起进程', async () => {
    const { deps, state } = fakeDeps({
      fs: fakeFs({ [configFile(DIR)]: 'listen: "[::1"', [verdaccioBin(DIR)]: '#!' }),
    })
    const outcome = await bringUp(DIR, deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('listen')
    expect(state.spawned).toHaveLength(0)
  })

  it('spawn 拿不到 pid 就当场失败，不去写一份没有内容的 pid 文件', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [verdaccioBin(DIR)]: '#!' })
    const { deps } = fakeDeps({ fs, pings: [false], spawnPid: undefined })
    expect((await bringUp(DIR, deps)).ok).toBe(false)
    expect(fs.files.has(pidFile(DIR))).toBe(false)
  })
})

describe('bringDown：核对映像名再杀', () => {
  it('pid 活着且认得出：杀它、清 pid 文件', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340' })
    const { deps, state } = fakeDeps({ fs, processes: { 14340: 'node.exe' } })
    const outcome = await bringDown(DIR, deps)
    expect(outcome).toMatchObject({ ok: true, killed: 14340 })
    expect(state.killed).toEqual([14340])
    expect(fs.files.has(pidFile(DIR))).toBe(false)
  })

  it('命令行起的（记着 node），件那半（跑在 electron 里）照样停得了', async () => {
    // 收编那条兜底 CLI 之后两个入口共用一份 pid 文件。没有第二格的话，这一条就是
    // 「不是它」：清掉 pid 文件走人，而那个 registry 还跑着，从此没人知道它是谁
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340 node\n' })
    const { deps, state } = fakeDeps({ fs, processes: { 14340: 'node.exe' }, execPath: 'C:/apps/electron.exe' })
    expect(await bringDown(DIR, deps)).toMatchObject({ ok: true, killed: 14340 })
    expect(state.killed).toEqual([14340])
  })

  it('记了映像名就只认那个：号被另一个 node 复用了，不杀', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340 electron\n' })
    const { deps, state } = fakeDeps({ fs, processes: { 14340: 'node.exe' }, execPath: '/usr/bin/node' })
    expect((await bringDown(DIR, deps)).killed).toBeNull()
    expect(state.killed).toEqual([])
  })

  it('端口上 listen 的是另一个 pid：不杀、不删 pid 文件——映像名那道拦不住 pid 复用', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340' })
    // 号被另一个 node 占了（撞上 electron.exe 的话，杀的就是宿主自己）
    const { deps, state } = fakeDeps({ fs, processes: { 14340: 'node.exe' }, portOwner: 9001 })
    const outcome = await bringDown(DIR, deps)
    expect(outcome).toMatchObject({ ok: false, killed: null })
    expect(outcome.note).toContain('9001')
    expect(state.portsAsked).toEqual([4873])
    expect(state.killed).toEqual([])
    expect(fs.files.get(pidFile(DIR))).toBe('14340')
  })

  it('端口上 listen 的就是 pid 文件里那个：两道都过了，照杀', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340' })
    const { deps, state } = fakeDeps({ fs, processes: { 14340: 'node.exe' }, portOwner: 14340 })
    expect(await bringDown(DIR, deps)).toMatchObject({ ok: true, killed: 14340 })
    expect(state.killed).toEqual([14340])
  })

  it('pid 号被别人复用了：一个都不杀，只清陈旧的 pid 文件', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340' })
    const { deps, state } = fakeDeps({ fs, processes: { 14340: 'chrome.exe' } })
    const outcome = await bringDown(DIR, deps)
    expect(outcome.killed).toBeNull()
    expect(state.killed).toEqual([])
    expect(fs.files.has(pidFile(DIR))).toBe(false)
  })

  it('查不出那个 pid 是什么：不杀、不删 pid 文件，回 ok:false', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340' })
    const { deps, state } = fakeDeps({ fs, unknownPids: [14340] })
    const outcome = await bringDown(DIR, deps)
    expect(outcome).toMatchObject({ ok: false, killed: null })
    expect(state.killed).toEqual([])
    // 当成「进程不在」把文件删了的话，那个还跑着的 registry 就此没人管得着
    expect(fs.files.get(pidFile(DIR))).toBe('14340')
  })

  it('kill 抛了（提权 shell 起的，收它是 EPERM）：pid 文件留着，回 ok:false', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340' })
    const { deps } = fakeDeps({
      fs,
      processes: { 14340: 'node.exe' },
      kill: Object.assign(new Error('kill EPERM'), { code: 'EPERM' }),
    })
    const outcome = await bringDown(DIR, deps)
    expect(outcome).toMatchObject({ ok: false, killed: null })
    expect(outcome.note).toContain('EPERM')
    // 进程还在跑，而 pid 文件是唯一一份「它是谁」的记录——删了就再也停不了它
    expect(fs.files.get(pidFile(DIR))).toBe('14340')
  })

  it('下手时进程已经不在（ESRCH）：算停成了，清 pid 文件、killed 报 null', async () => {
    const fs = fakeFs({ [configFile(DIR)]: CONFIG, [pidFile(DIR)]: '14340' })
    const { deps } = fakeDeps({ fs, processes: { 14340: 'node.exe' }, kill: 'gone' })
    expect(await bringDown(DIR, deps)).toMatchObject({ ok: true, killed: null })
    expect(fs.files.has(pidFile(DIR))).toBe(false)
  })

  it('没有 pid 文件：没有可停的，不去按地址猜一个进程', async () => {
    const { deps, state } = fakeDeps({ fs: fakeFs({ [configFile(DIR)]: CONFIG }) })
    expect((await bringDown(DIR, deps)).killed).toBeNull()
    expect(state.killed).toEqual([])
  })
})

describe('尾巴', () => {
  it('只取最后 n 行，行尾那个换行不算一行', () => {
    const text = ['a', 'b', 'c', 'd'].join('\n') + '\n'
    expect(tailLines(text, 2)).toBe('c\nd')
    expect(tailLines(text, 99)).toBe('a\nb\nc\nd')
    expect(tailLines('', 10)).toBe('')
  })
})
