/**
 * 依赖对账的纯机：一份 package.json 的 @godcreator 声明对 registry 现值，出判定。
 * 不碰盘、不碰网——扫仓与问源在 `node-audit-deps.ts`，这层可单测。
 *
 * 判据的立场先说死：这个生态承诺的兼容形态只有「全家一起最新」（peer 单份、update-all
 * 一律拉最新、gitea 只保证往后有历史），所以**不审「兼容多老」，只审三样账**：
 *
 * - 声明装得来（死钉：钉了源上没有的版本——迁移只搬了各包最新号，这类谎最容易犯）
 * - 火车债（dev 钉落后源上的正式最新——该上车的记账，不是催命符）
 * - 声明 ≠ 验证过的世界（下限与 dev 钉不同步；规矩是 floor = dev 钉）
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
const FLOOR = /^>=(\d+\.\d+\.\d+)$/

/**
 * 一份 manifest 的判定。versions 空表（源上没这个包）时，钉了什么都是死钉。
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
      push('behind', pkg, `钉 ${raw}，源上最新 ${info.latest}——火车债`)
    }
  }

  if (deps.private) return out

  for (const [pkg, raw] of Object.entries(deps.peers)) {
    const info = registry[pkg]
    if (info === undefined) continue
    const floor = FLOOR.exec(raw)?.[1]
    if (floor === undefined) {
      push('floor-unverifiable', pkg, `下限写法认不出：${raw}（约好 ">=x.y.z" 精确下限）`)
      continue
    }
    if (info.versions.length === 0 || !info.versions.includes(floor)) {
      push('floor-unverifiable', pkg, `下限 >=${floor}，源上没有这个版本——声明了一个装不进来、无法验证的世界`)
      continue
    }
    const dev = deps.devs[pkg]
    if (dev === undefined) {
      push('floor-no-mirror', pkg, `peer 有声明、dev 没钉镜像——这个面从没在本仓验证过`)
    } else if (EXACT.test(dev) && dev !== floor) {
      push('floor-mismatch', pkg, `下限 >=${floor} ≠ dev 钉 ${dev}（规矩：floor ＝验证过的世界）`)
    }
  }
  return out
}

/** kinds 的计数汇总，回执尾巴用 */
export function countByKind(findings: Finding[]): Record<FindingKind, number> {
  const counts = {
    'dead-pin': 0,
    behind: 0,
    'floor-unverifiable': 0,
    'floor-mismatch': 0,
    'floor-no-mirror': 0,
    'loose-dev-pin': 0,
  } as Record<FindingKind, number>
  for (const f of findings) counts[f.kind] += 1
  return counts
}
