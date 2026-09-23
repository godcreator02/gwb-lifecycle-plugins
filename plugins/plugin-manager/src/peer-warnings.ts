/**
 * home 里 peer 对不上的那几处，从 `pnpm peers check --json` 读成回执里的 `peerWarnings`——零 I/O
 * 纯逻辑。真去跑 pnpm 的那半在 `pnpm.ts`。
 *
 * 本件调 pnpm 不带任何 peer 参数，pnpm 默认不严格：peer 对不上时 `pnpm add` 照装、退出码 0，
 * stdout 上只有一句 `[WARN] Issues with peer dependencies found`、不列是哪几处。所以装完另跑一趟
 * `pnpm peers check --json`（有问题时退出码 1，没问题时 0，两种都在 stdout 上给同一形状的 JSON），
 * 把它说的逐条带进回执。它查的是 home 整棵树：本来就有的冲突也在里头，不只这一趟新加的。
 */

/** 一处 peer 对不上 */
export interface PeerWarning {
  /** 对不上的那个 peer 包 */
  peer: string
  /** home 里装着的那一版；`missing`（压根没装上）时没有这一格 */
  installed?: string
  /** 要它的那个包写的范围 */
  wanted: string
  /** 要它的那个包，`名@版本`；隔着几层时从 home 的直接依赖一路写到它，` > ` 相连 */
  by: string
}

/**
 * 读 `pnpm peers check --json` 的 stdout。认不出来（不是 JSON、形状不对）回 undefined，
 * 没有问题回空数组。
 *
 * 形状是「项目路径 → { bad, missing, conflicts, intersections }」，home 只有一个项目 `.`。
 * `bad` 与 `missing` 都是「peer 包名 → 条目数组」，每条 `{ parents: [{ name, version }], wantedRange,
 * foundVersion?, optional }`。`missing` 里 `optional` 的不算问题（可选 peer 本来就可以不装）。
 */
export function parsePeerCheck(stdout: string): PeerWarning[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isObject(parsed)) return undefined

  const warnings: PeerWarning[] = []
  for (const project of Object.values(parsed)) {
    if (!isObject(project)) return undefined
    const bad = issuesOf(project['bad'], false)
    const missing = issuesOf(project['missing'], true)
    if (bad === undefined || missing === undefined) return undefined
    warnings.push(...bad, ...missing)
  }
  return warnings
}

/** 一格 `bad` / `missing`。没有这一格当空；形状不对回 undefined */
function issuesOf(section: unknown, missing: boolean): PeerWarning[] | undefined {
  if (section === undefined) return []
  if (!isObject(section)) return undefined
  const out: PeerWarning[] = []
  for (const [peer, list] of Object.entries(section)) {
    if (!Array.isArray(list)) return undefined
    for (const item of list) {
      if (!isObject(item) || typeof item['wantedRange'] !== 'string') return undefined
      if (missing && item['optional'] === true) continue
      const warning: PeerWarning = { peer, wanted: item['wantedRange'], by: chainOf(item['parents']) }
      const found = item['foundVersion']
      out.push(!missing && typeof found === 'string' ? { peer, installed: found, wanted: warning.wanted, by: warning.by } : warning)
    }
  }
  return out
}

function chainOf(parents: unknown): string {
  if (!Array.isArray(parents)) return ''
  return parents
    .filter(isObject)
    .map((p) => (typeof p['version'] === 'string' ? `${String(p['name'])}@${p['version']}` : String(p['name'])))
    .join(' > ')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
