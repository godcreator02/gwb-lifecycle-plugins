import fs from 'node:fs'
import path from 'node:path'
import { providesDeclarationProblems, sourceTextUnder } from './provides-declaration.js'

// 规则以建仓模板为准：往返测试断言模板生成的仓零 findings，规则与模板改了一边没改另一边，测试就失败

/** findings 的三级：error 构建不出来 / 装不上 / 一定出错；warn 能用但偏离当前布局；info 是提示 */
export type FindingLevel = 'error' | 'warn' | 'info'

export interface StructureFinding {
  kind: string
  level: FindingLevel
  /** 相对仓根的路径，finding 说的是它 */
  path: string
  detail: string
}

export type RepoShape = 'workspace' | 'bare-root-single' | 'unknown'

/** 一个成员包的扫描结果（workspace 仓是 plugins/* 与 packages/*；仓根就是插件的仓，成员就是仓根自己） */
export interface MemberScan {
  /** 相对仓根：`plugins/foo`、`packages/bar`；仓根就是插件的仓记作 `.` */
  dir: string
  /** 包内顶层条目名（文件与目录都算，按名排序） */
  entries: string[]
  manifest: Record<string, unknown> | null
  /** `src/index.ts` 的文本，不在就是 null */
  entrySource: string | null
  /** 包内顶层 tsconfig*.json 的文本，键是文件名 */
  tsconfigs: Record<string, string>
  /** `src/` 顶层条目名；src 不在就是空表 */
  srcEntries: string[]
  /** `src/client/` 顶层条目名；没有浏览器侧代码就是空表 */
  clientEntries: string[]
  /** `src/` 下全部 `.ts` / `.tsx` 连成的一份文本，按它找源码提供的服务；src 不在就是空串 */
  sourceText: string
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

/** 按 kind 计数。与 audit-deps 的 countByKind 算法相同，参数是这边的 finding 形状 */
export function tallyKinds(findings: { kind: string }[]): Record<string, number> {
  const countsByKind: Record<string, number> = {}
  for (const finding of findings) countsByKind[finding.kind] = (countsByKind[finding.kind] ?? 0) + 1
  return countsByKind
}

// ── 扫描（读磁盘）──────────────────────────────────────────────────────────

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
    sourceText: sourceTextUnder(full),
  }
}

/** workspace yaml 的 packages 里有没有 `plugins/` 那条——判断是不是 workspace 仓就看它，与 scaffold.plugin 同一条 */
export function yamlHasPluginsZone(yaml: string | null): boolean {
  return yaml !== null && /^\s*-\s+plugins\//m.test(yaml)
}

function scanPluginsAndPackagesMembers(root: string): MemberScan[] {
  const members: MemberScan[] = []
  for (const group of ['plugins', 'packages']) {
    for (const name of listDir(path.join(root, group))) {
      if (fs.statSync(path.join(root, group, name)).isDirectory()) members.push(scanMember(root, `${group}/${name}`))
    }
  }
  return members
}

/** 只看三层的名字、几个关键文件与各成员 `src/` 下的源码，不进 node_modules、不进 docs-site */
export function scanRepo(root: string): RepoScan {
  const rootEntries = listDir(root)
  const workspaceYaml = readText(path.join(root, 'pnpm-workspace.yaml'))
  const rootManifest = parseManifest(path.join(root, 'package.json'))
  let members: MemberScan[]
  if (yamlHasPluginsZone(workspaceYaml)) {
    members = scanPluginsAndPackagesMembers(root)
  } else if (rootManifest !== null && keywordsOf(rootManifest).includes('gwb-plugin')) {
    members = [scanMember(root, '.')]
  } else {
    // 认不出布局，但 plugins/ 或 packages/ 下有目录就照样扫成员：布局报 warn，成员的问题照报
    members = scanPluginsAndPackagesMembers(root)
  }
  return { root, rootEntries, workspaceYaml, rootManifest, members }
}

// ── 规则（纯函数）──────────────────────────────────────────────────────────

function stringListOf(manifest: Record<string, unknown> | null, field: string): string[] {
  const value: unknown = manifest?.[field]
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
}

function stringTableOf(manifest: Record<string, unknown> | null, field: string): Record<string, string> {
  const value: unknown = manifest?.[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const stringsByKey: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') stringsByKey[key] = entry
  }
  return stringsByKey
}

function keywordsOf(manifest: Record<string, unknown> | null): string[] {
  return stringListOf(manifest, 'keywords')
}

function scriptsOf(manifest: Record<string, unknown> | null): Record<string, string> {
  return stringTableOf(manifest, 'scripts')
}

function nameOf(manifest: Record<string, unknown> | null): string {
  const value: unknown = manifest?.['name']
  return typeof value === 'string' ? value : ''
}

function isPluginMember(member: MemberScan): boolean {
  return keywordsOf(member.manifest).includes('gwb-plugin')
}

/** `src/index.ts` 里 `export const name = '…'` 的值，不在就是 null。单双引号都认：引号风格与名字对不对得上无关 */
function entryNameOf(source: string | null): string | null {
  if (source === null) return null
  const match = /export const name = ['"]([^'"]+)['"]/.exec(source)
  return match === null ? null : (match[1] ?? null)
}

/** tsconfig 是 JSONC：去掉字符串外的注释与对象、数组末尾的逗号再交给 JSON.parse */
function jsoncToJson(text: string): string {
  let json = ''
  let i = 0
  while (i < text.length) {
    const c = text[i] ?? ''
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      json += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      json += c
      i++
    }
  }
  return json.replaceAll(/,(\s*[}\]])/g, '$1')
}

/** shadcn CLI 读包根 tsconfig 的 `@/*` 决定组件放到哪，这是 paths 唯一放行的键 */
const SHADCN_ALIAS = '@/*'

/**
 * 合规只有两种：没有 paths（或空对象）；只有 `@/*` 一项，每个目标 `./` 开头、规范化后不出包目录
 * （TS 7 没有 baseUrl，paths 相对 tsconfig 所在目录）。解析不了的 tsconfig 只要文本里有 `"paths"` 就算不合规
 */
export function tsconfigPathsViolation(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsoncToJson(text))
  } catch (err) {
    if (!text.includes('"paths"')) return null
    return `tsconfig 解析不了（${err instanceof Error ? err.message : String(err)}），确认不了 paths 只有包内的 ${SHADCN_ALIAS}`
  }
  const compilerOptions = isPlainRecord(parsed) ? parsed['compilerOptions'] : undefined
  const paths = isPlainRecord(compilerOptions) ? compilerOptions['paths'] : undefined
  if (paths === undefined) return null
  if (!isPlainRecord(paths)) return 'tsconfig 的 paths 不是对象'
  const keys = Object.keys(paths)
  if (keys.length === 0) return null
  if (keys.length !== 1 || keys[0] !== SHADCN_ALIAS) return `tsconfig 的 paths 有 ${keys.join('、')}，只能有 ${SHADCN_ALIAS} 一项`
  const targets = paths[SHADCN_ALIAS]
  if (!Array.isArray(targets) || targets.length === 0) return `tsconfig 的 paths 里 ${SHADCN_ALIAS} 的目标要是非空数组`
  const outside = targets.filter((target) => typeof target !== 'string' || !targetStaysInPackage(target))
  if (outside.length > 0) return `tsconfig 的 paths 里 ${SHADCN_ALIAS} 指到了包目录之外：${outside.map(String).join('、')}`
  return null
}

function targetStaysInPackage(target: string): boolean {
  const slashed = target.replaceAll('\\', '/')
  if (!slashed.startsWith('./')) return false
  const normalized = path.posix.normalize(slashed)
  return normalized !== '..' && !normalized.startsWith('../')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 旧布局仓的迁移清单：按 '.' 成员的实际条目列出 git mv 序列 */
function migrationDetail(member: MemberScan): string {
  // 留在仓根的：.git、锁文件、文档站、仓级文档与忽略表；其余属于插件包，一起移走
  const stays = new Set(['.git', 'node_modules', 'dist', 'docs-site', '.gitignore', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'AGENTS.md', 'README.md'])
  const movable = member.entries.filter((one) => !stays.has(one))
  return [
    '不用专门迁，下次改这个仓时顺手迁成 workspace 布局：',
    `  1. mkdir plugins/<短名>（短名从包名派生）`,
    `  2. git mv ${movable.join(' ')} plugins/<短名>/`,
    '  3. 仓根新写一个 private: true 的 package.json（照 devkit 仓根：build/check 用 pnpm -r 递归到各包），pnpm-workspace.yaml 写上 - plugins/*；docs-site 不动',
    '迁完再运行 devkit.audit-structure，应当一条 finding 都没有',
  ].join('\n')
}

type AddFinding = (kind: string, level: FindingLevel, at: string, detail: string) => void

function workspaceRootFindings(scan: RepoScan, add: AddFinding): void {
  if (scan.rootManifest === null) {
    add('root-manifest-missing', 'error', 'package.json', 'workspace 仓根缺 package.json——没有地方写递归到各包的 build/check 脚本')
  } else {
    if (scan.rootManifest['private'] !== true) add('root-not-private', 'warn', 'package.json', 'workspace 仓根的 package.json 应写 private: true——仓根只是工作区，不发布')
    const build = scriptsOf(scan.rootManifest)['build'] ?? ''
    if (!build.includes('pnpm -r') && !build.includes('./plugins/')) {
      add('root-scripts-not-recursive', 'warn', 'package.json', `仓根 build 脚本（${build}）里看不出递归到各成员包——仓根的 build/check 应当用 pnpm -r`)
    }
  }
  if (scan.workspaceYaml !== null && /^\s*-\s+docs-site\s*$/m.test(scan.workspaceYaml)) {
    add('docs-site-in-workspace', 'warn', 'pnpm-workspace.yaml', 'docs-site 列进了 pnpm-workspace.yaml——装了六区的文档站自带 pnpm-workspace.yaml，列进来就成了工作区里嵌套工作区（devkit 仓自己就这么写着，是遗留的反例，别照抄）')
  }
}

/** 插件与别的包都查：放错分区、cordis 写在 dependencies、tsconfig paths、本地协议依赖 */
function anyMemberFindings(member: MemberScan, isPlugin: boolean, add: AddFinding): void {
  if (member.dir.startsWith('packages/') && isPlugin) {
    add('plugin-in-packages-zone', 'warn', member.dir, 'keywords 里声明了 gwb-plugin，却放在 packages/——插件应放在 plugins/<短名>/，放错了就不能按包名找到它的目录')
  }
  if ('cordis' in stringTableOf(member.manifest, 'dependencies')) {
    add('cordis-in-dependencies', 'error', `${member.dir}/package.json`, 'cordis 写在了 dependencies——home 里会多出一份 cordis 实例，Service 身份对不上、插件加载失败，报错也不指向根因。应写在 devDependencies（规矩见 devkit 文档站「写插件的规矩」→「依赖怎么写」）')
  }
  for (const [file, text] of Object.entries(member.tsconfigs)) {
    const violation = tsconfigPathsViolation(text)
    if (violation !== null) {
      add('tsconfig-paths', 'error', `${member.dir}/${file}`, `${violation}——源码里不许有指回别的仓的路径：映射出来的路径只在本机成立，出了问题运行时才报错；只放行 shadcn CLI 要的包内 @/*（如 "./src/*"）。规矩见 devkit 文档站「写插件的规矩」→「依赖怎么写」`)
    }
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [pkg, spec] of Object.entries(stringTableOf(member.manifest, field))) {
      if (spec.includes('link:') || spec.includes('file:')) {
        add('local-protocol-dep', 'error', `${member.dir}/package.json`, `${pkg} 写成 ${spec}——本地协议依赖指向本机别的目录，发布出去谁也装不上。规矩见 devkit 文档站「写插件的规矩」→「依赖怎么写」`)
      }
    }
  }
}

/** 短名、包名、插件名对得上 */
function pluginNameFindings(member: MemberScan, add: AddFinding): void {
  const short = member.dir === '.' ? '' : path.posix.basename(member.dir)
  const pkgName = nameOf(member.manifest)
  const scopeMatch = /^@godcreator\/gwb-(.+)$/.exec(pkgName)
  if (scopeMatch === null) {
    add('name-chain', 'error', `${member.dir}/package.json`, `包名 ${pkgName} 不是 @godcreator/gwb-<短名> 的形式`)
  }
  const shortFromPkg = scopeMatch?.[1] ?? ''
  if (member.dir !== '.' && pkgName !== `@godcreator/gwb-${short}`) {
    add('name-chain', 'error', `${member.dir}/package.json`, `目录叫 ${short}，包名却是 ${pkgName}——目录名就是短名，包名应是 @godcreator/gwb-${short}`)
  }
  if (member.dir.startsWith('plugins/') && short.startsWith('gwb-')) {
    add('plugin-dir-full-name', 'warn', member.dir, `目录名 ${short} 带 gwb- 前缀——plugins/ 下的目录名用短名（像 block-note 仓那样用全名是旧写法），包名、插件名、命令名的前缀都由短名派生`)
  }
  const entryName = entryNameOf(member.entrySource)
  const expectedEntry = shortFromPkg === '' ? null : `gwb-${shortFromPkg}`
  // Service 形式（export default class … extends Service）没有 export const name，名字写在 super(ctx, "…") 里：只查入口文件在不在
  const serviceForm = member.entrySource !== null && entryName === null && /export default/.test(member.entrySource)
  if (member.entrySource === null) {
    add('name-chain', 'error', `${member.dir}/src/index.ts`, '缺 src/index.ts——插件包 node 侧的入口')
  } else if (entryName === null && !serviceForm) {
    add('name-chain', 'error', `${member.dir}/src/index.ts`, "src/index.ts 里既没有 `export const name = '…'`，也没有 export default（Service 形式）——cordis 靠其中之一识别插件")
  } else if (entryName !== null && expectedEntry !== null && entryName !== expectedEntry) {
    add('name-chain', 'error', `${member.dir}/src/index.ts`, `插件名 ${entryName} 与包名 ${pkgName} 派生出的 ${expectedEntry ?? '?'} 对不上——短名、包名、插件名三者必须对得上`)
  }
}

/** files 白名单、prepublishOnly、包内自带配置、浏览器侧的构建与 tsconfig */
function pluginPackagingFindings(member: MemberScan, add: AddFinding): void {
  const files = new Set(stringListOf(member.manifest, 'files'))
  const whitelist = ['dist', 'src', ...(['skills', 'bin', 'template'] as const).flatMap((one) => (member.entries.includes(one) ? [one] : []))]
  const missing = whitelist.filter((one) => !files.has(one))
  if (missing.length > 0) {
    add('files-whitelist', 'error', `${member.dir}/package.json`, `files 白名单缺 ${missing.join('、')}——装出来的包里就没有这些目录（${missing.includes('dist') ? '插件加载失败' : '这些目录里随包发布的东西装不进 home'}），而且安装时不报错`)
  }
  if (scriptsOf(member.manifest)['prepublishOnly'] === undefined) {
    add('prepublish-only', 'error', `${member.dir}/package.json`, '没有 prepublishOnly——少了它，手工 pnpm publish 会把上一版的 dist/ 原样发出去，而且不报错。规矩见 devkit 文档站「写插件的规矩」→「依赖怎么写」')
  }

  const notSelfContained = ['tsconfig.json', 'vitest.config.ts', '.oxlintrc.json'].filter((one) => !member.entries.includes(one))
  if (notSelfContained.length > 0) {
    add('pkg-not-self-contained', 'warn', member.dir, `插件包缺 ${notSelfContained.join('、')}——这些配置应放在包内（放在仓根共享是旧仓的写法）；oxlint 按工作目录找配置，配置不在包内时它不报错地改用默认规则，检查变松了也看不出来`)
  }
  if (member.srcEntries.includes('client')) {
    const browserMissing = [
      ...(member.entries.includes('build.ts') ? [] : ['build.ts']),
      ...(member.clientEntries.includes('tsconfig.json') ? [] : ['src/client/tsconfig.json']),
    ]
    if (browserMissing.length > 0) {
      add('browser-half-incomplete', 'warn', `${member.dir}/src/client`, `有浏览器侧代码（src/client/）但缺 ${browserMissing.join('、')}——node 侧与浏览器侧各用各的构建与 tsconfig，缺了浏览器侧那份，浏览器侧代码就没人构建或检查`)
    }
  }
}

/** 不读磁盘、不访问网络 */
export function auditStructure(scan: RepoScan): StructureReport {
  const findings: StructureFinding[] = []
  const add: AddFinding = (kind, level, at, detail) => {
    findings.push({ kind, level, path: at, detail })
  }

  const workspace = yamlHasPluginsZone(scan.workspaceYaml)
  const bareRoot = !workspace && keywordsOf(scan.rootManifest).includes('gwb-plugin')
  const shape: RepoShape = workspace ? 'workspace' : bareRoot ? 'bare-root-single' : 'unknown'

  if (shape === 'unknown') {
    // 不是插件仓（yaml 没有 plugins/ 那条、仓根也不是插件）就不报；有 plugins/ 或 packages/ 成员而 yaml 没有那条才报
    if (scan.members.length > 0) add('shape-unknown', 'warn', '.', '有 plugins/ 或 packages/ 成员，但 pnpm-workspace.yaml 里没有 plugins/ 那条、仓根也不是插件——既不是 workspace 仓，也不是仓根就是插件的旧布局仓；先改成其中一种布局再检查')
    return { shape, findings }
  }

  if (workspace) workspaceRootFindings(scan, add)

  for (const member of scan.members) {
    if (member.manifest === null) {
      add('manifest-missing', 'error', `${member.dir}/package.json`, '成员包缺 package.json——没有它就不是一个包')
      continue
    }
    const isPlugin = isPluginMember(member)
    anyMemberFindings(member, isPlugin, add)
    for (const problem of providesDeclarationProblems(member.manifest, member.sourceText)) {
      add('provides-declaration', 'error', `${member.dir}/package.json`, `${problem}。发版前检查同样查这一条，没过 devkit.release 会拒`)
    }
    if (!isPlugin) continue
    pluginNameFindings(member, add)
    pluginPackagingFindings(member, add)
  }

  if (bareRoot) {
    const first = scan.members[0]
    if (first !== undefined) add('bare-root-single', 'info', '.', migrationDetail(first))
  }

  return { shape, findings }
}
