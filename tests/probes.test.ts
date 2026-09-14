import { describe, expect, it } from 'vitest'
import {
  bareImage,
  parseNetstat,
  parsePid,
  parseSs,
  parseTasklist,
  tailLines,
} from '../src/probes.js'

/**
 * 进程探测与日志尾巴的纯机测试。原在 daemon.test.ts 里，registry 退役后这些解析器
 * 迁进 probes.ts，测试跟着走——判据一条没改。
 */

describe('pid 判活', () => {
  it('pid 文件里不是一个像样的数就当没有', () => {
    expect(parsePid('14340\n')).toBe(14340)
    expect(parsePid('  14340  ')).toBe(14340)
    for (const bad of ['', '   ', '-1', '0', '14340x', 'abc', undefined]) {
      expect(parsePid(bad), String(bad)).toBeUndefined()
    }
  })

  it('映像名归一成小写裸名：绝对路径、大小写、.exe 后缀都剥掉', () => {
    expect(bareImage('C:/apps/Electron.exe')).toBe('electron')
    expect(bareImage('/usr/bin/node')).toBe('node')
    expect(bareImage('node')).toBe('node')
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
    '  TCP    100.66.1.1:4873        0.0.0.0:0              LISTENING       14340',
    '  TCP    100.66.1.1:4873        100.66.1.2:52033       ESTABLISHED     14340',
    '  TCP    [::]:445               [::]:0                 LISTENING       4',
  ].join('\r\n')

  const SS = [
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN 0      511    100.66.1.1:4873    0.0.0.0:*         users:(("node",pid=14340,fd=20))',
    'LISTEN 0      4096    [::]:22            [::]:*            users:(("sshd",pid=900,fd=4))',
  ].join('\n')

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

describe('尾巴', () => {
  it('只取最后 n 行，行尾那个换行不算一行', () => {
    const text = ['a', 'b', 'c', 'd'].join('\n') + '\n'
    expect(tailLines(text, 2)).toBe('c\nd')
    expect(tailLines(text, 99)).toBe('a\nb\nc\nd')
    expect(tailLines('', 10)).toBe('')
  })
})
