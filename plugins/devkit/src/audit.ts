/**
 * 依赖对账，纯函数：一份 package.json 的依赖声明对照源上的现值，给出判定。
 * 不读盘、不联网——扫仓与问源在 `node-audit-deps.ts`。
 *
 * 只报两类：
 *
 * - `@godcreator` 的 dev 依赖：写了源上没有的版本（`dead-pin`）；落后源上的 `dist-tags.latest`，
 *   还在 `^<dev 下限>` 范围内是 `behind`（提示），已出范围是 `out-of-range`（必须跟进）；
 *   写法认不出下限（`loose-dev-pin`）
 * - 插件包的 peer 里有 `cordis` 以外的包（`peer-not-cordis`）：peer 只写宿主提供的 `cordis`
 *
 * 「最新」是 `dist-tags.latest`，不是版本表里号最大的那个：`devkit.dev` 发的开发版号比正式版大。
 * `private: true` 的清单（仓根 workspace、文档站）不发布，只查 dev；退役单元整个不扫。
 */

/** 一份 package.json 里审得到的那部分 */
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
  /** `dist-tags.latest`。没有＝这个包还没发过正式版（只有开发版） */
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

/**
 * 语义化比较：主版本三段逐段数字比（0.10.0 得大于 0.9.9——字符串比会翻车），三段相同时带
 * 预发布段的小于不带的（0.2.1-dev.x < 0.2.1），两个预发布段按点分段比，数字段按数字。
 * 认不出的号三段当 0。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] } => {
    const m = CORE.exec(v)
    if (m === null) {
      const parts = v.split('.')
      return {
        core: [0, 1, 2].map((i) => {
          const n = Number.parseInt(parts[i] ?? '0', 10)
          return Number.isNaN(n) ? 0 : n
        }),
        pre: [],
      }
    }
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = pa.core[i] ?? 0
    const y = pb.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
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

/** 出生证 `kind` 是「测试件」的单元（测试用途的示范件）：与退役同等处理——整个不扫，名字单列一档 */
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

/**
 * 一份 manifest 的判定。versions 空表（源上没这个包）时，钉了什么都是死钉。
 * 落后分两类，范围是 `^<dev 下限>`：最新还在范围内是 `behind`，出了范围是 `out-of-range`。
 */
export function auditManifest(
  repo: string,
  manifest: string,
  deps: ManifestDeps,
  registry: Record<string, RegistryInfo>,
): Finding[] {
  const out: Finding[] = []
  const push = (kind: FindingKind, pkg: string, detail: string): void => {
    out.push({ kind, repo, manifest, pkg, detail })
  }

  for (const [pkg, raw] of Object.entries(deps.devs)) {
    const info = registry[pkg]
    if (info === undefined) continue
    if (raw === 'workspace:*') continue // 同仓包走本地解析，源上本来就没有
    /** dev 的「验过下限」：精确号取自身，^ 范围取其下限 */
    const pin = EXACT.test(raw) ? raw : caretFloor(raw)
    if (pin === undefined) {
      push('loose-dev-pin', pkg, `dev 版本既不是精确号也不是 ^ 范围：${raw}`)
      continue
    }
    if (info.versions.length === 0) {
      push('dead-pin', pkg, `钉 ${pin}，源上没有这个包——装必炸`)
      continue
    }
    if (!info.versions.includes(pin)) {
      push('dead-pin', pkg, `钉 ${pin}，源上只有 ${info.versions.join('、')}——装必炸`)
      continue
    }
    if (info.latest !== undefined && compareVersions(pin, info.latest) < 0) {
      if (inCaret(pin, info.latest)) {
        push('behind', pkg, `钉 ${pin}，源上最新 ${info.latest}，还在 ^${pin} 范围内——无需动作，对上游 semver 的信任就是范围声明的含义`)
      } else {
        push('out-of-range', pkg, `钉 ${pin}，源上最新 ${info.latest} 已出 ^${pin} 范围——上游出了破坏版，必须追：先适配代码，再把 dev 升上去`)
      }
    }
  }

  if (deps.private || !deps.plugin) return out

  for (const [pkg, raw] of Object.entries(deps.peers)) {
    if (pkg === 'cordis') continue
    push(
      'peer-not-cordis',
      pkg,
      `peer 写了 ${pkg}（"${raw}"）：peer 只写宿主提供、node 侧产物里按值 import 的 cordis。按「运行时谁提供」改写——` +
        `另一个插件、接口定义包、importmap 里的包、运行时自己用的库、构建时才用的包写 dev；打包不进产物的自用库写 dependencies 并写明原因。` +
        `下次发版时 devkit.release 会拒`,
    )
  }
  return out
}

/** kinds 的计数汇总，回执尾巴用 */
export function countByKind(findings: Finding[]): Record<FindingKind, number> {
  const counts: Record<FindingKind, number> = {
    'dead-pin': 0,
    behind: 0,
    'out-of-range': 0,
    'loose-dev-pin': 0,
    'peer-not-cordis': 0,
  }
  for (const f of findings) counts[f.kind] += 1
  return counts
}
