import { isRecord } from './vocab.js'

/**
 * 插件要求 home 里别的包最低到哪个版本：包自己的 package.json 里写 `gwb.requires`（包名 → 最低版本号 x.y.z），
 * 和 home 里装的版本比对。零 I/O 纯逻辑，读包清单的部分在 `home.ts`。
 *
 * 最低版本号只收 x.y.z（不带预发布段）。devkit.release 发版前拒不合法的最低版本号，判法与这里的 `isMinimumVersion`
 * 相同，两边各存一份、不跨包 import；devkit 的 `tests/requires-parity.test.ts` 拿同一组输入跑两份，结果不同就失败。
 */

/** 一条没满足的要求 */
export interface UnmetRequire {
  /** 要求的包 */
  pkg: string
  /** 声明里写的最低版本号，原样照抄；不是合法的 x.y.z 也照抄，并算作没满足 */
  required: string
  /** home 里装的版本号；没装时没有这个字段 */
  installed?: string
}

/** 一个包在 `list` 回执里和 `gwb.requires` 有关的字段 */
export interface RequiresStatus {
  /** 包清单里的 `gwb.requires`，原样照抄。没写、或写的不是「包名 → 字符串」的对象时没有这个字段 */
  requires?: Record<string, string>
  /** 没满足的要求；全都满足、没写 `gwb.requires` 时是空数组 */
  unmetRequires: UnmetRequire[]
  /** `gwb.requires` 写了、但不是「包名 → 字符串」的对象时，说明哪里不对；这时不比对任何一条 */
  requiresInvalid?: string
}

/** 包清单里 `gwb.requires` 的三种情况 */
export type DeclaredRequires =
  | { kind: 'absent' }
  | { kind: 'declared'; requires: Record<string, string> }
  | { kind: 'invalid'; problem: string }

const MINIMUM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const INSTALLED_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 是不是合法的最低版本号：x.y.z，每段是不带前导零的数字，不带预发布段与构建段 */
export function isMinimumVersion(value: string): boolean {
  return MINIMUM_VERSION.test(value)
}

/** 读包清单里的 `gwb.requires`。清单读不到、没有 `gwb` 字段、`gwb` 里没有 `requires` 都是 absent */
export function declaredRequires(manifest: unknown): DeclaredRequires {
  if (!isRecord(manifest)) return { kind: 'absent' }
  const gwb = manifest['gwb']
  if (!isRecord(gwb) || !('requires' in gwb)) return { kind: 'absent' }
  const raw = gwb['requires']
  if (!isRecord(raw)) {
    return { kind: 'invalid', problem: `gwb.requires 要写成 { "<包名>": "<最低版本号 x.y.z>" }，实际是 ${JSON.stringify(raw)}` }
  }
  const requires: Record<string, string> = {}
  const notStrings: string[] = []
  for (const [pkg, value] of Object.entries(raw)) {
    if (typeof value === 'string') requires[pkg] = value
    else notStrings.push(pkg)
  }
  if (notStrings.length > 0) {
    return { kind: 'invalid', problem: `gwb.requires 里 ${notStrings.join('、')} 的值不是字符串，要写成 "x.y.z"` }
  }
  return { kind: 'declared', requires }
}

/** 包清单里的 `version`；清单读不到或没写时是 undefined */
export function installedVersionOf(manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined
  const version = manifest['version']
  return typeof version === 'string' ? version : undefined
}

/**
 * 装的版本满不满足最低版本号。最低版本号不是合法的 x.y.z、装的版本号不合法，都算不满足。
 * 三段相同时带预发布段的算低于最低版本号：`0.5.0-dev.1` 不满足 `0.5.0`。
 */
export function meetsMinimum(installed: string, minimum: string): boolean {
  const floor = MINIMUM_VERSION.exec(minimum)
  const actual = INSTALLED_VERSION.exec(installed)
  if (floor === null || actual === null) return false
  for (const index of [1, 2, 3]) {
    const difference = Number(actual[index]) - Number(floor[index])
    if (difference !== 0) return difference > 0
  }
  return actual[4] === undefined
}

/**
 * 包清单（读不到时是 undefined）→ `list` 回执里的字段。
 * `installedVersions` 是 home 里装了的包 → 版本号，不在表里的算没装。
 */
export function requiresStatusOf(manifest: unknown, installedVersions: ReadonlyMap<string, string>): RequiresStatus {
  const declared = declaredRequires(manifest)
  if (declared.kind === 'absent') return { unmetRequires: [] }
  if (declared.kind === 'invalid') return { unmetRequires: [], requiresInvalid: declared.problem }
  const unmetRequires: UnmetRequire[] = []
  for (const [pkg, required] of Object.entries(declared.requires)) {
    const installed = installedVersions.get(pkg)
    if (installed === undefined) unmetRequires.push({ pkg, required })
    else if (!meetsMinimum(installed, required)) unmetRequires.push({ pkg, required, installed })
  }
  return { requires: declared.requires, unmetRequires }
}
