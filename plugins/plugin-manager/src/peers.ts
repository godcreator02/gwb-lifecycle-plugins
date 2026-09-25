import { caretRangeCovers, KERNEL_PACKAGE, kernelRangeCovers } from './kernel-compat.js'
import { CORDIS_PACKAGE, isPluginManifest } from './kernel-upgrade.js'
import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑：这个文件里不 import node:fs

/** 插件 peer 里写的一个包（cordis 不算，内核包算） */
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
  /** home 里装着的版本号，内核包是正在运行的内核版本；没装时没有这个字段 */
  installed?: string
}

/** 一个包在 `list` 回执里和 peer 有关的字段 */
export interface PeerStatus {
  /**
   * 插件（keywords 含 gwb-plugin）peer 里除了 cordis 之外、没满足的包：没装（可选的 peer 没装不算）、
   * 或版本不在范围里。内核包对照正在运行的内核，别的包对照 home 里装着的版本。
   * 每个包都有这个字段，不是插件的包、清单读不到的包、全都满足时是空数组
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
 * 插件包清单 → peer 里除了 cordis 之外的包（含内核包），按清单里的先后。不是插件（keywords 没有 gwb-plugin）、
 * 清单读不到的一律空数组；范围不是字符串的那一项跳过（pnpm 装不上这样的包）
 */
export function declaredPluginPeers(manifest: unknown): DeclaredPeer[] {
  if (!isRecord(manifest) || !isPluginManifest(manifest)) return []
  const peers = manifest['peerDependencies']
  if (!isRecord(peers)) return []
  const declared: DeclaredPeer[] = []
  for (const [pkg, range] of Object.entries(peers)) {
    if (pkg === CORDIS_PACKAGE || typeof range !== 'string') continue
    declared.push({ pkg, range, optional: isOptionalPeer(manifest, pkg) })
  }
  return declared
}

/**
 * 包清单（读不到时是 undefined）→ `list` 回执里的 `unmetPeers`。内核包拿 `runningKernelVersion` 比（它不合法直接抛错），
 * 别的包拿 `installedVersions` 比，那里没有的算没装
 */
export function peerStatusOf(manifest: unknown, installedVersions: ReadonlyMap<string, string>, runningKernelVersion: string): PeerStatus {
  const unmetPeers: UnmetPeer[] = []
  for (const peer of declaredPluginPeers(manifest)) {
    if (peer.pkg === KERNEL_PACKAGE) {
      if (!kernelRangeCovers(peer.range, runningKernelVersion)) unmetPeers.push({ pkg: peer.pkg, range: peer.range, installed: runningKernelVersion })
      continue
    }
    const installed = installedVersions.get(peer.pkg)
    if (installed === undefined) {
      if (!peer.optional) unmetPeers.push({ pkg: peer.pkg, range: peer.range })
    } else if (!caretRangeCovers(peer.range, installed)) {
      unmetPeers.push({ pkg: peer.pkg, range: peer.range, installed })
    }
  }
  return { unmetPeers }
}
