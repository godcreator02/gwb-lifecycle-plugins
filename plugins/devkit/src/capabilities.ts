import type { ServiceProvides } from './services.js'

/**
 * 「开发一个新插件能基于什么」——import 面的聚合：home 里装着的每个包，它是什么身份、
 * 暴露哪些入口、每个入口怎么接（`gwb.provides` 的自述）、类型正本（d.ts）在哪。
 *
 * 事实与意图分工（判据见文档站）：
 *
 * - **事实现算**：入口清单来自 `exports`（回退 `main`），身份来自 `keywords`，importmap
 *   外置名来自 `gwb.shared` 的键，d.ts 路径来自入口的 `types`——一律从那份 `package.json`
 *   现读，不抄进任何声明。抄了就是第二正本，必漂。
 * - **意图声明**：`gwb.provides` 按「你在代码里写下的那个模块说明符」做键——主入口的键
 *   是包名、子路径的键是 `包名/子路径`——值是 `{ summary, usage }`。没声明的入口照样列，
 *   只是带不上一句人话。
 *
 * 符号级（入口里有哪些导出）**不聚合**：把 d.ts 的路径递给 agent，读原文——原文永真，
 * 摘抄必有截断与过期。这与「补全就是说明书」同一条哲学：命令递入口，不做补全本身。
 */

/** 一个 import 入口：怎么写、类型正本在哪、有没有人话自述 */
export interface ImportEntry {
  /** import 时写的说明符：主入口就是包名，子路径是 `包名/子路径` */
  specifier: string
  /** 类型正本（相对 home 的路径），agent 按需 Read 拿全部导出与 doc comment */
  dts?: string
  provides?: ServiceProvides
}

/** 一个已装包的 import 面 */
export interface ImportFace {
  pkg: string
  version?: string
  /** 身份：件（keywords 带 gwb-plugin）/ 库（只带 gwb）/ 第三方（都不是） */
  kind: '件' | '库' | '第三方'
  /** importmap 外置名：`gwb.shared` 的键——react 系经页面 importmap 解析的那种 */
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
 * `gwb.shared` 声明的 importmap 外置名。内核按「外置名 → 本包 exports 子路径」的对象读，子路径不是
 * 非空字符串的那一项不进 importmap（见内核仓 `apps/desktop/src/imports.ts`），这里按同一条规则取键。
 * 不是对象（没写、写成数组或字符串）时是 undefined。
 */
function sharedNamesOf(declared: unknown): string[] | undefined {
  const record = asRecord(declared)
  if (record === undefined) return undefined
  return Object.entries(record)
    .filter(([name, subpath]) => name !== '' && typeof subpath === 'string' && subpath !== '')
    .map(([name]) => name)
}

/** 入口说明（exports 的值）里挑出 types 与 default 的目标 */
function entryTargets(desc: unknown): { types?: string; default?: string } {
  if (typeof desc === 'string') return { default: desc }
  const record = asRecord(desc)
  if (record === undefined) return {}
  const types = typeof record['types'] === 'string' ? record['types'] : undefined
  const def = typeof record['default'] === 'string' ? record['default'] : undefined
  return { types, default: def }
}

/**
 * 把 home 已装包表聚成 import 面。`deps` 是依赖包名全表（home 的 package.json
 * `dependencies` 的键），`readManifest` 收包名回那份 `package.json`（读不到回
 * undefined——那个包就静默跳过，不让一条坏包毁掉整份目录）。
 */
export async function importFacesOf(
  deps: readonly string[],
  readManifest: (pkg: string) => unknown,
): Promise<ImportFace[]> {
  const out: ImportFace[] = []
  for (const pkg of deps) {
    const manifest = asRecord(await readManifest(pkg))
    if (manifest === undefined) continue
    const keywords = asStrings(manifest['keywords']) ?? []
    const kind: ImportFace['kind'] = keywords.includes('gwb-plugin') ? '件' : keywords.includes('gwb') ? '库' : '第三方'
    const provides = asRecord(asRecord(manifest['gwb'])?.['provides'])
    const version = typeof manifest['version'] === 'string' ? manifest['version'] : undefined

    const entries: ImportEntry[] = []
    const pushEntry = (sub: string, desc: unknown): void => {
      const specifier = sub === '.' ? pkg : `${pkg}/${sub.slice(2)}`
      const targets = entryTargets(desc)
      const dtsFile = targets.types ?? (targets.default?.endsWith('.d.ts') === true ? targets.default : undefined)
      const declared = asRecord(provides?.[specifier])
      const summary = typeof declared?.['summary'] === 'string' ? declared['summary'] : undefined
      const usage = typeof declared?.['usage'] === 'string' ? declared['usage'] : undefined
      entries.push({
        specifier,
        ...(dtsFile === undefined ? {} : { dts: `node_modules/${pkg}/${dtsFile.replace(/^\.\//, '')}` }),
        ...(summary !== undefined && summary !== '' && usage !== undefined && usage !== ''
          ? { provides: { summary, usage } }
          : {}),
      })
    }

    const exportsField = manifest['exports']
    const exportsRecord = asRecord(exportsField)
    if (exportsRecord !== undefined) {
      for (const [sub, desc] of Object.entries(exportsRecord)) {
        // ./package.json 是 npm 管道，不是给人 import 的面，不占目录一行
        if (sub === './package.json') continue
        pushEntry(sub, desc)
      }
    } else if (typeof exportsField === 'string') {
      pushEntry('.', exportsField)
    } else {
      // 老式包：main/types 直陈，没有 exports 子路径面
      const targets = entryTargets({ types: manifest['types'], default: manifest['main'] })
      if (targets.types !== undefined || targets.default !== undefined) pushEntry('.', targets)
    }

    const shared = sharedNamesOf(asRecord(manifest['gwb'])?.['shared'])
    out.push({
      pkg,
      ...(version === undefined ? {} : { version }),
      kind,
      ...(shared === undefined ? {} : { shared }),
      entries,
    })
  }
  out.sort((a, b) => (a.kind === b.kind ? a.pkg.localeCompare(b.pkg) : a.kind.localeCompare(b.kind)))
  return out
}
