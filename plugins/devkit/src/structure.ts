import fs from 'node:fs'
import path from 'node:path'

/**
 * 结构体检：对一个仓（或整个生态）只读地回答「离当前标准形有多远」。
 *
 * 与另外几件验机的分工，**各管一段、不立第二正本**：
 *
 * - 依赖钉版与 peer 规矩 → `devkit.audit-deps` 与发版检票
 * - 自述三格 / 服务名 / skill 数 → repo-kit 的 self-report 守卫（住各仓 tests）
 * - 文档论断 → docfirst
 * - 产物形状 → 各仓 artifact 测试
 * - **这儿管形状与静态红线**：仓形（薄壳 / 裸根单件）、件包自足、短名派生链、
 *   `files` 白名单、`prepublishOnly`，外加两条机械可判的红线（cordis 写在
 *   dependencies、tsconfig `paths` 与 `link:` / `file:` 依赖）
 *
 * 规则的正本是 scaffold 模板——「模板产物零 findings」的 round-trip 测试焊着这两边：
 * 模板改了形而检查器没跟上，当场红；检查器加了规则而模板产物过不了，也当场红。
 *
 * 裸根单件仓不判死刑：报 `bare-root-single` 形 + 一条 info 级 finding，detail 里给
 * 这个仓**按实际文件名拼好的**迁移清单——「随触随迁」的那个「触」就是这条命令。
 */

/** findings 的三级：error 长不成 / 装不上 / 必炸；warn 活得下去但偏离当前形；info 是提示 */
export type FindingLevel = 'error' | 'warn' | 'info'

export interface StructureFinding {
  kind: string
  level: FindingLevel
  /** 相对仓根的路径，finding 说的是它 */
  path: string
  detail: string
}

export type RepoShape = 'workspace' | 'bare-root-single' | 'unknown'

/** 一个成员包的扫描结果（薄壳仓的 plugins/* 与 packages/*，裸根仓的根自己） */
export interface MemberScan {
  /** 相对仓根：`plugins/foo`、`packages/bar`；裸根单件仓的根自己是 `.` */
  dir: string
  /** 包内顶层条目名（文件与目录混着，按名排序） */
  entries: string[]
  manifest: Record<string, unknown> | null
  /** `src/index.ts` 的文本，不在就是 null */
  entrySource: string | null
  /** 包内顶层 tsconfig*.json 的文本，键是文件名 */
  tsconfigs: Record<string, string>
  /** `src/` 顶层条目名；src 不在就是空表 */
  srcEntries: string[]
  /** `src/client/` 顶层条目名；没有 client 半就是空表 */
  clientEntries: string[]
}

export interface RepoScan {
  root: string
  /** 仓根顶层条目名 */
  rootEntries: string[]
  workspaceYaml: string | null
  rootManifest: Record<string, unknown> | null
  members: MemberScan[]
}

export interface StructureReport {
  shape: RepoShape
  findings: StructureFinding[]
}

/** 按 kind 计数。与 audit-deps 那边的 countByKind 同一个口径，但吃的是这边的 finding 形状 */
export function tallyKinds(findings: { kind: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const one of findings) out[one.kind] = (out[one.kind] ?? 0) + 1
  return out
}

// ── 扫描那半（fs）──────────────────────────────────────────────────────────

function readText(full: string): string | null {
  try {
    return fs.readFileSync(full, 'utf8')
  } catch {
    return null
  }
}

function parseManifest(full: string): Record<string, unknown> | null {
  const text = readText(full)
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function listDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => e.name)
  } catch {
    return []
  }
}

function scanMember(root: string, dir: string): MemberScan {
  const full = path.join(root, dir)
  const entries = listDir(full)
  const tsconfigs: Record<string, string> = {}
  for (const name of entries) {
    if (name.startsWith('tsconfig') && name.endsWith('.json')) {
      const text = readText(path.join(full, name))
      if (text !== null) tsconfigs[name] = text
    }
  }
  const srcDir = path.join(full, 'src')
  const srcEntries = listDir(srcDir)
  const clientEntries = srcEntries.includes('client') ? listDir(path.join(srcDir, 'client')) : []
  return {
    dir,
    entries,
    manifest: parseManifest(path.join(full, 'package.json')),
    entrySource: readText(path.join(srcDir, 'index.ts')),
    tsconfigs,
    srcEntries,
    clientEntries,
  }
}

/** workspace yaml 的 packages 里有没有 `plugins/` 那条——薄壳仓的判据，与 scaffold.plugin 同一条 */
export function yamlHasPluginsZone(yaml: string | null): boolean {
  return yaml !== null && /^\s*-\s+plugins\//m.test(yaml)
}

/**
 * 扫一个仓。**只看三层的名字与几个关键文件**，不进 node_modules、不进 docs-site：
 * 体检吃的是形状，不是内容。
 */
export function scanRepo(root: string): RepoScan {
  const rootEntries = listDir(root)
  const workspaceYaml = readText(path.join(root, 'pnpm-workspace.yaml'))
  const rootManifest = parseManifest(path.join(root, 'package.json'))
  const members: MemberScan[] = []
  if (yamlHasPluginsZone(workspaceYaml)) {
    for (const group of ['plugins', 'packages']) {
      for (const name of listDir(path.join(root, group))) {
        if (fs.statSync(path.join(root, group, name)).isDirectory()) members.push(scanMember(root, `${group}/${name}`))
      }
    }
  } else if (rootManifest !== null && keywordsOf(rootManifest).includes('gwb-plugin')) {
    members.push(scanMember(root, '.'))
  } else {
    // 认不出形，但 plugins/ 真在就把成员也扫了——形是 warn，成员该报的照样报
    for (const group of ['plugins', 'packages']) {
      for (const name of listDir(path.join(root, group))) {
        if (fs.statSync(path.join(root, group, name)).isDirectory()) members.push(scanMember(root, `${group}/${name}`))
      }
    }
  }
  return { root, rootEntries, workspaceYaml, rootManifest, members }
}

// ── 规则那半（纯机）────────────────────────────────────────────────────────

function keywordsOf(manifest: Record<string, unknown> | null): string[] {
  const raw: unknown = manifest?.['keywords']
  return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === 'string') : []
}

function scriptsOf(manifest: Record<string, unknown> | null): Record<string, string> {
  const raw: unknown = manifest?.['scripts']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function depsOf(manifest: Record<string, unknown> | null, field: string): Record<string, string> {
  const raw: unknown = manifest?.[field]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function filesOf(manifest: Record<string, unknown> | null): string[] {
  const raw: unknown = manifest?.['files']
  return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === 'string') : []
}

function nameOf(manifest: Record<string, unknown> | null): string {
  const raw: unknown = manifest?.['name']
  return typeof raw === 'string' ? raw : ''
}

function isPluginMember(member: MemberScan): boolean {
  return keywordsOf(member.manifest).includes('gwb-plugin')
}

/** `src/index.ts` 里 `export const name = '…'` 的值，不在就是 null */
function entryNameOf(source: string | null): string | null {
  if (source === null) return null
  const m = /export const name = '([^']+)'/.exec(source)
  return m === null ? null : (m[1] ?? null)
}

/** 裸根单件仓的迁移清单：按 '.' 成员的实际条目拼 git mv 序列 */
function migrationDetail(member: MemberScan): string {
  // 留在根上的：git 元物、锁、站、仓级文档与忽略表；其余是件包的东西，跟着走
  const stays = new Set(['.git', 'node_modules', 'dist', 'docs-site', '.gitignore', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'AGENTS.md', 'README.md'])
  const movable = member.entries.filter((one) => !stays.has(one))
  return [
    '随触随迁——下次大动这个仓时顺手迁成薄壳：',
    `  1. mkdir plugins/<短名>（短名从包名派生）`,
    `  2. git mv ${movable.join(' ')} plugins/<短名>/`,
    '  3. 根换 private 薄壳（照 devkit 仓的根：build/check 递归），pnpm-workspace.yaml 写上 - plugins/*；docs-site 不动',
    '迁完再跑 devkit.audit-structure，应零 findings',
  ].join('\n')
}

/**
 * 规则机。喂一份扫描，回一份报告——不碰盘、不看网络，纯函数。
 */
export function auditStructure(scan: RepoScan): StructureReport {
  const findings: StructureFinding[] = []
  const add = (kind: string, level: FindingLevel, at: string, detail: string): void => {
    findings.push({ kind, level, path: at, detail })
  }

  const workspace = yamlHasPluginsZone(scan.workspaceYaml)
  const bareRoot = !workspace && keywordsOf(scan.rootManifest).includes('gwb-plugin')
  const shape: RepoShape = workspace ? 'workspace' : bareRoot ? 'bare-root-single' : 'unknown'

  if (shape === 'unknown') {
    // 不是插件仓（没有 plugins 分区、根也不是件）就当没看见；plugins/ 真在而 yaml 没那条才是结构病
    if (scan.members.length > 0) add('shape-unknown', 'warn', '.', '有 plugins/ 或 packages/ 成员，但 pnpm-workspace.yaml 里没有 plugins/ 那条、根也不是件——这既不是薄壳也不是裸根单件，先定形再来')
    return { shape, findings }
  }

  if (workspace) {
    if (scan.rootManifest === null) {
      add('root-manifest-missing', 'error', 'package.json', '薄壳根缺 package.json——build/check 没有递归的落脚点')
    } else {
      if (scan.rootManifest['private'] !== true) add('root-not-private', 'warn', 'package.json', '薄壳根该 private: true——壳是工作区，不是要发的东西')
      const build = scriptsOf(scan.rootManifest)['build'] ?? ''
      if (!build.includes('pnpm -r') && !build.includes('./plugins/')) {
        add('root-scripts-not-recursive', 'warn', 'package.json', `根 build 脚本（${build}）不像递归到成员的样子——仓根 build/check 该是 pnpm -r`)
      }
    }
    if (scan.workspaceYaml !== null && /^\s*-\s+docs-site\s*$/m.test(scan.workspaceYaml)) {
      add('docs-site-in-workspace', 'warn', 'pnpm-workspace.yaml', 'docs-site 收进了 workspace——六区那套站自带 pnpm-workspace.yaml，收进来就是工作区里套工作区（devkit 自己是历史反例，别学）')
    }
  }

  for (const member of scan.members) {
    const isPlugin = isPluginMember(member)
    const short = member.dir === '.' ? '' : path.posix.basename(member.dir)

    if (member.manifest === null) {
      add('manifest-missing', 'error', `${member.dir}/package.json`, '成员包缺 package.json——包不成包')
      continue
    }

    // ── 分区：件住 plugins/，非件包住 packages/ ────────────────────────────
    if (member.dir.startsWith('packages/') && isPlugin) {
      add('plugin-in-packages-zone', 'warn', member.dir, 'keywords 自报 gwb-plugin，却住在 packages/——件住 plugins/，看包名就知道住哪儿的那条习俗就破了')
    }

    // ── 静态红线（件与非件包都管）────────────────────────────────────────
    if ('cordis' in depsOf(member.manifest, 'dependencies')) {
      add('cordis-in-dependencies', 'error', `${member.dir}/package.json`, 'cordis 写在 dependencies——home 里会有第二份实例，Service 身份对不上、挂不上，报错不指根因（红线二）。该住 devDependencies')
    }
    for (const [file, text] of Object.entries(member.tsconfigs)) {
      if (/"paths"\s*:\s*\{[^}]/.test(text)) {
        add('tsconfig-paths', 'error', `${member.dir}/${file}`, 'tsconfig 开了 paths——源码里不许有指回别的仓的路径（红线一），映射出来的问题运行期才炸')
      }
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [pkg, spec] of Object.entries(depsOf(member.manifest, field))) {
        if (spec.includes('link:') || spec.includes('file:')) {
          add('local-protocol-dep', 'error', `${member.dir}/package.json`, `${pkg} 写成 ${spec}——本地协议依赖是源码里指回别的仓的路径（红线一），发出去没人装得上`)
        }
      }
    }

    if (!isPlugin) continue

    // ── 件包层：派生链、白名单、自足 ──────────────────────────────────────
    const pkgName = nameOf(member.manifest)
    const scopeMatch = /^@godcreator\/gwb-(.+)$/.exec(pkgName)
    if (scopeMatch === null) {
      add('name-chain', 'error', `${member.dir}/package.json`, `包名 ${pkgName} 不在 @godcreator/gwb-<短名> 的派生链上`)
    }
    const shortFromPkg = scopeMatch?.[1] ?? ''
    if (member.dir !== '.' && pkgName !== `@godcreator/gwb-${short}`) {
      add('name-chain', 'error', `${member.dir}/package.json`, `目录叫 ${short}，包名却是 ${pkgName}——目录名（短名）派生包名是整条链的第一环`)
    }
    if (member.dir.startsWith('plugins/') && short.startsWith('gwb-')) {
      add('plugin-dir-full-name', 'warn', member.dir, `目录名 ${short} 带 gwb- 前缀——plugins/ 目录用短名（block-note 式全名是历史形状），短名派生包名、插件名、命令名前半`)
    }
    const entryName = entryNameOf(member.entrySource)
    const expectedEntry = shortFromPkg === '' ? null : `gwb-${shortFromPkg}`
    if (member.entrySource === null) {
      add('name-chain', 'error', `${member.dir}/src/index.ts`, '缺 src/index.ts——件包的 node 半入口')
    } else if (entryName === null) {
      add('name-chain', 'error', `${member.dir}/src/index.ts`, "src/index.ts 里没有 `export const name = '…'`——cordis 靠它认件")
    } else if (expectedEntry !== null && entryName !== expectedEntry) {
      add('name-chain', 'error', `${member.dir}/src/index.ts`, `插件名 ${entryName} 与包名 ${pkgName} 派生出的 ${expectedEntry ?? '?'} 对不上——名字三环（短名/包名/插件名）必须一环扣一环`)
    }

    const files = new Set(filesOf(member.manifest))
    const whitelist = ['dist', 'src', ...(['skills', 'bin', 'template'] as const).flatMap((one) => (member.entries.includes(one) ? [one] : []))]
    const missing = whitelist.filter((one) => !files.has(one))
    if (missing.length > 0) {
      add('files-whitelist', 'error', `${member.dir}/package.json`, `files 白名单缺 ${missing.join('、')}——装包那一刻就少东西（${missing.includes('dist') ? '插件根本挂不上' : '随包的能力装不进 home'}），而且一声不吭`)
    }
    if (scriptsOf(member.manifest)['prepublishOnly'] === undefined) {
      add('prepublish-only', 'error', `${member.dir}/package.json`, '没有 prepublishOnly——少了它 publish 会把上一版的 dist/ 原样发出去，静默的（红线六）')
    }

    const notSelfContained = ['tsconfig.json', 'vitest.config.ts', '.oxlintrc.json'].filter((one) => !member.entries.includes(one))
    if (notSelfContained.length > 0) {
      add('pkg-not-self-contained', 'warn', member.dir, `件包缺 ${notSelfContained.join('、')}——包该自足（根共享配置是老仓的形状）；oxlint 认 cwd 命中，配置不在包内时它静默用缺省规则，守卫悄悄变松`)
    }
    if (member.srcEntries.includes('client')) {
      const browserMissing = [
        ...(member.entries.includes('build.ts') ? [] : ['build.ts']),
        ...(member.clientEntries.includes('tsconfig.json') ? [] : ['src/client/tsconfig.json']),
      ]
      if (browserMissing.length > 0) {
        add('browser-half-incomplete', 'warn', `${member.dir}/src/client`, `有浏览器半但缺 ${browserMissing.join('、')}——两半 tsconfig 各管各的，少一半那半就没人查`)
      }
    }
  }

  if (bareRoot) {
    const first = scan.members[0]
    if (first !== undefined) add('bare-root-single', 'info', '.', migrationDetail(first))
  }

  return { shape, findings }
}
