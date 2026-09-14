import path from 'node:path'

/**
 * 进程探测与日志尾巴的纯机。原是 daemon.ts（本机 registry 起停）的一部分，registry
 * 退役后这些判活与解析的家当由 home 那半（杀 home 进程前的两道核对）继续用，遂独立成篇。
 *
 * **这里全是纯函数，单测在 `tests/probes.test.ts`**；真机器上怎么拿到那些答案
 * （tasklist、netstat、ss）在 `node-probe-deps.ts` 的环境胶水里。
 */

/** 查一个 pid 的三种答案。**「查不出」不能跟「不在」混成一个**：查映像名那条命令会
 * 超时、会不在、会自己出错，把这些当成「进程不在」的话，停就退化成「只清一份 pid
 * 文件」——那个进程还在跑，线索却被删了，此后再也停不了它。 */
export type ProcessProbe = { state: 'running'; name: string } | { state: 'gone' } | { state: 'unknown' }

/** `pid 文件`的文本 → 正 pid；空串、负数、带尾巴的一律不算数 */
export function parsePid(text: string | undefined): number | undefined {
  const raw = text?.trim() ?? ''
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return value > 0 ? value : undefined
}

/** 映像名 → 可比的小写裸名:`C:\apps\Electron.exe` 与 `electron` 是同一个东西 */
export function bareImage(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.exe$/, '')
}

/**
 * `tasklist /NH /FO CSV` 的一行 → 映像名。进程不在时它打的是一句
 * `INFO: No tasks are running...`，那一行没有引号，正好被下面这条判掉。
 */
export function parseTasklist(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = /^"([^"]+)"/.exec(line.trim())
    if (m?.[1] !== undefined) return m[1]
  }
  return undefined
}

/** 一行里的那个地址是不是听在这个端口上（`127.0.0.1:4873`、`[::]:4873` 都算） */
function endsWithPort(address: string | undefined, port: number): boolean {
  if (address === undefined) return false
  const at = address.lastIndexOf(':')
  return at >= 0 && address.slice(at + 1) === String(port)
}

/**
 * `netstat -ano -p tcp` 的输出 → 这个端口上 LISTENING 的那个 pid。列是
 * `协议 本地地址 外部地址 状态 pid`，状态那一栏在中文 Windows 上也是英文。
 */
export function parseNetstat(text: string, port: number): number | undefined {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    if (!/^tcp/i.test(parts[0] ?? '') || parts[3] !== 'LISTENING') continue
    if (!endsWithPort(parts[1], port)) continue
    const owner = Number(parts[4])
    if (Number.isInteger(owner) && owner > 0) return owner
  }
  return undefined
}

/**
 * `ss -ltnp` 的输出 → 这个端口上 listen 的那个 pid。pid 在最后那栏的 `pid=<号>` 里。
 */
export function parseSs(text: string, port: number): number | undefined {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] !== 'LISTEN' || !endsWithPort(parts[3], port)) continue
    const m = /pid=(\d+)/.exec(line)
    const owner = m?.[1] === undefined ? Number.NaN : Number(m[1])
    if (Number.isInteger(owner) && owner > 0) return owner
  }
  return undefined
}

/** 日志尾巴：只取最后 n 行，行尾那个换行不算一行 */
export function tailLines(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-max).join('\n')
}
