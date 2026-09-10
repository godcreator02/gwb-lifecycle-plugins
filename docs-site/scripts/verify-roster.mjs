/**
 * 名册两头对：docfirst.config.mjs 里的压平表 vs src/components/registry.ts 里的 React 名单。
 * 少一边都不行：压平表没有 → 机读版硬失败；React 表没有 → 站渲染报 Expected component。
 * registry.ts 只有可擦除的类型，Node 直接吃。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const config = (await import(pathToFileURL(resolve('docfirst.config.mjs')).href)).default
const { componentNames } = await import(pathToFileURL(resolve('src/components/registry.ts')).href)

const ai = new Set(Object.keys(config.components ?? {}))
const react = new Set(componentNames)
const onlyAi = [...ai].filter((n) => !react.has(n))
const onlyReact = [...react].filter((n) => !ai.has(n))

console.log(`压平表：${[...ai].join('、')}`)
console.log(`React 表：${[...react].join('、')}`)
if (onlyAi.length > 0) console.log(`✖ 只有压平规则、没有 React 组件：${onlyAi.join('、')}`)
if (onlyReact.length > 0) console.log(`✖ 只有 React 组件、没有压平规则：${onlyReact.join('、')}`)
const ok = onlyAi.length === 0 && onlyReact.length === 0
console.log(ok ? '✔ 名册两头齐' : '✖ 名册两头不齐')
process.exit(ok ? 0 : 1)
