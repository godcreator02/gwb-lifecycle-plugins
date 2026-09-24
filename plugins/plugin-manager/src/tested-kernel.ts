import { isRecord } from './vocab.js'

/**
 * 插件在哪个内核版本上测过：包自己的 package.json 里写 `gwb.testedKernel`，和运行中的内核版本比对。
 * 零 I/O 纯逻辑，读包清单的部分在 `home.ts`。
 *
 * 比对规则与 devkit（@godcreator/gwb-devkit 的 `src/tested-kernel.ts`）相同，两边各存一份、不跨包 import；
 * 改规则时和 devkit 那份一起改。devkit 的 `tests/tested-kernel-parity.test.ts` 拿同一组输入跑两份，结果不同就失败。
 */

/** 一个包在 `list` 回执里和内核版本有关的两个字段 */
export interface KernelTestStatus {
  /** 包清单里 `gwb.testedKernel` 写的字符串。没写、或写的不是字符串时没有这个字段 */
  testedKernel?: string
  /** 声明的版本和运行中的内核不在同一条版本线上；没声明、声明的不是合法版本号也算 */
  kernelUntested: boolean
}

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

/** 包清单（读不到时是 undefined）→ `list` 回执里的两个字段 */
export function kernelTestStatusOf(manifest: unknown, runningKernel: string): KernelTestStatus {
  const testedKernel = declaredTestedKernel(manifest)
  const kernelUntested = !testedOnSameKernelLine(testedKernel, runningKernel)
  return testedKernel === undefined ? { kernelUntested } : { testedKernel, kernelUntested }
}
