import path from 'node:path'

/** 进程表里查一个 pid 的答案。进程表查不出时不会走到这里：那时直接抛，查不出不是「不在」 */
export type ProcessProbe = { state: 'running'; name: string } | { state: 'gone' }

/** 映像名 → 可比的小写裸名：`C:\apps\Electron.exe` 与 `electron` 是同一个东西 */
export function bareImage(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.exe$/, '')
}


/** 不加过滤的 `tasklist /NH /FO CSV` → pid 到映像名的表；前两列是 `"映像名","pid"`，认不出的行跳过 */
export function parseTasklistTable(text: string): Map<number, string> {
  const table = new Map<number, string>()
  for (const line of text.split('\n')) {
    const columns = /^"([^"]+)","(\d+)"/.exec(line.trim())
    if (columns?.[1] !== undefined && columns[2] !== undefined) table.set(Number(columns[2]), columns[1])
  }
  return table
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
