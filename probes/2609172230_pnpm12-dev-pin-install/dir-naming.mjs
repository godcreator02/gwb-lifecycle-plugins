// node dir-naming.mjs <项目目录> <包名>
// 读 pnpm-lock.yaml 里这个包的每个快照键（带 peer 后缀的 depPath），按「/ 换 +、括号换 _、超长截前 27 字符 + _ +
// sha256 前 32 位」算目录名，与 node_modules/.pnpm 下实际的目录逐个对照。Windows 上 virtualStoreDirMaxLength 缺省 60。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [dir, pkg] = process.argv.slice(2)
const lock = fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8')
const snapshots = lock.split(/\r?\n/).filter((line) => line.startsWith(`  '${pkg}@`) && line.includes('(')).map((line) => line.trim().replace(/^'|':$/g, ''))
const actual = fs.readdirSync(path.join(dir, 'node_modules', '.pnpm')).filter((name) => name.startsWith(pkg.replace('/', '+')))

function dirName(depPath, max = 60) {
  let name = depPath.replace(/[\\/:*?"<>|]/g, '+')
  if (name.includes('(')) name = name.replace(/\)$/, '').replace(/(\)\()|\(|\)/g, '_')
  if (name.length > max) return `${name.slice(0, max - 33)}_${createHash('sha256').update(name).digest('hex').slice(0, 32)}`
  return name
}

for (const key of snapshots) {
  const want = dirName(key)
  console.log(`${key.slice(0, key.indexOf('('))} → ${want} ${actual.includes(want) ? '在盘上' : '盘上没有'}`)
}
console.log(`盘上 ${pkg} 的目录：${actual.join('、')}`)
