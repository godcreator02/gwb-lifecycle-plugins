// 纯函数，不读磁盘、不联网；扫仓与问源在 node-audit-deps.ts

/** 一份 package.json 里查得到的那部分 */
export interface ManifestDeps {
  /** peerDependencies 的全部条目 */
  peers: Record<string, string>
  /** devDependencies 里的 @godcreator 条目 */
  devs: Record<string, string>
  /** `private: true`：不发布，不查 peer */
  private: boolean
  /** `keywords` 含 `gwb-plugin`：只有插件包查 peer */
  plugin: boolean
}

/** 一个包在 registry 上的现值 */
export interface RegistryInfo {
  /** 全部版本号。空表＝源上没这个包 */
  versions: string[]
  /** `dist-tags.latest`。没有＝这个包还没发过正式版（只有开发版）。不是版本表里最大的号：开发版号比正式版大 */
  latest?: string
}

export type FindingKind = 'dead-pin' | 'behind' | 'out-of-range' | 'loose-dev-pin' | 'peer-not-cordis'

export interface Finding {
  kind: FindingKind
  repo: string
  /** 相对仓根的 package.json 路径，'.' 是仓根那份 */
  manifest: string
  pkg: string
  detail: string
}

const CORE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

interface ParsedVersion {
  core: number[]
  prerelease: string[]
}

/** 认不出的号三段按点拆、各取整数，取不到当 0 */
function parseVersion(version: string): ParsedVersion {
  const match = CORE.exec(version)
  if (match === null) {
    const parts = version.split('.')
    return {
      core: [0, 1, 2].map((i) => {
        const n = Number.parseInt(parts[i] ?? '0', 10)
        return Number.isNaN(n) ? 0 : n
      }),
      prerelease: [],
    }
  }
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

/** 两个都带预发布段时按点分段比，数字段按数字比、数字段小于非数字段 */
function comparePrereleaseSegments(left: readonly string[], right: readonly string[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number(x) : undefined
    const ny = /^\d+$/.test(y) ? Number(y) : undefined
    if (nx !== undefined && ny !== undefined) return nx < ny ? -1 : 1
    if (nx !== undefined) return -1
    if (ny !== undefined) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 三段逐段按数字比（0.10.0 大于 0.9.9，按字符串比会错）；三段相同时带预发布段的小于不带的 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const x = left.core[i] ?? 0
    const y = right.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }
  return comparePrereleaseSegments(left.prerelease, right.prerelease)
}

/** 出生证原文里读一个字段。读不到、认不出都回 undefined——宁可多扫 */
function unitField(text: string | undefined, key: string): unknown {
  if (text === undefined) return undefined
  try {
    const doc = JSON.parse(text) as unknown
    if (typeof doc !== 'object' || doc === null) return undefined
    return (doc as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** 单元的出生证（unit.json 原文）说它退役了没有。读不到、认不出都当没退役——宁可多扫 */
export function unitRetired(text: string | undefined): boolean {
  return unitField(text, 'status') === 'retired'
}

/** 出生证 `kind` 是「测试件」的单元（测试用的示范插件）：与退役一样整个不扫，名字单列 */
export function unitTest(text: string | undefined): boolean {
  return unitField(text, 'kind') === '测试件'
}

const EXACT = /^\d+\.\d+\.\d+$/
const CARET = /^\^(\d+\.\d+\.\d+)$/

/** `^x.y.z` 的下限；别的写法回 undefined */
export function caretFloor(range: string): string | undefined {
  return CARET.exec(range.trim())?.[1]
}

/** `^<floor>` 的上限（不含）：第一个非零段进一，其后归零。0.0.z 锁补丁号、0.y.z 锁次版本号 */
export function caretCeiling(floor: string): string {
  const [major = 0, minor = 0, patch = 0] = floor.split('.').map((one) => Number.parseInt(one, 10) || 0)
  if (major > 0) return `${String(major + 1)}.0.0`
  if (minor > 0) return `0.${String(minor + 1)}.0`
  return `0.0.${String(patch + 1)}`
}

/** 正式号 `version` 落不落在 `^<floor>` 里。带预发布段的号一概不算（semver 不拿预发布号满足不带预发布的范围） */
export function inCaret(floor: string, version: string): boolean {
  if (version.includes('-')) return false
  return compareVersions(version, floor) >= 0 && compareVersions(version, caretCeiling(floor)) < 0
}

/** 一条 @godcreator dev 依赖的问题；没问题回 undefined */
function devDependencyIssue(range: string, registryInfo: RegistryInfo): { kind: FindingKind; detail: string } | undefined {
  // 精确号就是验过的下限，^ 范围取它的下限
  const testedFloor = EXACT.test(range) ? range : caretFloor(range)
  if (testedFloor === undefined) {
    return { kind: 'loose-dev-pin', detail: `dev 版本既不是精确号也不是 ^ 范围：${range}` }
  }
  if (registryInfo.versions.length === 0) {
    return { kind: 'dead-pin', detail: `钉 ${testedFloor}，源上没有这个包——装必炸` }
  }
  if (!registryInfo.versions.includes(testedFloor)) {
    return { kind: 'dead-pin', detail: `钉 ${testedFloor}，源上只有 ${registryInfo.versions.join('、')}——装必炸` }
  }
  if (registryInfo.latest === undefined || compareVersions(testedFloor, registryInfo.latest) >= 0) return undefined
  if (inCaret(testedFloor, registryInfo.latest)) {
    return { kind: 'behind', detail: `钉 ${testedFloor}，源上最新 ${registryInfo.latest}，还在 ^${testedFloor} 范围内——无需动作，对上游 semver 的信任就是范围声明的含义` }
  }
  return { kind: 'out-of-range', detail: `钉 ${testedFloor}，源上最新 ${registryInfo.latest} 已出 ^${testedFloor} 范围——上游出了破坏版，必须追：先适配代码，再把 dev 升上去` }
}

function peerNotCordisDetail(pkg: string, range: string): string {
  return (
    `peer 写了 ${pkg}（"${range}"）：peer 只写宿主提供、node 侧产物里按值 import 的 cordis。按「运行时谁提供」改写——` +
    `另一个插件、接口定义包、importmap 里的包、运行时自己用的库、构建时才用的包写 dev；打包不进产物的自用库写 dependencies 并写明原因。` +
    `下次发版时 devkit.release 会拒`
  )
}

/** 源上没有这个包时写什么版本都算 dead-pin；落后时范围是 `^<dev 下限>`，还在范围内是 behind，出了范围是 out-of-range */
export function auditManifest(
  repo: string,
  manifest: string,
  deps: ManifestDeps,
  registry: Record<string, RegistryInfo>,
): Finding[] {
  const findings: Finding[] = []
  const report = (kind: FindingKind, pkg: string, detail: string): void => {
    findings.push({ kind, repo, manifest, pkg, detail })
  }

  for (const [pkg, range] of Object.entries(deps.devs)) {
    const registryInfo = registry[pkg]
    if (registryInfo === undefined) continue
    if (range === 'workspace:*') continue // 同仓包走本地解析，源上本来就没有
    const issue = devDependencyIssue(range, registryInfo)
    if (issue !== undefined) report(issue.kind, pkg, issue.detail)
  }

  if (deps.private || !deps.plugin) return findings

  for (const [pkg, range] of Object.entries(deps.peers)) {
    if (pkg === 'cordis') continue
    report('peer-not-cordis', pkg, peerNotCordisDetail(pkg, range))
  }
  return findings
}

/** 各种 finding 的条数，回执末尾用 */
export function countByKind(findings: Finding[]): Record<FindingKind, number> {
  const counts: Record<FindingKind, number> = {
    'dead-pin': 0,
    behind: 0,
    'out-of-range': 0,
    'loose-dev-pin': 0,
    'peer-not-cordis': 0,
  }
  for (const finding of findings) counts[finding.kind] += 1
  return counts
}
