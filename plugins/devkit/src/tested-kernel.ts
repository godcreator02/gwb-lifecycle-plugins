import { isRecord } from './vocab.js'

/**
 * 插件在哪个内核版本上测过：包自己的 package.json 里写 `gwb.testedKernel`，和运行中的内核版本比对。
 * 比对规则与插件管理（@godcreator/gwb-plugin-manager 的 `src/tested-kernel.ts`）相同，两边各存一份、
 * 不跨包 import；改规则时两份一起改。
 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 版本号所在的内核版本线：主版本号为 0 时是前两位（`0.2.7` → `0.2`），主版本号 ≥1 时只取主版本号
 * （`1.4.0` → `1`）。不是合法版本号时是 undefined。
 */
export function kernelVersionLine(version: string): string | undefined {
  const match = SEMVER.exec(version)
  if (match === null) return undefined
  const major = match[1]!
  return major === '0' ? `0.${match[2]!}` : major
}

/**
 * 声明的测试版本和运行中的内核是否在同一条版本线上。声明缺失或不合法一律是 false；
 * 运行中的内核版本号不合法直接抛错——它来自内核自己的包清单，不合法说明内核坏了。
 */
export function testedOnSameKernelLine(testedKernel: string | undefined, runningKernel: string): boolean {
  const runningLine = kernelVersionLine(runningKernel)
  if (runningLine === undefined) throw new Error(`运行中的内核版本号不是合法的版本号：${JSON.stringify(runningKernel)}`)
  if (testedKernel === undefined) return false
  return kernelVersionLine(testedKernel) === runningLine
}

/** 包清单里 `gwb.testedKernel` 的值；没写或不是字符串时是 undefined */
export function declaredTestedKernel(manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined
  const gwb = manifest['gwb']
  if (!isRecord(gwb)) return undefined
  const tested = gwb['testedKernel']
  return typeof tested === 'string' ? tested : undefined
}
