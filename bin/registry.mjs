// 本机 Verdaccio 的起停，命令行入口：`node <包根>/bin/registry.mjs <动作> <registry 目录>`
//
//   status   查一次：地址、在不在跑、pid、是不是接管来的
//   up       拉起（已经在跑就直接接管），轮询 /-/ping 最多 30 秒
//   down     按 pid 文件停，核对映像名与端口持有者再杀
//
// **这支不是第二份实现，是第二个入口**：逻辑全在 `../dist/daemon.js` 里，跟件那半
// `registry.*` 三条命令调的是同一份。它存在的理由只有一个——工作台没起的时候源也得
// 起得来，而起源恰恰是工作台自举的前提（首启要从源上装件）。
//
// 跟 `cdp.mjs` 不一样：那支是零依赖单文件、连包都不用装就能跑，因为它要在「工作台起
// 不来」时救场；这支只要求包已经装进某个 home（`yaml` 与 `dist/` 跟着包走），要求更低
// 的那种场面不存在——源都没起的时候，包本来就是从源上装的。
//
// 退出码：成了 0，没成 1。回执是一段 JSON，打在 stdout 上。

import path from 'node:path'
import process from 'node:process'
import { bringDown, bringUp, readStatus } from '../dist/daemon.js'
import { kill, makeSpawn, nodeFs, ping, portOwner, processName } from '../dist/node-registry-deps.js'

const USAGE = [
  '用法：node <包根>/bin/registry.mjs <status|up|down> <registry 目录>',
  '',
  '  目录要含 config.yaml、storage、node_modules/verdaccio。',
  '  地址与端口从那份 config.yaml 的 listen 推，这儿不写死任何端口。',
].join('\n')

const [action, rawDir] = process.argv.slice(2)

function die(message) {
  console.error(message)
  process.exit(1)
}

if (action === undefined || !['status', 'up', 'down'].includes(action)) {
  die(`不认得这个动作：${action ?? '（没给）'}\n\n${USAGE}`)
}
if (rawDir === undefined || rawDir.trim() === '') {
  die(`没给 registry 目录。\n\n${USAGE}`)
}

const dir = path.resolve(rawDir)

/**
 * 跟件那半同一份注入面。**`execPath` 是本进程的 node**：起出来的子进程映像名因此是
 * node，而那个名字会跟 pid 一起落进 pid 文件，件那半（跑在 electron 里）读的时候照记录
 * 比，不会把它判成「不是它」。
 */
const deps = {
  fs: nodeFs,
  spawn: makeSpawn((message) => console.error(message)),
  ping,
  processName,
  portOwner,
  kill,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  execPath: process.execPath,
  env: process.env,
}

const out = (ok, data) => {
  console.log(JSON.stringify(data, null, 2))
  process.exit(ok ? 0 : 1)
}

if (action === 'status') {
  const status = await readStatus(dir, deps)
  // 「在不在跑」的唯一判据是 ping 通不通，退出码照它给：串在脚本里的时候，没跑就该非零
  out(status.running, status)
} else if (action === 'up') {
  const outcome = await bringUp(dir, deps)
  out(outcome.ok, outcome.ok ? { ...outcome.status, note: outcome.note } : { error: outcome.error })
} else {
  const outcome = await bringDown(dir, deps)
  out(outcome.ok, outcome)
}
