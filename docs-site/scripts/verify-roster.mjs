/**
 * 核对组件名册两边一致：docfirst.config.mjs 里的机读规则表与 src/components/registry.ts 里的 React 组件名单。
 * 缺一边都不行：机读规则表里没有 → 生成机读版时直接报错；React 名单里没有 → 站渲染时报 Expected component。
 * registry.ts 只有可擦除的类型，Node 直接运行。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const config = (await import(pathToFileURL(resolve('docfirst.config.mjs')).href)).default
const { componentNames } = await import(pathToFileURL(resolve('src/components/registry.ts')).href)

const ai = new Set(Object.keys(config.components ?? {}))
const react = new Set(componentNames)
const onlyAi = [...ai].filter((n) => !react.has(n))
const onlyReact = [...react].filter((n) => !ai.has(n))

console.log(`机读规则表：${[...ai].join('、')}`)
console.log(`React 表：${[...react].join('、')}`)
if (onlyAi.length > 0) console.log(`✖ 只有机读规则、没有 React 组件：${onlyAi.join('、')}`)
if (onlyReact.length > 0) console.log(`✖ 只有 React 组件、没有机读规则：${onlyReact.join('、')}`)
const ok = onlyAi.length === 0 && onlyReact.length === 0
console.log(ok ? '✔ 组件名册两边一致' : '✖ 组件名册两边不一致')
process.exit(ok ? 0 : 1)
