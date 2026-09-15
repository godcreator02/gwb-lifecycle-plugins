import { execFile } from 'node:child_process'
import fs from 'node:fs'
import type { ProcessProbe } from './probes.js'
import { parseNetstat, parsePid, parseSs, parseTasklist } from './probes.js'

/**
 * 探测那半的环境胶水：碰盘走 node:fs，探进程与杀进程走系统命令。时序与守卫的
 * 纯机在 `probes.ts` 与 `home.ts`，**这一层不进单测**——这里只负责「真机器上怎么
 * 拿到那些答案」。home 与 dev 两半的 deps 都从这儿取件。
 */

/** 查一次映像名的上限。tasklist 平时几十毫秒，卡住的话状态卡不能跟着一起卡住 */
const PROCESS_NAME_TIMEOUT_MS = 5_000
/** 查一次端口持有者的上限。netstat 要把整张连接表打出来，比 tasklist 慢，但也就那样 */
const PORT_OWNER_TIMEOUT_MS = 5_000

export const nodeFs = {
  exists: (target: string) => fs.existsSync(target),
  readText(file: string): string | undefined {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  },
  writeText: (file: string, text: string) => fs.writeFileSync(file, text, 'utf8'),
  remove(file: string) {
    try {
      fs.rmSync(file, { force: true })
    } catch {}
  },
  dirs(target: string): string[] {
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
 * 查一个 pid 对应的进程。**不走 WMI**：这台机器上 `Get-CimInstance` 那条路会死锁。
 * Windows 用 `tasklist` 的 CSV 单行输出，别的平台 `ps -o comm=`，两条都带超时。
 *
 * 超时、命令不在、tasklist 自己出错都归「查不出」（probes 的 ProcessProbe 三态）——
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
  return lsof === undefined ? undefined : parsePid(lsof.split('\n')[0])
}

/** `process.kill` 的两种收场之外（EPERM 之类）一律往上抛，由调用方收进各自的失败说明 */
export function kill(pid: number): 'killed' | 'gone' {
  try {
    process.kill(pid)
    return 'killed'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'
    throw err
  }
}
