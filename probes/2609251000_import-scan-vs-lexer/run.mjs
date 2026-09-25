// 跑法见 README 第一行。把 import-scan.ts（快照）与 es-module-lexer 放在同一批真实 ESM 文件上对照：原样一次、esbuild 压成一行再一次
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { init, parse } from 'es-module-lexer'
import { transformSync } from 'esbuild'
import { scanModuleImports } from './import-scan.ts'
import { oldSpecifiers } from './old-regex.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
await init

/** 语料：本目录 node_modules/.pnpm 下全部 .js / .mjs（跳过 .d.ts、cjs） */
function corpusFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.m?js$/.test(entry.name)) out.push(full)
    }
  }
  walk(path.join(here, 'node_modules', '.pnpm'))
  return out.sort()
}

/** es-module-lexer 的结果，换成和 scanModuleImports 同一种写法：static/dynamic + 说明符；动态且参数不是字符串字面量的不记 */
function lexerRecords(code) {
  const [imports] = parse(code)
  const records = []
  for (const one of imports) {
    if (one.t === 1 && one.n !== undefined) records.push(`static ${one.n}`)
    else if (one.t === 2 && one.n !== undefined) {
      // es-module-lexer 对无插值的模板字面量也给 n；scanModuleImports 只认引号字符串，这类单独计数
      const argument = code.slice(one.s, one.e)
      records.push(argument.startsWith('`') ? `dynamic-template ${one.n}` : `dynamic ${one.n}`)
    }
  }
  return records
}

function scanRecords(code) {
  return scanModuleImports(code).map((one) => `${one.dynamic ? 'dynamic' : 'static'} ${one.specifier}`)
}

function isEsm(code) {
  try {
    const [imports, exports, , hasModuleSyntax] = parse(code)
    return hasModuleSyntax || imports.length > 0 || exports.length > 0
  } catch {
    return false
  }
}

function compare(label, code, report) {
  let expected
  try {
    expected = lexerRecords(code)
  } catch {
    report.lexerFailed++
    return
  }
  let got
  try {
    got = scanRecords(code)
  } catch (err) {
    report.scanThrew.push(`${label}: ${err.message}`)
    return
  }
  const templateOnly = expected.filter((r) => r.startsWith('dynamic-template '))
  report.templateDynamic += templateOnly.length
  const wanted = expected.filter((r) => !r.startsWith('dynamic-template ')).sort()
  got.sort()
  report.compared++
  report.records += wanted.length
  if (JSON.stringify(wanted) !== JSON.stringify(got)) {
    const missing = wanted.filter((r) => !got.includes(r))
    const extra = got.filter((r) => !wanted.includes(r))
    report.mismatched.push(`${label}\n    少了: ${JSON.stringify(missing)}\n    多了: ${JSON.stringify(extra)}`)
  }
}

function freshReport() {
  return { compared: 0, records: 0, templateDynamic: 0, lexerFailed: 0, scanThrew: [], mismatched: [] }
}

function printReport(title, report) {
  console.log(`== ${title}`)
  console.log(`对照的文件 ${report.compared} 个，es-module-lexer 找到的 import ${report.records} 条；es-module-lexer 读不了、跳过 ${report.lexerFailed} 个`)
  console.log(`参数是无插值模板字面量的动态 import（scanModuleImports 不记，单独数）：${report.templateDynamic} 条`)
  console.log(`scanModuleImports 抛错 ${report.scanThrew.length} 个${report.scanThrew.map((line) => `\n  ${line}`).join('')}`)
  console.log(`结果不一致 ${report.mismatched.length} 个${report.mismatched.map((line) => `\n  ${line}`).join('')}`)
}

const files = corpusFiles().filter((file) => isEsm(fs.readFileSync(file, 'utf8')))
const asIs = freshReport()
const minified = freshReport()
let minifyFailed = 0
const started = Date.now()
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8')
  const label = path.relative(here, file).replaceAll('\\', '/')
  compare(label, code, asIs)
  let oneLine
  try {
    oneLine = transformSync(code, { minify: true, format: 'esm', loader: 'js', target: 'esnext', logLevel: 'silent' }).code
  } catch {
    minifyFailed++
    continue
  }
  compare(`${label}（压成一行）`, oneLine, minified)
}
console.log(`语料：node_modules/.pnpm 下 es-module-lexer 认作 ESM 的 .js / .mjs 共 ${files.length} 个，用时 ${Date.now() - started} ms`)
printReport('原样', asIs)
printReport(`esbuild minify 之后（esbuild 转不了、跳过 ${minifyFailed} 个）`, minified)

// 块笔记 gwb-bn-core 的浏览器侧产物：压成一行后旧写法与新写法各找到什么
const blockNote = process.env.BLOCK_NOTE_CLIENT
if (blockNote !== undefined && fs.existsSync(blockNote)) {
  const original = fs.readFileSync(blockNote, 'utf8')
  console.log(`== 块笔记 ${blockNote} 原样（不压行发的那一版，${(original.length / 1024 / 1024).toFixed(2)} MB）`)
  console.log(`旧写法（按行正则）找到：${JSON.stringify(oldSpecifiers(original).sort())}`)
  console.log(`scanModuleImports 找到：${JSON.stringify([...new Set(scanRecords(original))].sort())}`)
  const oneLine = transformSync(original, { minify: true, format: 'esm', loader: 'js', target: 'es2022' }).code
  const t0 = Date.now()
  const scanned = scanRecords(oneLine)
  const scanMs = Date.now() - t0
  console.log(`== 块笔记 ${blockNote} 压成一行（${(oneLine.length / 1024 / 1024).toFixed(2)} MB，行数 ${oneLine.split('\n').length}）`)
  console.log(`旧写法（按行正则）找到：${JSON.stringify(oldSpecifiers(oneLine).sort())}`)
  console.log(`scanModuleImports 找到（${scanMs} ms）：${JSON.stringify([...new Set(scanned)].sort())}`)
  console.log(`es-module-lexer 找到：${JSON.stringify([...new Set(lexerRecords(oneLine))].sort())}`)
}
