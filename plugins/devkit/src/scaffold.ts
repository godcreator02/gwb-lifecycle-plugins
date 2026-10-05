import fs from 'node:fs'
import path from 'node:path'
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from 'yaml'
import { isRecord, parseHttpUrl, TEAM_REGISTRY, TEAM_SCOPE, versionCore } from './vocab.js'

/** 短名：kebab-case。段之间只许一个连字符、结尾不许有连字符——宽松的写法会放过 `x--`，生成的包名就一直带着它 */
export const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** npm 包名范围：`@` 加小写字母、数字与 `-._~`，不以 `.`、`_` 开头（npm 对新包名的规则） */
export const SCOPE_RE = /^@[a-z0-9~-][a-z0-9._~-]*$/

/** 模板文件的后缀，写到磁盘时去掉 */
export const TEMPLATE_SUFFIX = '.tpl'

/** 模板的仓根部分：生成仓根。建仓时用，加插件不碰 */
export const REPO_ZONE = 'repo'

/** 模板的插件包部分：生成 `plugins/<短名>/`。建仓与加插件生成的是同一份，两种仓的插件包格式一致靠这个 */
export const PKG_ZONE = 'pkg'

/** 插件包所在的那条 workspace glob：加插件要求仓的 `pnpm-workspace.yaml` 的 packages 里有它 */
export const PLUGINS_GLOB = 'plugins/*'

/** 模板插件 peer 里用到的两个插件：顶层 inject 了它们，写普通 peer */
export const COMMANDS_PACKAGE = '@godcreator/gwb-commands'
export const SHELL_PACKAGE = '@godcreator/gwb-shell'

/**
 * 运行建仓命令的那个 home 里的版本号：内核是正在运行的内核，命令总线与外壳是 home 里装着的。
 * 生成的插件包 peer 里分别写 `^<x.y.z>`，模板里不写死任何一个
 */
export interface PeerVersions {
  kernel: string
  commands: string
  shell: string
}

export interface ScaffoldInput {
  name: string
  dir: string
  peerVersions: PeerVersions
  /** 包名范围，`@` 开头。不给是 `TEAM_SCOPE` */
  scope?: string
  /** 写进插件包 `publishConfig.registry` 的发布目标。不给是 `TEAM_REGISTRY` */
  registry?: string
}

export interface ScaffoldPlan {
  /** 短名。模板里要显示名的地方也用它 */
  name: string
  /** 完整包名 `<scope>/gwb-<短名>` */
  pkg: string
  /** 插件包 `publishConfig.registry` 的值 */
  registry: string
  /** 插件名 `gwb-<短名>`——`export const name` 的值 */
  pluginName: string
  /** 转成绝对路径之后的目标目录 */
  dir: string
  /** 生成的插件包 peer 里各范围的下限，都只取 x.y.z 三段 */
  peerVersions: PeerVersions
}

/** 往已有的 workspace 仓加一个插件的参数 */
export interface ScaffoldPluginInput {
  name: string
  repo: string
  peerVersions: PeerVersions
  /** 同 `ScaffoldInput.scope` */
  scope?: string
  /** 同 `ScaffoldInput.registry` */
  registry?: string
}

/** 加一个插件的计划。派生规则与 `ScaffoldPlan` 相同，dir 直接指到插件包目录 */
export interface ScaffoldPluginPlan {
  /** 短名 */
  name: string
  /** 完整包名 `<scope>/gwb-<短名>` */
  pkg: string
  /** 插件包 `publishConfig.registry` 的值 */
  registry: string
  /** 插件名 `gwb-<短名>` */
  pluginName: string
  /** workspace 仓根（转成绝对路径之后） */
  repoDir: string
  /** 插件包目录：`<repo>/plugins/<短名>` */
  dir: string
  /** 同 `ScaffoldPlan.peerVersions` */
  peerVersions: PeerVersions
}

/** 一份渲染好的文件：相对路径（已去掉 .tpl、已按所属部分算好位置）+ 正文 */
export interface RenderedFile {
  rel: string
  text: string
}

/** `from` 所在的包的根。向上找 package.json、不写死层数：从源码运行时本模块在 `src/`，从构建产物运行时在 `dist/` */
export function packageRoot(from: string): string {
  let dir = from
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) throw new Error(`从 ${from} 往上找到盘根都没有 package.json`)
    dir = up
  }
}

/** 报错要写出该怎么改：命令总线不带参数形状，调用方只能靠报错认出自己错在哪 */
function validShortName(rawName: string): string {
  const name = rawName.trim()
  if (!NAME_RE.test(name)) {
    throw new Error(`name 要是 kebab-case（${String(NAME_RE)}），实得 ${JSON.stringify(rawName)}`)
  }
  return name
}

function scopeOrTeamScope(scope: string | undefined): string {
  if (scope === undefined) return TEAM_SCOPE
  if (!SCOPE_RE.test(scope)) {
    throw new Error(`scope 要是 @ 开头的 npm 范围（${String(SCOPE_RE)}，如 "@someone"），实得 ${JSON.stringify(scope)}`)
  }
  return scope
}

/**
 * 只收规范写法（与 `new URL(registry).href` 逐字相同）：原样写进 package.json 的 JSON 字符串里，
 * 规范写法里没有要转义的字符。账号写在 URL 里会随包清单发出去，发布 token 配在发起 home 的 npm-auth 凭据
 */
function registryOrTeamRegistry(registry: string | undefined): string {
  if (registry === undefined) return TEAM_REGISTRY
  const url = parseHttpUrl(registry)
  if (url === undefined) {
    throw new Error(`registry 要是 http(s) 地址（如 "http://localhost:4873/"），实得 ${JSON.stringify(registry)}`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('registry 不许带账号、查询串或 #（发布 token 配在发起 home 的 npm-auth 凭据）')
  }
  if (url.href !== registry) {
    throw new Error(`registry 要写成规范写法 ${JSON.stringify(url.href)}，实得 ${JSON.stringify(registry)}`)
  }
  return registry
}

export function planScaffold(input: ScaffoldInput): ScaffoldPlan {
  const name = validShortName(input.name)
  const rawDir = input.dir.trim()
  if (rawDir === '') throw new Error('dir 是必给的：目标目录的绝对路径，且必须还不存在')
  // 只在这一处转成绝对路径：调用方给相对路径时，「相对谁」得有个明确的答案
  const dir = path.resolve(rawDir)
  return {
    name,
    pkg: `${scopeOrTeamScope(input.scope)}/gwb-${name}`,
    registry: registryOrTeamRegistry(input.registry),
    pluginName: `gwb-${name}`,
    dir,
    peerVersions: peerVersionCores(input.peerVersions),
  }
}

function peerVersionCores({ kernel, commands, shell }: PeerVersions): PeerVersions {
  return { kernel: versionCore(kernel), commands: versionCore(commands), shell: versionCore(shell) }
}

/** home 里装着的一个包的版本号，读 `<home>/node_modules/<包>/package.json`。没装、或清单里没有版本号就抛 */
function installedVersionInHome(homeDir: string, pkg: string): string {
  const manifestPath = path.join(homeDir, 'node_modules', ...pkg.split('/'), 'package.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`运行这条命令的 home 里没装 ${pkg}（没有 ${manifestPath}）：模板插件的 peer 照这个 home 装着的版本写`)
  }
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const version = isRecord(manifest) ? manifest['version'] : undefined
  if (typeof version !== 'string') throw new Error(`${manifestPath} 里没有字符串的 version`)
  return version
}

/** 运行建仓命令的那个 home 的 `PeerVersions`：内核取正在运行的版本号，命令总线与外壳读 home 里装着的 */
export function homePeerVersions(homeDir: string, runningKernelVersion: string): PeerVersions {
  return {
    kernel: runningKernelVersion,
    commands: installedVersionInHome(homeDir, COMMANDS_PACKAGE),
    shell: installedVersionInHome(homeDir, SHELL_PACKAGE),
  }
}

/** 读好的一份 YAML，连同把字符偏移换成行列的表：读出来的形状不对时，报错指出是哪一处 */
interface ParsedYaml {
  doc: Document.Parsed
  lines: LineCounter
  file: string
}

/** 按 YAML 读一份文字。有语法错误就抛，报出文件、第几行第几列与 yaml 库的说明 */
function parseYaml(text: string, file: string): ParsedYaml {
  const lines = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lines })
  const yaml = { doc, lines, file }
  const [syntaxError] = doc.errors
  if (syntaxError !== undefined) throw yamlError(yaml, syntaxError.pos[0], `不是合法的 YAML：${syntaxError.message}`)
  return yaml
}

/** `offset` 是文字里的字符偏移，报错里换成从 1 数的行列 */
function yamlError({ lines, file }: ParsedYaml, offset: number, why: string): Error {
  const { line, col } = lines.linePos(offset)
  return new Error(`${file} 第 ${String(line)} 行第 ${String(col)} 列${why}`)
}

/** pnpm-workspace.yaml 里 `packages` 的各条 glob。没有这个键回 null；YAML 写坏了、或 packages 不是字符串列表，报错 */
function workspacePackageGlobs(text: string, file: string): string[] | null {
  const yaml = parseYaml(text, file)
  const root = yaml.doc.contents
  if (root === null) return null
  if (!isMap(root)) throw yamlError(yaml, root.range[0], '：顶层要是「键: 值」')
  const entry = root.items.find((pair) => isScalar(pair.key) && pair.key.value === 'packages')
  if (entry === undefined) return null
  const packages = entry.value
  if (!isSeq(packages)) throw yamlError(yaml, (packages ?? entry.key).range[0], '：packages 要是列表')
  return packages.items.map((item) => {
    if (isScalar(item) && typeof item.value === 'string') return item.value
    throw yamlError(yaml, item.range[0], '：packages 的每一项要是一条字符串')
  })
}

/** 要读磁盘：repo 必须已经是 workspace 仓（`pnpm-workspace.yaml` 的 packages 里有 `plugins/*` 那条） */
export function planScaffoldPlugin(input: ScaffoldPluginInput): ScaffoldPluginPlan {
  const name = validShortName(input.name)
  const pkg = `${scopeOrTeamScope(input.scope)}/gwb-${name}`
  const registry = registryOrTeamRegistry(input.registry)
  const rawRepo = input.repo.trim()
  if (rawRepo === '') throw new Error('repo 是必给的：workspace 仓根的绝对路径（pnpm-workspace.yaml 所在的那一层）')
  const repoDir = path.resolve(rawRepo)
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new Error(`${repoDir} 不在——repo 给的是 workspace 仓根，不是插件包目录`)
  }
  const yamlPath = path.join(repoDir, 'pnpm-workspace.yaml')
  const globs = fs.existsSync(yamlPath) ? workspacePackageGlobs(fs.readFileSync(yamlPath, 'utf8'), yamlPath) : null
  if (globs === null || !globs.includes(PLUGINS_GLOB)) {
    const found = globs === null ? '没有 pnpm-workspace.yaml 或里面没有 packages' : `读到的是 ${JSON.stringify(globs)}`
    throw new Error(`${repoDir} 不是 workspace 仓：pnpm-workspace.yaml 的 packages 里没有 ${PLUGINS_GLOB} 这一条（${found}）`)
  }
  return {
    name,
    pkg,
    registry,
    pluginName: `gwb-${name}`,
    repoDir,
    dir: path.join(repoDir, 'plugins', name),
    peerVersions: peerVersionCores(input.peerVersions),
  }
}

/** 占位符表需要的最小形状——建仓计划与加插件计划都满足 */
interface Placeholdable {
  name: string
  pkg: string
  registry: string
  pluginName: string
  peerVersions: PeerVersions
}

/**
 * 占位符表。值都出自 `NAME_RE`、`SCOPE_RE`、规范写法的 http(s) 地址与版本号三段，放进 JSON、TS、Markdown 都不用转义，
 * 原样替换。模板里要显示名的地方用短名 `{{name}}`
 */
export function placeholders(plan: Placeholdable): Record<string, string> {
  return {
    name: plan.name,
    pkg: plan.pkg,
    registry: plan.registry,
    pkgName: plan.pluginName,
    // 样式类前缀：短名去掉非小写字母。Tailwind 4 的 prefix() 只收 a-z，有连字符或数字时 build 才报错，check 照样全绿
    cssPrefix: plan.name.replace(/[^a-z]/g, ''),
    kernelVersion: plan.peerVersions.kernel,
    commandsVersion: plan.peerVersions.commands,
    shellVersion: plan.peerVersions.shell,
  }
}

/** 认不出的占位符直接抛错：留在生成的仓里的 `{{typo}}` 没人知道它本来该是什么。`file` 是写到磁盘的相对路径，只用来写报错 */
export function render(text: string, values: Record<string, string>, file: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`模板 ${file} 里有认不出的占位符 {{${key}}}`)
    return value
  })
}

/** 模板文件的相对路径 → 写到磁盘的相对路径（去掉 .tpl）。不带后缀的原样保留 */
export function targetRel(rel: string): string {
  return rel.endsWith(TEMPLATE_SUFFIX) ? rel.slice(0, -TEMPLATE_SUFFIX.length) : rel
}

/** 模板相对路径 → 写到磁盘的相对路径（相对仓根）。不属于 `repo/`、`pkg/` 的文件直接抛错 */
export function landRel(rel: string, pluginName: string): string {
  if (rel.startsWith(`${PKG_ZONE}/`)) {
    return `plugins/${pluginName}/${targetRel(rel.slice(PKG_ZONE.length + 1))}`
  }
  if (rel.startsWith(`${REPO_ZONE}/`)) {
    return targetRel(rel.slice(REPO_ZONE.length + 1))
  }
  throw new Error(`模板文件 ${rel} 不属于任何部分（${REPO_ZONE}/、${PKG_ZONE}/）——每个文件都得声明写到哪`)
}

/** 递归列出模板目录下的所有文件，回相对 root 的路径（正斜杠） */
export function listTemplateFiles(root: string): string[] {
  const templateFiles: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else templateFiles.push(rel)
    }
  }
  walk(root, '')
  return templateFiles
}

/**
 * 仓根与插件包两部分先整套渲染在内存里，占位符出错在写磁盘之前就抛。
 * 生成的 JSON / YAML 读不读得懂由 `tests/scaffold.test.ts` 对本包的模板核对
 */
export function renderTemplate(templateRoot: string, plan: ScaffoldPlan): RenderedFile[] {
  const values = placeholders(plan)
  return listTemplateFiles(templateRoot).map((rel) => {
    const landed = landRel(rel, plan.name)
    return { rel: landed, text: render(fs.readFileSync(path.join(templateRoot, rel), 'utf8'), values, landed) }
  })
}

/** 往已有的 workspace 仓加插件：只渲染插件包部分（`pkg/`），rel 相对插件包根 */
export function renderPlugin(templateRoot: string, plan: Placeholdable): RenderedFile[] {
  const values = placeholders(plan)
  return listTemplateFiles(path.join(templateRoot, PKG_ZONE)).map((rel) => {
    const landed = targetRel(rel)
    return { rel: landed, text: render(fs.readFileSync(path.join(templateRoot, PKG_ZONE, rel), 'utf8'), values, landed) }
  })
}

/** 目标目录必须还不存在：往已有目录里写文件没有干净的回滚点 */
export function writeRepo(dir: string, files: RenderedFile[]): void {
  if (fs.existsSync(dir)) throw new Error(`目标目录已经存在，不覆盖任何东西：${dir}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) {
    const full = path.join(dir, file.rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, file.text, 'utf8')
  }
}

/** 回执里指向说明书的那一步：流程只写在说明书里，回执只带这次建仓特有的路径与包目录 */
function followManualStep(repoDir: string, name: string): string {
  const devCall = commandCall('devkit.dev', { home: '<隔离 home 名>', dir: repoDir, packages: [`plugins/${name}`] })
  return `往下照说明书 gwb-devkit 的「新写一个插件」第 4 步起做（${commandCall('skill.read', { name: 'gwb-devkit' })}）；在隔离 home 里验证时是 ${devCall}`
}

/** 只写这次建仓特有的：仓与插件包在哪；流程指向说明书 */
export function nextSteps(plan: ScaffoldPlan): string[] {
  return [`仓在 ${plan.dir}，插件包 ${plan.pkg} 在 plugins/${plan.name}/`, followManualStep(plan.dir, plan.name)]
}

/** 回执里给的一条命令调用：参数用 JSON.stringify 写，Windows 路径的反斜杠转义过，照抄就是合法 JSON */
function commandCall(command: string, args: Record<string, unknown>): string {
  return `${command} ${JSON.stringify(args)}`
}

export function nextStepsPlugin(plan: ScaffoldPluginPlan): string[] {
  return [`插件包 ${plan.pkg} 在 ${plan.dir}`, followManualStep(plan.repoDir, plan.name), 'README 的插件清单由人补上这个插件']
}
