// node rm.cjs <rmSync|walk> <树> <结果文件>
const fs = require('fs')
const path = require('path')

function walk(target) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (stat.isSymbolicLink()) return fs.unlinkSync(target)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) walk(path.join(target, name))
    return fs.rmdirSync(target)
  }
  fs.unlinkSync(target)
}

const [way, tree, out] = process.argv.slice(2)
let result
try {
  if (way === 'rmSync') fs.rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  else walk(tree)
  result = '没抛'
} catch (err) {
  result = `抛了 ${err.code}`
}
fs.writeFileSync(out, `node ${process.versions.node}：${result}，目录还在 ${fs.existsSync(tree)}`)
