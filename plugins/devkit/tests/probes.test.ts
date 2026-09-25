import { describe, expect, it } from 'vitest'
import {
  bareImage,
  parseNetstat,
  parseTasklistTable,
} from '../src/probes.js'

describe('映像名', () => {
  it('映像名归一成小写裸名：绝对路径、大小写、.exe 后缀都剥掉', () => {
    expect(bareImage('C:/apps/Electron.exe')).toBe('electron')
    expect(bareImage('/usr/bin/node')).toBe('node')
    expect(bareImage('node')).toBe('node')
  })

  it('tasklist 的整张 CSV 表：每行取出 pid → 映像名，认不出的行跳过', () => {
    const table = parseTasklistTable(
      [
        '"System Idle Process","0","Services","0","8 K"',
        '"electron.exe","900","Console","1","9,120 K"',
        '"node.exe","14340","Console","1","123,456 K"',
        '',
        'INFO: 这一行不是 CSV',
      ].join('\r\n'),
    )
    expect(table).toEqual(
      new Map([
        [0, 'System Idle Process'],
        [900, 'electron.exe'],
        [14340, 'node.exe'],
      ]),
    )
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

  it('netstat：只认 LISTENING 那行的本地地址，外部地址那栏的端口不算', () => {
    expect(parseNetstat(NETSTAT, 4873)).toBe(14340)
    expect(parseNetstat(NETSTAT, 445)).toBe(4)
    // 52033 只在「外部地址」那栏出现过——本机没人听它
    expect(parseNetstat(NETSTAT, 52033)).toBeUndefined()
    expect(parseNetstat(NETSTAT, 4899)).toBeUndefined()
    expect(parseNetstat('', 4873)).toBeUndefined()
  })
})
