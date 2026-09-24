import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑。devkit 从本包主入口 import 这里的比对规则做发版检查，改了它发版检查跟着变

/** 内核包的包名。插件在 peerDependencies 里写它的版本范围，声明兼容哪些内核 */
export const KERNEL_PACKAGE = '@godcreator/gwb-kernel-desktop'

const CARET_RANGE = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

type VersionCore = readonly [number, number, number]

function coreOf(match: RegExpExecArray): VersionCore {
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function notLowerThan(version: VersionCore, floor: VersionCore): boolean {
  for (let index = 0; index < 3; index++) {
    if (version[index]! !== floor[index]!) return version[index]! > floor[index]!
  }
  return true
}

/** 生态里 peer 只许 `^x.y.z` 这一种写法 */
export function isCaretRange(range: string): boolean {
  return CARET_RANGE.test(range)
}

/** 一个准确的版本号：x.y.z 三段，可带预发布段与构建段；不是范围 */
export function isExactVersion(version: string): boolean {
  return VERSION.test(version)
}

/**
 * `^x.y.z` 包不包含这个版本：主版本号为 0 时次版本号相同，≥1 时主版本号相同，并且不低于 x.y.z。只比 x.y.z 三段，
 * 预发布段不看（同一条线的开发版算在范围内）。范围不是 `^x.y.z`、版本号不合法都是 false
 */
export function caretRangeCovers(range: string, version: string): boolean {
  const rangeMatch = CARET_RANGE.exec(range)
  const versionMatch = VERSION.exec(version)
  if (rangeMatch === null || versionMatch === null) return false
  const actual = coreOf(versionMatch)
  const floor = coreOf(rangeMatch)
  const sameLine = floor[0] === 0 ? actual[0] === 0 && actual[1] === floor[1] : actual[0] === floor[0]
  return sameLine && notLowerThan(actual, floor)
}

/** 包清单 peerDependencies 里内核包的范围；没写或不是字符串时是 undefined */
export function declaredKernelRange(manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined
  const peers = manifest['peerDependencies']
  if (!isRecord(peers)) return undefined
  const range = peers[KERNEL_PACKAGE]
  return typeof range === 'string' ? range : undefined
}

/** 规则同 `caretRangeCovers`；范围没写是 false；内核版本号不合法直接抛错（它来自内核自己的包清单） */
export function kernelRangeCovers(range: string | undefined, kernelVersion: string): boolean {
  if (!isExactVersion(kernelVersion)) throw new Error(`内核版本号不是合法的版本号：${JSON.stringify(kernelVersion)}`)
  return range !== undefined && caretRangeCovers(range, kernelVersion)
}

/** 一个包在 `list` 回执里和内核版本有关的两个字段 */
export interface KernelCompatStatus {
  /** 包清单 peerDependencies 里内核包的范围。没写、或写的不是字符串时没有这个字段 */
  kernelRange?: string
  /** 范围不包含运行中的内核；没写、写的不是 `^x.y.z` 也算 */
  kernelUntested: boolean
}

/** 包清单（读不到时是 undefined）→ `list` 回执里的两个字段 */
export function kernelCompatStatusOf(manifest: unknown, runningKernel: string): KernelCompatStatus {
  const kernelRange = declaredKernelRange(manifest)
  const kernelUntested = !kernelRangeCovers(kernelRange, runningKernel)
  return kernelRange === undefined ? { kernelUntested } : { kernelRange, kernelUntested }
}
