import type { ServiceProvides } from './services.js'

/** 一个 import 入口：怎么写、类型定义在哪、有没有一句说明 */
export interface ImportEntry {
  /** import 时写的说明符：主入口就是包名，子路径是 `包名/子路径` */
  specifier: string
  /** 类型定义文件（相对 home 的路径），agent 按需读它拿全部导出与文档注释 */
  dts?: string
  provides?: ServiceProvides
}

/** 一个已装包的 import 面 */
export interface ImportFace {
  pkg: string
  version?: string
  /** 身份：件＝插件（keywords 带 gwb-plugin）/ 库（只带 gwb）/ 第三方（都不是）；取值是回执契约 */
  kind: '件' | '库' | '第三方'
  /** importmap 外置名：`gwb.shared` 的键，react 这类经页面 importmap 解析的包名 */
  shared?: string[]
  entries: ImportEntry[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asStrings(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  return undefined
}

/**
 * 与内核读法相同（内核仓 `apps/desktop/src/imports.ts`）：「外置名 → 本包 exports 子路径」的对象，
 * 子路径不是非空字符串的那一项不算。不是对象（没写、写成数组或字符串）时是 undefined
 */
function sharedNamesOf(declared: unknown): string[] | undefined {
  const record = asRecord(declared)
  if (record === undefined) return undefined
  return Object.entries(record)
    .filter(([name, subpath]) => name !== '' && typeof subpath === 'string' && subpath !== '')
    .map(([name]) => name)
}

/** exports 的一个值里的 types 与 default 目标 */
function entryTargets(exportValue: unknown): { types?: string; default?: string } {
  if (typeof exportValue === 'string') return { default: exportValue }
  const record = asRecord(exportValue)
  if (record === undefined) return {}
  const types = typeof record['types'] === 'string' ? record['types'] : undefined
  const defaultTarget = typeof record['default'] === 'string' ? record['default'] : undefined
  return { types, default: defaultTarget }
}

function kindOf(keywords: readonly string[]): ImportFace['kind'] {
  return keywords.includes('gwb-plugin') ? '件' : keywords.includes('gwb') ? '库' : '第三方'
}

function importEntryOf(pkg: string, subpath: string, exportValue: unknown, provides: Record<string, unknown> | undefined): ImportEntry {
  const specifier = subpath === '.' ? pkg : `${pkg}/${subpath.slice(2)}`
  const targets = entryTargets(exportValue)
  const dtsFile = targets.types ?? (targets.default?.endsWith('.d.ts') === true ? targets.default : undefined)
  const declared = asRecord(provides?.[specifier])
  const summary = typeof declared?.['summary'] === 'string' ? declared['summary'] : undefined
  const usage = typeof declared?.['usage'] === 'string' ? declared['usage'] : undefined
  return {
    specifier,
    ...(dtsFile === undefined ? {} : { dts: `node_modules/${pkg}/${dtsFile.replace(/^\.\//, '')}` }),
    ...(summary !== undefined && summary !== '' && usage !== undefined && usage !== ''
      ? { provides: { summary, usage } }
      : {}),
  }
}

/** exports 是对象就逐项列（跳过 `./package.json`）；是字符串就是主入口；没有 exports 的旧式包看 main / types */
function importEntriesOf(pkg: string, manifest: Record<string, unknown>, provides: Record<string, unknown> | undefined): ImportEntry[] {
  const entries: ImportEntry[] = []
  const exportsField = manifest['exports']
  const exportsRecord = asRecord(exportsField)
  if (exportsRecord !== undefined) {
    for (const [subpath, exportValue] of Object.entries(exportsRecord)) {
      if (subpath === './package.json') continue
      entries.push(importEntryOf(pkg, subpath, exportValue, provides))
    }
  } else if (typeof exportsField === 'string') {
    entries.push(importEntryOf(pkg, '.', exportsField, provides))
  } else {
    const targets = entryTargets({ types: manifest['types'], default: manifest['main'] })
    if (targets.types !== undefined || targets.default !== undefined) entries.push(importEntryOf(pkg, '.', targets, provides))
  }
  return entries
}

/** 这个包能被 import 的说明符（主入口是包名，子路径是 `包名/子路径`），与 `devkit.capabilities` 列出的入口是同一套 */
export function importSpecifiersOf(pkg: string, manifest: Record<string, unknown>): string[] {
  return importEntriesOf(pkg, manifest, undefined).map((entry) => entry.specifier)
}

/**
 * `deps` 是 home 的 `package.json` 里 `dependencies` 的键；`readManifest` 收包名回那份 `package.json`，
 * 读不到回 undefined，那个包就跳过，不让一个坏包毁掉整份清单
 */
export async function importFacesOf(
  deps: readonly string[],
  readManifest: (pkg: string) => unknown,
): Promise<ImportFace[]> {
  const faces: ImportFace[] = []
  for (const pkg of deps) {
    const manifest = asRecord(await readManifest(pkg))
    if (manifest === undefined) continue
    const kind = kindOf(asStrings(manifest['keywords']) ?? [])
    const provides = asRecord(asRecord(manifest['gwb'])?.['provides'])
    const version = typeof manifest['version'] === 'string' ? manifest['version'] : undefined
    const entries = importEntriesOf(pkg, manifest, provides)
    const shared = sharedNamesOf(asRecord(manifest['gwb'])?.['shared'])
    faces.push({
      pkg,
      ...(version === undefined ? {} : { version }),
      kind,
      ...(shared === undefined ? {} : { shared }),
      entries,
    })
  }
  faces.sort((a, b) => (a.kind === b.kind ? a.pkg.localeCompare(b.pkg) : a.kind.localeCompare(b.kind)))
  return faces
}
