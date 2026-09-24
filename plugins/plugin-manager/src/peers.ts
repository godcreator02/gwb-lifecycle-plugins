import { isPluginManifest, KERNEL_MANAGED_PACKAGES } from './kernel-upgrade.js'
import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑：这个文件里不 import node:fs

const CARET_RANGE = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 插件 peer 里写的一个别的包（内核包与 cordis 不算） */
export interface DeclaredPeer {
  pkg: string
  /** peerDependencies 里写的范围，原样照抄 */
  range: string
  /** peerDependenciesMeta 里标了 `optional: true` */
  optional: boolean
}

/** 一条没满足的 peer */
export interface UnmetPeer {
  pkg: string
  /** peerDependencies 里写的范围，原样照抄；不是 `^x.y.z` 也照抄，并算作没满足 */
  range: string
  /** home 里装着的版本号；没装时没有这个字段 */
  installed?: string
}

/** 一个包在 `list` 回执里和 peer 有关的字段 */
export interface PeerStatus {
  /**
   * 插件（keywords 含 gwb-plugin）peer 里除了内核包与 cordis 之外、home 里没满足的包：没装（可选的 peer 没装不算）、
   * 或装着的版本不在范围里。每个包都有这个字段，不是插件的包、清单读不到的包、全都满足时是空数组
   */
  unmetPeers: UnmetPeer[]
}

/**
 * `^x.y.z` 包不包含这个版本：主版本号为 0 时次版本号相同，≥1 时主版本号相同，并且不低于 x.y.z。只比 x.y.z 三段，
 * 预发布段不看。规则与 `kernel-compat.ts` 的 `kernelRangeCovers` 相同；范围不是 `^x.y.z`、版本号不合法都是 false
 */
export function caretRangeCovers(range: string, version: string): boolean {
  const rangeMatch = CARET_RANGE.exec(range)
  const versionMatch = VERSION.exec(version)
  if (rangeMatch === null || versionMatch === null) return false
  const floor = [Number(rangeMatch[1]), Number(rangeMatch[2]), Number(rangeMatch[3])] as const
  const actual = [Number(versionMatch[1]), Number(versionMatch[2]), Number(versionMatch[3])] as const
  const sameLine = floor[0] === 0 ? actual[0] === 0 && actual[1] === floor[1] : actual[0] === floor[0]
  if (!sameLine) return false
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== floor[index]) return actual[index]! > floor[index]!
  }
  return true
}

function isOptionalPeer(manifest: Record<string, unknown>, pkg: string): boolean {
  const meta = manifest['peerDependenciesMeta']
  if (!isRecord(meta)) return false
  const peerMeta = meta[pkg]
  return isRecord(peerMeta) && peerMeta['optional'] === true
}

/**
 * 插件包清单 → peer 里除了内核包与 cordis 之外的包，按清单里的先后。不是插件（keywords 没有 gwb-plugin）、
 * 清单读不到的一律空数组；范围不是字符串的那一项跳过（pnpm 装不上这样的包）
 */
export function declaredPluginPeers(manifest: unknown): DeclaredPeer[] {
  if (!isRecord(manifest) || !isPluginManifest(manifest)) return []
  const peers = manifest['peerDependencies']
  if (!isRecord(peers)) return []
  const declared: DeclaredPeer[] = []
  for (const [pkg, range] of Object.entries(peers)) {
    if (KERNEL_MANAGED_PACKAGES.has(pkg) || typeof range !== 'string') continue
    declared.push({ pkg, range, optional: isOptionalPeer(manifest, pkg) })
  }
  return declared
}

/** 包清单（读不到时是 undefined）→ `list` 回执里的 `unmetPeers`。`installedVersions` 里没有的包算没装 */
export function peerStatusOf(manifest: unknown, installedVersions: ReadonlyMap<string, string>): PeerStatus {
  const unmetPeers: UnmetPeer[] = []
  for (const peer of declaredPluginPeers(manifest)) {
    const installed = installedVersions.get(peer.pkg)
    if (installed === undefined) {
      if (!peer.optional) unmetPeers.push({ pkg: peer.pkg, range: peer.range })
    } else if (!caretRangeCovers(peer.range, installed)) {
      unmetPeers.push({ pkg: peer.pkg, range: peer.range, installed })
    }
  }
  return { unmetPeers }
}
