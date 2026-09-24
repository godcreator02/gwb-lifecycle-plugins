/**
 * `pnpm outdated --json` 的输出（pnpm 12.4 实测）：有过期包时退出码 1，stdout 是按包名作键的 JSON，
 * 每条 `{ current, latest, wanted, isDeprecated, dependencyType }`；全都最新时退出码 0，stdout 是 `{}` 或空
 */

export interface UpdateInfo {
  /** home 里装着的版本 */
  current: string
  /** registry 上的最新版 */
  latest: string
}

/** 包名 → 版本差距。空对象是全都最新 */
export type OutdatedMap = Record<string, UpdateInfo>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 空串回空表；整份不是 JSON 对象回 undefined；单条缺 `current` / `latest` 或不是对象只跳过那一条 */
export function parseOutdated(text: string): OutdatedMap | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const gapsByPackage: OutdatedMap = {}
  for (const [pkg, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) continue
    const current = nonEmptyStringOrUndefined(entry['current'])
    const latest = nonEmptyStringOrUndefined(entry['latest'])
    if (current === undefined || latest === undefined) continue
    gapsByPackage[pkg] = { current, latest }
  }
  return gapsByPackage
}
