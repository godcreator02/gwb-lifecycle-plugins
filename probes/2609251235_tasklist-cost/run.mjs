// 测 tasklist 在这台机器上一次要多久：按单个 pid 过滤查、不过滤列整张表，各跑五次
import { execFile } from 'node:child_process'

function timeTasklist(args) {
  return new Promise((resolve) => {
    const started = Date.now()
    execFile('tasklist', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ms: Date.now() - started, ok: error === null, lines: stdout.split('\n').filter((line) => line.trim() !== '').length })
    })
  })
}

const rounds = 5
for (const [label, args] of [
  ['按 pid 过滤', ['/FI', `PID eq ${process.pid}`, '/NH', '/FO', 'CSV']],
  ['整张表', ['/NH', '/FO', 'CSV']],
]) {
  const results = []
  for (let i = 0; i < rounds; i += 1) results.push(await timeTasklist(args))
  console.log(`${label}：${results.map((r) => `${r.ms}ms`).join(' / ')}（输出 ${results[0].lines} 行，全部成功：${results.every((r) => r.ok)}）`)
}
