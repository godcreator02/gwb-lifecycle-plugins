import path from 'node:path'

/**
 * 查一个 pid 的三种答案。「查不出」不能跟「不在」混成一个：查映像名的命令会超时、会不在、会自己出错，
 * 当成「进程不在」的话，停 home 就只清掉 pid 文件，那个进程还在运行，线索却删了，此后再也停不了它
 */
export type ProcessProbe = { state: 'running'; name: string } | { state: 'gone' } | { state: 'unknown' }

/** pid 文件的文本 → 正 pid；空串、负数、带尾巴的一律不算数 */
export function parsePid(text: string | undefined): number | undefined {
  const trimmed = text?.trim() ?? ''
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value > 0 ? value : undefined
}

/** 映像名 → 可比的小写裸名：`C:\apps\Electron.exe` 与 `electron` 是同一个东西 */
export function bareImage(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.exe$/, '')
}

/** `tasklist /NH /FO CSV` 的一行 → 映像名。进程不在时它打的 `INFO: No tasks are running...` 没有引号，取不出 */
export function parseTasklist(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const quotedImage = /^"([^"]+)"/.exec(line.trim())
    if (quotedImage?.[1] !== undefined) return quotedImage[1]
  }
  return undefined
}

/** `127.0.0.1:4873`、`[::]:4873` 都算听在 4873 上 */
function endsWithPort(address: string | undefined, port: number): boolean {
  if (address === undefined) return false
  const lastColon = address.lastIndexOf(':')
  return lastColon >= 0 && address.slice(lastColon + 1) === String(port)
}

/** `netstat -ano -p tcp` 的列是 `协议 本地地址 外部地址 状态 pid`，状态那一栏在中文 Windows 上也是英文 */
export function parseNetstat(text: string, port: number): number | undefined {
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5) continue
    if (!/^tcp/i.test(columns[0] ?? '') || columns[3] !== 'LISTENING') continue
    if (!endsWithPort(columns[1], port)) continue
    const ownerPid = Number(columns[4])
    if (Number.isInteger(ownerPid) && ownerPid > 0) return ownerPid
  }
  return undefined
}

/** `ss -ltnp` 的 pid 在最后那栏的 `pid=<号>` 里 */
export function parseSs(text: string, port: number): number | undefined {
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns[0] !== 'LISTEN' || !endsWithPort(columns[3], port)) continue
    const pidMatch = /pid=(\d+)/.exec(line)
    const ownerPid = pidMatch?.[1] === undefined ? Number.NaN : Number(pidMatch[1])
    if (Number.isInteger(ownerPid) && ownerPid > 0) return ownerPid
  }
  return undefined
}

/** 只取最后 n 行，行尾那个换行不算一行 */
export function tailLines(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-max).join('\n')
}
