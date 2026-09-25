// 探针：title 带引号、反斜杠、花括号、尖括号、Markdown 标点时，建仓生成的仓能不能 install / build / check。
// 用刚构建的 dist/scaffold.js 铺仓，dir 故意用正斜杠写；铺完交给 run.ps1 在生成的仓里跑 pnpm。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planScaffold, renderPluginPage, renderTemplate, writeRepo } from '../../plugins/devkit/dist/scaffold.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const templateRoot = path.resolve(here, '../../plugins/devkit/template')
const dir = path.join(here, 'gen', 'hostile').replaceAll('\\', '/')
const title = `他说"你好" 'q' \\ {x} <b>粗</b> & | # * _ \` ~ [l](u) \${y} */`

const plan = planScaffold({ name: 'probe-hostile', dir, title, docs: false, kernelVersion: '0.6.0' })
const files = renderTemplate(templateRoot, plan)
writeRepo(plan.dir, files)
const page = renderPluginPage(templateRoot, plan)
fs.mkdirSync(path.join(plan.dir, 'page'), { recursive: true })
fs.writeFileSync(path.join(plan.dir, 'page', 'plugin.mdx'), page.text, 'utf8')

// 基线：改之前的替换是纯字符串替换，同一个 title 直接塞进 package.json 模板
const naive = fs
  .readFileSync(path.join(templateRoot, 'pkg', 'package.json.tpl'), 'utf8')
  .replace(/\{\{(\w+)\}\}/g, (_whole, key) => (key === 'title' ? title : 'x'))
try {
  JSON.parse(naive)
  console.log('基线（纯字符串替换）：package.json 解析得了')
} catch (err) {
  console.log(`基线（纯字符串替换）：package.json 解析失败——${err.message}`)
}

console.log(`给的 dir：${dir}`)
console.log(`计划里的 dir：${plan.dir}`)
console.log(`铺好了 ${String(files.length)} 个文件`)
const manifest = JSON.parse(fs.readFileSync(path.join(plan.dir, 'plugins', 'probe-hostile', 'package.json'), 'utf8'))
console.log(`gwb.title 读回来与原文相同：${String(manifest.gwb.title === title)}`)
console.log(`插件页 frontmatter 第二行：${page.text.split('\n')[1]}`)
console.log(`README 第一行：${fs.readFileSync(path.join(plan.dir, 'README.md'), 'utf8').split('\n')[0]}`)
