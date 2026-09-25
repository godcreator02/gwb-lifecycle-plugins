import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { parseNetstat, parseTasklistTable } from './probes.js'

// 真机器上的读写文件、查进程、查端口、结束进程，没有单元测试；判断逻辑在 probes.ts 与 home.ts

/** 列整张进程表的上限。tasklist 在这台机器上一次要一到两秒，卡住了查状态的命令不能跟着卡住 */
const PROCESS_TABLE_TIMEOUT_MS = 10_000
/** 查一次端口持有者的上限。netstat 要打出整张连接表 */
const PORT_OWNER_TIMEOUT_MS = 5_000

export const nodeFs = {
  exists: (target: string) => fs.existsSync(target),
  /** 文件不在回 undefined；别的读错（权限、被占）照样抛 */
  readText(file: string): string | undefined {
    if (!fs.existsSync(file)) return undefined
    return fs.readFileSync(file, 'utf8')
  },
  writeText: (file: string, text: string) => fs.writeFileSync(file, text, 'utf8'),
  /** 目录不在回空表：home 根还没建出来就是一个 home 都没有 */
  dirs(target: string): string[] {
    if (!fs.existsSync(target)) return []
    return fs
      .readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  },
}

/** 跑一条查进程 / 查端口的命令，回它的 stdout。超时、命令不在、命令自己出错都抛：查不出不是「没有」 */
function runProbe(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(new Error(`${command} ${args.join(' ')} 没成:${error.message}`))
      else resolve(stdout)
    })
  })
}

/** 一次列出全部进程：pid → 映像名。不用 WMI：这台机器上 `Get-CimInstance` 会死锁 */
export async function processTable(): Promise<Map<number, string>> {
  return parseTasklistTable(await runProbe('tasklist', ['/NH', '/FO', 'CSV'], PROCESS_TABLE_TIMEOUT_MS))
}

/** 结束进程之前的第二道核对：映像名只能证明「这是跟宿主同一个 exe」，pid 被复用时会结束别人的进程。没人监听回 undefined */
export async function portOwner(port: number): Promise<number | undefined> {
  return parseNetstat(await runProbe('netstat', ['-ano', '-p', 'tcp'], PORT_OWNER_TIMEOUT_MS), port)
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