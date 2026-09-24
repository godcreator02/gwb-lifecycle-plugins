import { execFile } from 'node:child_process'
import fs from 'node:fs'
import type { ProcessProbe } from './probes.js'
import { parseNetstat, parseTasklist } from './probes.js'

// 真机器上的读写文件、查进程、查端口、结束进程，没有单元测试；判断逻辑在 probes.ts 与 home.ts

/** 查一次映像名的上限。tasklist 平时几十毫秒，卡住了查状态的命令不能跟着卡住 */
const PROCESS_NAME_TIMEOUT_MS = 5_000
/** 查一次端口持有者的上限。netstat 要打出整张连接表，比 tasklist 慢 */
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

/** 不用 WMI：这台机器上 `Get-CimInstance` 会死锁。超时、命令不在、tasklist 自己出错都算「查不出」 */
export function processName(pid: number): Promise<ProcessProbe> {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { timeout: PROCESS_NAME_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve({ state: 'unknown' })
          return
        }
        const name = parseTasklist(stdout)
        resolve(name === undefined ? { state: 'gone' } : { state: 'running', name })
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
 * 结束进程之前的第二道核对：映像名只能证明「这是 node 或跟宿主同一个 exe」，pid 被复用时会结束别人的进程。
 * 取不出来（没人监听、netstat 不在或出错）回 undefined，那时只按映像名核对
 */
export async function portOwner(port: number): Promise<number | undefined> {
  const out = await runProbe('netstat', ['-ano', '-p', 'tcp'], PORT_OWNER_TIMEOUT_MS)
  return out === undefined ? undefined : parseNetstat(out, port)
}

/** 结束了或本来就不在之外的情况（EPERM 之类）一律抛出，由调用方写进各自的失败说明 */
export function kill(pid: number): 'killed' | 'gone' {
  try {
    process.kill(pid)
    return 'killed'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'
    throw err
  }
}
