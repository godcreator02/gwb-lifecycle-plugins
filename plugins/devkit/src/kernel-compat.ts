import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑。比对规则与插件管理的 src/kernel-compat.ts 各存一份、不跨包 import，两份一起改；tests/kernel-compat-parity.test.ts 对照两份

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

/** 包清单 peerDependencies 里内核包的范围；没写或不是字符串时是 undefined */
export function declaredKernelRange(manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined
  const peers = manifest['peerDependencies']
  if (!isRecord(peers)) return undefined
  const range = peers[KERNEL_PACKAGE]
  return typeof range === 'string' ? range : undefined
}

/**
 * `^x.y.z` 包不包含这个内核版本：主版本号为 0 时次版本号相同，≥1 时主版本号相同，并且不低于 x.y.z。只比 x.y.z 三段，
 * 预发布段不看（同一条线的开发版算在范围内）。范围没写或不是 `^x.y.z` 一律 false；内核版本号不合法直接抛错（它来自内核自己的包清单）
 */
export function kernelRangeCovers(range: string | undefined, kernelVersion: string): boolean {
  const kernelMatch = VERSION.exec(kernelVersion)
  if (kernelMatch === null) throw new Error(`内核版本号不是合法的版本号：${JSON.stringify(kernelVersion)}`)
  if (range === undefined) return false
  const rangeMatch = CARET_RANGE.exec(range)
  if (rangeMatch === null) return false
  const kernel = coreOf(kernelMatch)
  const floor = coreOf(rangeMatch)
  const sameLine = floor[0] === 0 ? kernel[0] === 0 && kernel[1] === floor[1] : kernel[0] === floor[0]
  return sameLine && notLowerThan(kernel, floor)
}
