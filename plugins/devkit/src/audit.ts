/**
 * 依赖对账的纯机：一份 package.json 的 @godcreator 声明对 registry 现值，出判定。
 * 不碰盘、不碰网——扫仓与问源在 `node-audit-deps.ts`，这层可单测。
 *
 * 判据的立场先说死：这个生态承诺的兼容形态只有「全家一起最新」（peer 单份、update-all
 * 一律拉最新、gitea 只保证往后有历史），所以**不审「兼容多老」，只审三样账**：
 *
 * - 声明装得来（死钉：钉了源上没有的版本——迁移只搬了各包最新号，这类谎最容易犯）
 * - 火车债（dev 钉落后源上的正式最新）：还在 `^<dev 钉>` 范围内是 `behind`，等各自下次发版；
 *   最新已出范围是 `out-of-range`，上游出了破坏版，必须追
 * - 声明 ≠ 验证过的世界（peer 写 `^<dev 钉>`：写法不是 `^` 记 `peer-not-caret`，下限与 dev 钉
 *   不同步记 `floor-mismatch`）
 *
 * 三样账各有各的对象：
 *
 * - **「最新」是 `dist-tags.latest`**，不是版本表里号最大的那个——`devkit.dev` 发的开发版
 *   （`<patch+1>-dev.<戳>`，标 dev）号比正式版大，却不是谁该上的车
 * - **peer 下限只对发布的清单有意义**。下限是写给装这个包的人看的；`private: true` 的清单
 *   （仓根 workspace、文档站、不再发版的件）没人装，下限写什么都不进任何 home，
 *   判它是噪音。它的 dev 钉照审：dev 钉决定这个仓自己装不装得上、验的是不是最新
 * - **退役单元整个不扫**。它的仓只作参考、不再发版也不再装，钉版烂着是预期
 */

/** 一份 package.json 里审得到的那部分 */
export interface ManifestDeps {
  /** peerDependencies 里的 @godcreator 条目 */
  peers: Record<string, string>
  /** devDependencies 里的 @godcreator 条目 */
  devs: Record<string, string>
  /** `private: true`：不发布，peer 下限那一档不审 */
  private: boolean
}

/** 一个包在 registry 上的现值 */
export interface RegistryInfo {
  /** 全部版本号。空表＝源上没这个包 */
  versions: string[]
  /** `dist-tags.latest`。没有＝这个包还没发过正式版（只有开发版） */
  latest?: string
}

export type FindingKind =
  | 'dead-pin'
  | 'behind'
  | 'out-of-range'
  | 'peer-not-caret'
  | 'floor-unverifiable'
  | 'floor-mismatch'
  | 'floor-no-mirror'
  | 'loose-dev-pin'

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

/** 单元的出生证（unit.json 原文）说它退役了没有。读不到、认不出都当没退役——宁可多扫 */
export function unitRetired(text: string | undefined): boolean {
  if (text === undefined) return false
  try {
    const doc = JSON.parse(text) as unknown
    return typeof doc === 'object' && doc !== null && (doc as Record<string, unknown>).status === 'retired'
  } catch {
    return false
  }
}

const EXACT = /^\d+\.\d+\.\d+$/
const CARET = /^\^(\d+\.\d+\.\d+)$/
const GTE = /^>=(\d+\.\d+\.\d+)$/

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
 *
 * 落后分两类，范围是 `^<dev 钉>`（规矩里 peer 就写它）：最新还在范围内是 `behind`（提示，
 * 等各自下次发版），出了范围是 `out-of-range`（待办，先适配再抬）。只有 peer、没有 dev 钉的，
 * 拿 peer 的 `^` 范围判出没出。
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
    if (!EXACT.test(raw)) {
      push('loose-dev-pin', pkg, `dev 钉版不是精确号：${raw}（约好钉死，火车才好对账）`)
      continue
    }
    if (info.versions.length === 0) {
      push('dead-pin', pkg, `钉 ${raw}，源上没有这个包——装必炸`)
      continue
    }
    if (!info.versions.includes(raw)) {
      push('dead-pin', pkg, `钉 ${raw}，源上只有 ${info.versions.join('、')}——装必炸`)
      continue
    }
    if (info.latest !== undefined && compareVersions(raw, info.latest) < 0) {
      if (inCaret(raw, info.latest)) {
        push('behind', pkg, `钉 ${raw}，源上最新 ${info.latest}，还在 ^${raw} 范围内——火车债，下次发版时跟上`)
      } else {
        push('out-of-range', pkg, `钉 ${raw}，源上最新 ${info.latest} 已出 ^${raw} 范围——上游出了破坏版，必须追：先适配代码，dev 钉与 peer 一起抬`)
      }
    }
  }

  if (deps.private) return out

  for (const [pkg, raw] of Object.entries(deps.peers)) {
    const info = registry[pkg]
    if (info === undefined) continue
    const dev = deps.devs[pkg]
    const devExact = dev !== undefined && EXACT.test(dev) ? dev : undefined
    const caret = caretFloor(raw)
    const floor = caret ?? GTE.exec(raw.trim())?.[1]
    if (caret === undefined) {
      const want = devExact ?? floor
      push('peer-not-caret', pkg, `peer 写的是 "${raw}"，规矩是 ^<dev 钉>${want === undefined ? '' : `：改成 "^${want}"`}（迁移欠账，下次发版时 devkit.release 检票会拒）`)
    }
    // 认不出下限的写法到此为止；`>=x.y.z` 的下限照样往下审
    if (floor === undefined) continue
    if (info.versions.length === 0 || !info.versions.includes(floor)) {
      push('floor-unverifiable', pkg, `下限 ${floor}（${raw}），源上没有这个版本——声明了一个装不进来、无法验证的世界`)
      continue
    }
    if (dev === undefined) {
      push('floor-no-mirror', pkg, `peer 有声明、dev 没钉镜像——这个面从没在本仓验证过`)
      if (caret !== undefined && info.latest !== undefined && !inCaret(caret, info.latest)) {
        push('out-of-range', pkg, `peer ${raw}，源上最新 ${info.latest} 已出范围——上游出了破坏版，必须追`)
      }
    } else if (devExact !== undefined && devExact !== floor) {
      push('floor-mismatch', pkg, `下限 ${floor}（${raw}）≠ dev 钉 ${devExact}（规矩：下限＝验证过的世界）`)
    }
  }
  return out
}

/** kinds 的计数汇总，回执尾巴用 */
export function countByKind(findings: Finding[]): Record<FindingKind, number> {
  const counts = {
    'dead-pin': 0,
    behind: 0,
    'out-of-range': 0,
    'peer-not-caret': 0,
    'floor-unverifiable': 0,
    'floor-mismatch': 0,
    'floor-no-mirror': 0,
    'loose-dev-pin': 0,
  } as Record<FindingKind, number>
  for (const f of findings) counts[f.kind] += 1
  return counts
}
