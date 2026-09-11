import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { RegistryDeps, RegistryFs, ProcessProbe } from './daemon.js'
import { parseNetstat, parsePidFile, parseSs, parseTasklist } from './daemon.js'

/**
 * `RegistryDeps` 的真身：碰盘走 node:fs，开进程与探进程走系统命令。
 *
 * 这一层全是环境胶水，**不进单测**——起停时序的判断全在 daemon.ts 的纯机里，假件
 * 测试在那里跑；这里只负责「真机器上怎么拿到那些答案」。
 */

/** 查一次映像名的上限。tasklist 平时几十毫秒，卡住的话状态卡不能跟着一起卡住 */
const PROCESS_NAME_TIMEOUT_MS = 5_000
/** 查一次端口持有者的上限。netstat 要把整张连接表打出来，比 tasklist 慢，但也就那样 */
const PORT_OWNER_TIMEOUT_MS = 5_000
/** 一次 `/-/ping` 的上限 */
const PING_TIMEOUT_MS = 2_000

export const nodeFs: RegistryFs = {
  exists: (target) => fs.existsSync(target),
  readText(file) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  },
  writeText: (file, text) => fs.writeFileSync(file, text, 'utf8'),
  remove(file) {
    try {
      fs.rmSync(file, { force: true })
    } catch {}
  },
  dirs(target) {
    try {
      return fs
        .readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      return []
    }
  },
}

/**
 * 打一次 `/-/ping`。用 `node:http` 而不是 `fetch`：这条要按 500ms 的间隔轮询三十秒，
 * 而 fetch 背后那个连接池会把 keep-alive 连接留着——探活探到最后剩一串谁也不用的连接
 * 挂在一个刚起来的 registry 上。`agent: false` 加拿到状态码就 `destroy`，两道都要。
 */
export function ping(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let req: http.ClientRequest
    try {
      const client = url.startsWith('https:') ? https : http
      req = client.get(url, { timeout: PING_TIMEOUT_MS, agent: false }, (res) => {
        const ok = res.statusCode === 200
        res.resume()
        req.destroy()
        done(ok)
      })
    } catch {
      done(false)
      return
    }
    req.on('timeout', () => {
      req.destroy()
      done(false)
    })
    req.on('error', () => done(false))
  })
}

/**
 * 查一个 pid 对应的进程。**不走 WMI**：这台机器上 `Get-CimInstance` 那条路会死锁。
 * Windows 用 `tasklist` 的 CSV 单行输出，别的平台 `ps -o comm=`，两条都带超时。
 *
 * 超时、命令不在、tasklist 自己出错都归「查不出」（daemon 的 ProcessProbe 三态）——
 * 把这些当成「进程不在」，停就退化成「只清一份 pid 文件」。POSIX 那侧 `ps` 对一个
 * 不存在的 pid 就是非零退出且不打东西，那才是确凿的「不在」。
 */
export function processName(pid: number): Promise<ProcessProbe> {
  const win = process.platform === 'win32'
  const [command, args] = win
    ? ['tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']]
    : ['ps', ['-p', String(pid), '-o', 'comm=']]
  return new Promise((resolve) => {
    execFile(
      command as string,
      args as string[],
      { timeout: PROCESS_NAME_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          const failed = error as NodeJS.ErrnoException & { killed?: boolean }
          const cannotTell = win || failed.killed === true || failed.code === 'ENOENT'
          resolve(cannotTell ? { state: 'unknown' } : { state: 'gone' })
          return
        }
        const name = win ? parseTasklist(stdout) : stdout.trim()
        resolve(name === undefined || name === '' ? { state: 'gone' } : { state: 'running', name })
      },
    )
  })
}

/** 一条查进程 / 查端口的命令的输出；命令出错或超时且什么都没打时回 undefined */
function runProbe(command: string, args: string[], timeout: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve(error !== null && stdout === '' ? undefined : stdout)
    })
  })
}

/**
 * 某个 tcp 端口上 listen 的那个 pid——**杀之前的第二道核对**。映像名那道只能证明
 * 「这是个 node 或者跟宿主同一个 exe」，pid 复用撞上别人的 node 就杀错人。取不出来
 * 一律回 undefined（没人听、命令不在、这个平台上查不了），那时按映像名那道走。
 * win32 用 `netstat -ano -p tcp`，别的平台先 `ss -ltnp` 再退到 `lsof`。
 */
export async function portOwner(port: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    const out = await runProbe('netstat', ['-ano', '-p', 'tcp'], PORT_OWNER_TIMEOUT_MS)
    return out === undefined ? undefined : parseNetstat(out, port)
  }
  const ss = await runProbe('ss', ['-ltnp'], PORT_OWNER_TIMEOUT_MS)
  const fromSs = ss === undefined ? undefined : parseSs(ss, port)
  if (fromSs !== undefined) return fromSs
  const lsof = await runProbe('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], PORT_OWNER_TIMEOUT_MS)
  // lsof -t 一行一个 pid，取头一个。借 pid 文件那条解析：它认的就是「一行里头一个数」
  return lsof === undefined ? undefined : parsePidFile(lsof.split('\n')[0])?.pid
}

/**
 * 起 registry 进程。**detached + unref + stdio ignore**：它要活过宿主重启与工作台退出
 * （这台机器上别的仓也从它装包）。Windows 上 detached 会给子进程一扇控制台窗口，所以
 * `windowsHide` 是必须的。`error` 事件必须接：不接的话 spawn 失败会以未捕获异常的形式
 * 炸掉宿主进程——起没起成由随后那三十秒的 ping 说了算，这里只记日志。
 */
export function makeSpawn(log: (message: string) => void): RegistryDeps['spawn'] {
  return (plan, env) => {
    try {
      const child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', (err) => log(`registry 子进程起不来：${String(err)}`))
      child.unref()
      return child.pid
    } catch (err) {
      log(`registry 子进程起不来：${String(err)}`)
      return undefined
    }
  }
}

/** `process.kill` 的两种收场之外（EPERM 之类）一律往上抛，由 bringDown 收进 note */
export function kill(pid: number): 'killed' | 'gone' {
  try {
    process.kill(pid)
    return 'killed'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'
    throw err
  }
}
