/**
 * `pnpm outdated --json` 的 stdout → 包 → 版本差距。纯函数，单独测。
 *
 * 形状（pnpm 12.4 实测）：有过期包时退出码 1，stdout 是按包名做键的一份 JSON，
 * 每条 `{ current, latest, wanted, isDeprecated, dependencyType }`；全都最新时退出码 0、
 * stdout 为 `{}` 或空。这儿只认用得着的两格，缺了就跳过那条，
 * 整份认不出就回 undefined 让调用方给一句人话。
 */

/** 一个包的版本差距 */
export interface UpdateInfo {
  /** home 里装着的版本 */
  current: string
  /** registry 上的最新版 */
  latest: string
}

/** 包名 → 版本差距。空对象 = 全都最新 */
export type OutdatedMap = Record<string, UpdateInfo>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function version(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析 outdated 的 stdout。**不抛**：
 * - 空串（退出码 0 那一路）→ 空表
 * - 不是一份 JSON 对象（pnpm 炸了、版本形状变了）→ undefined，调用方给一句人话
 * - 单条缺 `current` 或 `latest`、或者根本不是对象 → 只跳过那一条
 */
export function parseOutdated(text: string): OutdatedMap | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const out: OutdatedMap = {}
  for (const [pkg, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue
    const current = version(entry['current'])
    const latest = version(entry['latest'])
    if (current === undefined || latest === undefined) continue
    out[pkg] = { current, latest }
  }
  return out
}
