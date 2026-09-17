import fs from 'node:fs'
import path from 'node:path'
import { unitRetired, type ManifestDeps, type RegistryInfo } from './audit.js'

/**
 * `audit.ts` 纯机的环境胶水：扫容器根找仓、读各仓的 package.json、向 registry 问现值。
 * 全是盘与网，不进单测；判定全在纯机里。
 */

/** 一个人工排除的包：样例探针（fresh-eyes / 验收用，钉的版本随模板走，不算生态账） */
const PKG_EXEMPT = new Set(['@godcreator/gwb-hello'])

/** 单元的出生证 */
const UNIT_JSON = 'unit.json'

/**
 * 找一个容器根下面全部 git 仓：单元根或单元根下一层（unit.json + 一层仓目录的习俗）。
 * 出生证 `status` 是 `retired` 的单元整个跳过，名字收进 `retired`。
 */
export function collectRepos(root: string): { repos: string[]; retired: string[] } {
  const repos: string[] = []
  const retired: string[] = []
  for (const unit of sortedEntries(root)) {
    if (!unit.isDirectory()) continue
    if (unitRetired(readText(path.join(unit.full, UNIT_JSON)))) {
      retired.push(unit.name)
      continue
    }
    if (fs.existsSync(path.join(unit.full, '.git'))) {
      repos.push(unit.full)
      continue
    }
    for (const child of sortedEntries(unit.full)) {
      if (child.isDirectory() && fs.existsSync(path.join(child.full, '.git'))) repos.push(child.full)
    }
  }
  return { repos, retired }
}

/** 一个仓里审得到的 manifest：仓根 + 各包目录 + docs-site，凡带 @godcreator 依赖的才收 */
export function collectManifests(repoDir: string): { rel: string; deps: ManifestDeps }[] {
  const candidates = ['package.json']
  for (const group of ['plugins', 'packages', 'apps']) {
    const groupDir = path.join(repoDir, group)
    if (!fs.existsSync(groupDir)) continue
    for (const entry of sortedEntries(groupDir)) {
      if (entry.isDirectory()) candidates.push(path.join(group, entry.name, 'package.json'))
    }
  }
  candidates.push(path.join('docs-site', 'package.json'))
  const out: { rel: string; deps: ManifestDeps }[] = []
  for (const rel of candidates) {
    const text = readText(path.join(repoDir, rel))
    if (text === undefined) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      continue
    }
    const deps = extractDeps(parsed)
    if (deps === undefined) continue
    out.push({ rel: rel === 'package.json' ? '.' : path.dirname(rel), deps })
  }
  return out
}

/** 挑出两档里的 @godcreator 条目；一条都没有返回 undefined（这份 manifest 不入账） */
function extractDeps(pkg: Record<string, unknown>): ManifestDeps | undefined {
  const pick = (key: string): Record<string, string> => {
    const src = pkg[key]
    if (typeof src !== 'object' || src === null) return {}
    const out: Record<string, string> = {}
    for (const [name, range] of Object.entries(src as Record<string, unknown>)) {
      if (name.startsWith('@godcreator/') && !PKG_EXEMPT.has(name) && typeof range === 'string') {
        out[name] = range
      }
    }
    return out
  }
  const peers = pick('peerDependencies')
  const devs = pick('devDependencies')
  return Object.keys(peers).length + Object.keys(devs).length > 0 ? { peers, devs, private: pkg.private === true } : undefined
}

/** 问源：packument 的 versions 键是全部版本号，dist-tags.latest 是正式最新。404＝源上没这个包 */
export async function fetchRegistry(
  pkgs: string[],
  registryBase: string,
): Promise<Record<string, RegistryInfo>> {
  const unique = [...new Set(pkgs)]
  const entries = await Promise.all(
    unique.map(async (pkg) => {
      const url = `${registryBase}${encodeURIComponent(pkg)}`
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (res.status === 404) return [pkg, { versions: [] }] as const
        if (!res.ok) throw new Error(`registry 回了 ${String(res.status)}`)
        const doc = JSON.parse(await res.text()) as { versions?: Record<string, unknown>; 'dist-tags'?: Record<string, unknown> }
        const versions = Object.keys(doc.versions ?? {})
        const latest = doc['dist-tags']?.latest
        return [pkg, { versions, ...(typeof latest === 'string' ? { latest } : {}) }] as const
      } catch (err) {
        throw new Error(`问不到 ${pkg}（${url}）：${String(err)}`)
      }
    }),
  )
  return Object.fromEntries(entries)
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function sortedEntries(dir: string): { name: string; full: string; isDirectory(): boolean }[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== 'node_modules' && e.name !== '.next' && !e.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((e) => ({ name: e.name, full: path.join(dir, e.name), isDirectory: () => e.isDirectory() }))
}
