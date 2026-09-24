import fs from 'node:fs'
import path from 'node:path'
import { unitRetired, unitTest, type ManifestDeps, type RegistryInfo } from './audit.js'
import { isPluginManifest } from './release.js'

// 扫容器根找仓、读各仓的 package.json、向 registry 问现值，都是读磁盘与联网，没有单元测试；判定在 audit.ts

/** 人工排除的包：fresh-eyes 验收用的样例插件，版本跟着模板走，不算进对账 */
const PKG_EXEMPT = new Set(['@godcreator/gwb-hello'])

/** 单元的出生证 */
const UNIT_JSON = 'unit.json'

/** 仓在单元根或单元根下一层。退役单元与测试用的单元整个跳过，名字分别收进 `retired` 与 `testUnits` */
export function collectRepos(root: string): { repos: string[]; retired: string[]; testUnits: string[] } {
  const repos: string[] = []
  const retired: string[] = []
  const testUnits: string[] = []
  for (const unit of sortedEntries(root)) {
    if (!unit.isDirectory()) continue
    const birth = readText(path.join(unit.full, UNIT_JSON))
    if (unitRetired(birth)) {
      retired.push(unit.name)
      continue
    }
    if (unitTest(birth)) {
      testUnits.push(unit.name)
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
  return { repos, retired, testUnits }
}

/** 仓根、各包目录与 docs-site 的 package.json，带 @godcreator 的 dev 依赖或任何 peer 的才收 */
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
    const deps = extractDeps(parsed, path.dirname(path.join(repoDir, rel)))
    if (deps === undefined) continue
    out.push({ rel: rel === 'package.json' ? '.' : path.dirname(rel), deps })
  }
  return out
}

/** 挑出 dev 里的 @godcreator 条目与全部 peer，peer 里哪些是插件从包目录 node_modules 里装着的清单看；两样都没有回 undefined（这份不查） */
function extractDeps(pkg: Record<string, unknown>, packageDir: string): ManifestDeps | undefined {
  const pick = (key: string, keep: (name: string) => boolean): Record<string, string> => {
    const src = pkg[key]
    if (typeof src !== 'object' || src === null) return {}
    const out: Record<string, string> = {}
    for (const [name, range] of Object.entries(src as Record<string, unknown>)) {
      if (keep(name) && !PKG_EXEMPT.has(name) && typeof range === 'string') out[name] = range
    }
    return out
  }
  const peers = pick('peerDependencies', () => true)
  const devs = pick('devDependencies', (name) => name.startsWith('@godcreator/'))
  const plugin = Array.isArray(pkg.keywords) && pkg.keywords.includes('gwb-plugin')
  const peerPlugins = Object.keys(peers).filter((name) => isPluginManifest(readInstalledManifest(packageDir, name)))
  return Object.keys(peers).length + Object.keys(devs).length > 0 ? { peers, devs, private: pkg.private === true, plugin, peerPlugins } : undefined
}

/** 包目录 node_modules 里装着的某个包的清单；没装、认不出回 undefined */
function readInstalledManifest(packageDir: string, name: string): unknown {
  const text = readText(path.join(packageDir, 'node_modules', ...name.split('/'), 'package.json'))
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** packument 的 versions 键是全部版本号，dist-tags.latest 是最新正式版；404 是源上没这个包 */
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
