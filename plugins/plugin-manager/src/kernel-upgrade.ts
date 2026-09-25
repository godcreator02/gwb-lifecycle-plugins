import { KERNEL_PACKAGE, isExactVersion, kernelCompatStatusOf, type KernelCompatStatus } from './kernel-compat.js'
import { PLUGIN_KEYWORD } from './search.js'
import { isRecord } from './vocab.js'

// 零 I/O 纯逻辑：这个文件里不 import node:fs

export const CORDIS_PACKAGE = 'cordis'

/** 版本由内核决定、`all` / `only` 不动的包：内核包经 `update` 的 specs 换（主进程里的内核热替换不了），home 根上的 cordis 必须等于内核包 peer 里写的版本、由插件管理自己对齐 */
export const KERNEL_MANAGED_PACKAGES: ReadonlySet<string> = new Set([KERNEL_PACKAGE, CORDIS_PACKAGE])

/** 升级回执里一个包的新旧版本。装之前 home 里没有这个包时没有 `from` */
export interface VersionChange {
  from?: string
  to: string
}

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
 * pnpm 退出码 0 不等于装上了要的版本：home 的 package.json 里这个包原来写成 `^x.y.z` 时，pnpm 12 沿用 `^`，
 * 点名的版本号与 `--save-exact` 都拦不住它装上范围内更新的预发布版。对上了回 undefined，对不上回一句说明
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

/**
 * `list` 回执里一个包的内核兼容字段。只有插件要声明兼容哪个内核：keywords 里没有 gwb-plugin 的包（库、词汇表包、第三方 cordis 插件）、
 * 清单读不到的包、内核包与 cordis 自己一律不标
 */
export function kernelStatusInList(pkg: string, manifest: unknown, kernelVersion: string): KernelCompatStatus {
  if (KERNEL_MANAGED_PACKAGES.has(pkg) || !isPluginManifest(manifest)) return { kernelUntested: false }
  return kernelCompatStatusOf(manifest, kernelVersion)
}

/**
 * home 里的包清单（包名 → 清单，没装的是 undefined）→ 拿 `kernelVersion` 算 `list` 回执时 `kernelUntested` 为真的包，按包名排：
 * 与 `list` 用同一个判断，没写范围的插件也算
 */
export function pluginsOutsideKernelRange(manifestsByPackage: ReadonlyMap<string, unknown>, kernelVersion: string): string[] {
  const outside: string[] = []
  for (const [pkg, manifest] of manifestsByPackage) {
    if (kernelStatusInList(pkg, manifest, kernelVersion).kernelUntested) outside.push(pkg)
  }
  return outside.sort((a, b) => a.localeCompare(b))
}
