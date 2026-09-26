import { KERNEL_PACKAGE, isExactVersion } from './kernel-compat.js'
import type { VersionChange } from './receipts.js'
import { PLUGIN_KEYWORD } from './search.js'
import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑：这个文件里不 import node:fs

export const CORDIS_PACKAGE = 'cordis'

/** 版本由内核决定、`all` / `only` 不动的包：内核包经 `update` 的 specs 换（主进程里的内核热替换不了），home 根上的 cordis 必须等于内核包 peer 里写的版本、由插件管理自己对齐 */
export const KERNEL_MANAGED_PACKAGES: ReadonlySet<string> = new Set([KERNEL_PACKAGE, CORDIS_PACKAGE])

export function versionChangeOf(from: string | undefined, to: string): VersionChange {
  return from === undefined ? { to } : { from, to }
}

export type KernelUpgradeTarget = { ok: true; kernelVersion: string; cordisVersion: string } | { ok: false; error: string }

/** 刚装进 home 的内核包清单 → 它的版本号与它 peer 里要的 cordis 版本号；cordis 必须写成精确版本号，home 根上装的就是这一个 */
export function kernelUpgradeTargetOf(kernelManifest: unknown): KernelUpgradeTarget {
  if (!isRecord(kernelManifest)) return { ok: false, error: `home 的 node_modules 里读不到 ${KERNEL_PACKAGE} 的 package.json` }
  const kernelVersion = kernelManifest['version']
  if (typeof kernelVersion !== 'string' || !isExactVersion(kernelVersion)) {
    return { ok: false, error: `${KERNEL_PACKAGE} 的 version 不是合法的版本号：${JSON.stringify(kernelVersion)}` }
  }
  const peers = kernelManifest['peerDependencies']
  const cordisVersion = isRecord(peers) ? peers[CORDIS_PACKAGE] : undefined
  if (typeof cordisVersion !== 'string' || !isExactVersion(cordisVersion)) {
    return {
      ok: false,
      error: `${KERNEL_PACKAGE}@${kernelVersion} 的 peerDependencies.cordis 要写成精确版本号（如 4.0.0-rc.9），实际是 ${JSON.stringify(cordisVersion)}`,
    }
  }
  return { ok: true, kernelVersion, cordisVersion }
}

/**
 * pnpm 退出码 0 不等于装上了要的版本：home 的 package.json 里这个包写成 `^x.y.z` 时，pnpm 12 沿用 `^`，
 * 点名的版本号与 `--save-exact` 都拦不住它留着范围内更新的版本（往回退版本、范围里有预发布版时撞上）。对上了回 undefined，对不上回一句说明
 */
export function installedVersionMismatch(pkg: string, expected: string, installed: string | undefined): string | undefined {
  if (installed === expected) return undefined
  return (
    `pnpm 装完 home 里的 ${pkg} 是 ${installed ?? '（读不到）'}，要的是 ${expected}：` +
    `多半是 home 的 package.json 里它写成了 ^ 范围，把它改成精确版本号 ${expected} 再运行一次`
  )
}

/** 是不是插件只看包清单 keywords 里有没有 gwb-plugin */
export function isPluginManifest(manifest: unknown): boolean {
  if (!isRecord(manifest)) return false
  const keywords = manifest['keywords']
  return Array.isArray(keywords) && keywords.includes(PLUGIN_KEYWORD)
}
