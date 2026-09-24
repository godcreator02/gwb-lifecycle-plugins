import { caretRangeCovers } from './kernel-compat.js'
import { isPluginManifest, KERNEL_MANAGED_PACKAGES } from './kernel-upgrade.js'
import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑：这个文件里不 import node:fs

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
