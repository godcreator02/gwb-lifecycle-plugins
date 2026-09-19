// 探针：用刚构建出来的 dist/scaffold.js 真铺一个薄壳仓（repo/ + pkg/ 两区装配），
// 铺完的目录交给 run.ps1 做 pnpm install / build / check——模板新根形（private 薄壳 +
// plugins/* workspace）能不能在真实 pnpm 里站住，只有这条路答得了。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planScaffold, renderTemplate, writeRepo } from '../../plugins/devkit/dist/scaffold.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const templateRoot = path.resolve(here, '../../plugins/devkit/template')
const dir = path.join(here, 'gen', 'ws-probe')

const plan = planScaffold({ name: 'probe-hello', dir, title: '探针件', docs: false })
const files = renderTemplate(templateRoot, plan)
writeRepo(plan.dir, files)

console.log(`铺好了 ${String(files.length)} 个文件 → ${plan.dir}`)
for (const file of files) console.log(`  ${file.rel}`)
