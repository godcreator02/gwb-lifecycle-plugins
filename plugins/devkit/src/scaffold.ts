import fs from 'node:fs'
import path from 'node:path'
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from 'yaml'
import { parseHttpUrl, TEAM_REGISTRY, TEAM_SCOPE, versionCore } from './vocab.js'

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

/** 模板的插件页部分：只有 `plugin.mdx.tpl` 一个文件，等文档站生成完、六区装好之后才写 */
export const SITE_ZONE = 'site'

/** 插件页模板在 `template/` 下的相对路径 */
const PLUGIN_PAGE_TEMPLATE = `${SITE_ZONE}/plugin.mdx.tpl`

/** 插件包所在的那条 workspace glob：加插件要求仓的 `pnpm-workspace.yaml` 的 packages 里有它 */
export const PLUGINS_GLOB = 'plugins/*'

/**
 * 值是调用方给的任意文本、要按所在文件的上下文编码的占位符。别的占位符的值出自 `NAME_RE`、`SCOPE_RE`、
 * 规范写法的 http(s) 地址与版本号三段，或是本包拼好的 Markdown 段落（`{{docsBlock}}`），原样替换
 */
const FREE_TEXT_PLACEHOLDER = 'title'

/** 显示名只有一行：它要进窗格标题、Markdown 标题与表格的一格，这几处都放不下换行 */
const TITLE_FORBIDDEN_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/u

/** Markdown / MDX 开头的 frontmatter：开头那行 `---`、YAML 正文、收尾那行 `---`、之后的正文 */
const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/

export interface ScaffoldInput {
  name: string
  dir: string
  title?: string
  /** 连文档站一起建吗。缺省建 */
  docs?: boolean
  /** 运行 `devkit.scaffold` 的那个内核的版本号。生成的插件包在 peer 里写内核包 `^<它的 x.y.z>` */
  kernelVersion: string
  /** 包名范围，`@` 开头。不给是 `TEAM_SCOPE` */
  scope?: string
  /** 写进插件包 `publishConfig.registry` 的发布目标。不给是 `TEAM_REGISTRY` */
  registry?: string
}

export interface ScaffoldPlan {
  /** 短名 */
  name: string
  /** 显示名，缺省用短名 */
  title: string
  /** 完整包名 `<scope>/gwb-<短名>` */
  pkg: string
  /** 插件包 `publishConfig.registry` 的值 */
  registry: string
  /** 插件名 `gwb-<短名>`——`export const name` 的值 */
  pluginName: string
  /** 转成绝对路径之后的目标目录 */
  dir: string
  /** 这次建不建站。建站经命令总线按名字交给站点插件与 docfirst 插件，本包不依赖它们的包 */
  docs: boolean
  /** 生成的插件包 peer 里内核包范围的下限：运行建仓命令的内核版本号的 x.y.z 三段 */
  kernelVersion: string
}

/** 往已有的 workspace 仓加一个插件的参数 */
export interface ScaffoldPluginInput {
  name: string
  repo: string
  title?: string
  /** 运行 `devkit.scaffold.plugin` 的那个内核的版本号。生成的插件包在 peer 里写内核包 `^<它的 x.y.z>` */
  kernelVersion: string
  /** 同 `ScaffoldInput.scope` */
  scope?: string
  /** 同 `ScaffoldInput.registry` */
  registry?: string
}

/** 加一个插件的计划。派生规则与 `ScaffoldPlan` 相同，dir 直接指到插件包目录 */
export interface ScaffoldPluginPlan {
  /** 短名 */
  name: string
  /** 显示名，缺省用短名 */
  title: string
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
  /** 生成的插件包 peer 里内核包范围的下限：运行加插件命令的内核版本号的 x.y.z 三段 */
  kernelVersion: string
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
 * 规范写法里没有要转义的字符。账号写在 URL 里会随包清单发出去，发布 token 写在用户级 `~/.npmrc`
 */
function registryOrTeamRegistry(registry: string | undefined): string {
  if (registry === undefined) return TEAM_REGISTRY
  const url = parseHttpUrl(registry)
  if (url === undefined) {
    throw new Error(`registry 要是 http(s) 地址（如 "http://localhost:4873/"），实得 ${JSON.stringify(registry)}`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`registry 不许带账号、查询串或 #（发布 token 写在用户级 ~/.npmrc），实得 ${JSON.stringify(registry)}`)
  }
  if (url.href !== registry) {
    throw new Error(`registry 要写成规范写法 ${JSON.stringify(url.href)}，实得 ${JSON.stringify(registry)}`)
  }
  return registry
}

function titleOrShortName(title: string | undefined, name: string): string {
  if (title === undefined || title.trim() === '') return name
  const trimmed = title.trim()
  if (TITLE_FORBIDDEN_CHARS.test(trimmed)) {
    throw new Error(`title 是一行显示名，不许带换行、制表符这类控制字符，实得 ${JSON.stringify(title)}`)
  }
  return trimmed
}

export function planScaffold(input: ScaffoldInput): ScaffoldPlan {
  const name = validShortName(input.name)
  const rawDir = input.dir.trim()
  if (rawDir === '') throw new Error('dir 是必给的：目标目录的绝对路径，且必须还不存在')
  // 只在这一处转成绝对路径：调用方给相对路径时，「相对谁」得有个明确的答案
  const dir = path.resolve(rawDir)
  const title = titleOrShortName(input.title, name)
  return {
    name,
    title,
    pkg: `${scopeOrTeamScope(input.scope)}/gwb-${name}`,
    registry: registryOrTeamRegistry(input.registry),
    pluginName: `gwb-${name}`,
    dir,
    docs: input.docs !== false,
    kernelVersion: versionCore(input.kernelVersion),
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
    title: titleOrShortName(input.title, name),
    pkg,
    registry,
    pluginName: `gwb-${name}`,
    repoDir,
    dir: path.join(repoDir, 'plugins', name),
    kernelVersion: versionCore(input.kernelVersion),
  }
}

/** README 里讲文档站的那段：建了讲怎么运行，没建讲怎么补。README 在站建出来之前渲染，端口那时还没选出来，只说去哪儿看 */
export function docsBlock(plan: ScaffoldPlan): string {
  const siteDir = path.join(plan.dir, 'docs-site')
  if (!plan.docs) {
    return `## 文档站

还没有。补一个是**两步**（都经命令总线，工作台运行时调用）：

\`\`\`
docs-site.create ${JSON.stringify({ dir: siteDir, title: plan.title })}
docfirst.attach ${JSON.stringify({ dir: siteDir })}
\`\`\`

第一条由站点插件生成 fumadocs 骨架，第二条由 docfirst 插件在骨架上装六区。

**两步要连着运行**：\`docfirst.attach\` 只在还没加过页的骨架上装得了，加过页
就得手工配置。命令不在就是那个插件没装：\`plugin-manager.install\`
\`@godcreator/gwb-docs-site\` / \`@godcreator/gwb-docfirst-workflow\`。`
  }
  return `## 文档站

文档在 \`docs-site/\`，自己一套依赖：

\`\`\`powershell
cd docs-site
pnpm install
pnpm doc            # docfirst check：文档里引用的源码改了会报黄
pnpm dev            # 端口写在 docs-site/package.json 的 dev 脚本里（站点插件从 4310 起选的空闲端口）
\`\`\`

改了文档引用的源码，先 \`git commit\` 再 \`pnpm doc:confirm\`——git 比较器只对已提交、
工作区干净的内容记录。文档写什么见 skill「docfirst-docs」（随 \`@godcreator/gwb-docfirst-workflow\` 发）。`
}

/** 占位符表需要的最小形状——建仓计划与加插件计划都满足 */
interface Placeholdable {
  name: string
  title: string
  pkg: string
  registry: string
  pluginName: string
  kernelVersion: string
}

/** 除 `{{docsBlock}}` 以外七个占位符的值。`{{docsBlock}}` 只有仓根的 README 用；加插件不建站，用不到它 */
function corePlaceholders(plan: Placeholdable): Record<string, string> {
  return {
    name: plan.name,
    title: plan.title,
    pkg: plan.pkg,
    registry: plan.registry,
    pkgName: plan.pluginName,
    // 样式类前缀：短名去掉非小写字母。Tailwind 4 的 prefix() 只收 a-z，有连字符或数字时 build 才报错，check 照样全绿
    cssPrefix: plan.name.replace(/[^a-z]/g, ''),
    kernelVersion: plan.kernelVersion,
  }
}

/** 占位符表（全套八个，建仓用）。值是原文，`{{title}}` 由 `render` 按所在文件的上下文编码 */
export function placeholders(plan: ScaffoldPlan): Record<string, string> {
  return { ...corePlaceholders(plan), docsBlock: docsBlock(plan) }
}

/** JSON 字符串、YAML 双引号字符串里的内容；两头的双引号由模板写 */
export function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

const TS_SINGLE_QUOTED_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

/** TS 单引号字符串里的内容；两头的单引号由模板写 */
export function tsSingleQuotedContent(value: string): string {
  return value.replace(/[\\'\n\r\u2028\u2029]/g, (c) => TS_SINGLE_QUOTED_ESCAPES[c] ?? c)
}

/** JSX 文本：会被读成标签、表达式或字符引用开头的字符，写成数字字符引用 */
export function jsxTextContent(value: string): string {
  return value.replace(/[&<>{}]/g, (c) => `&#${String(c.codePointAt(0))};`)
}

/**
 * Markdown / MDX 正文里的一行文字：有语法含义的 ASCII 标点前面加反斜杠。CommonMark 认任何 ASCII 标点的
 * 反斜杠转义，MDX 靠它不把 `{`、`<` 读成表达式与标签。值只有一行（`titleOrShortName` 拒了换行）
 */
export function markdownTextContent(value: string): string {
  return value.replace(/[\\`*_[\]<>{}&|#~]/g, (c) => `\\${c}`)
}

/**
 * 每类文件里 `{{title}}` 只许写在一种上下文里：JSON 在双引号里、TS 在单引号里、TSX 在 JSX 文本里、
 * Markdown / MDX 在正文里（frontmatter 里写在双引号里，见 `render`）。别的文件类型不许用它
 */
function titleEncoderFor(file: string): ((value: string) => string) | null {
  switch (path.extname(file)) {
    case '.json':
      return jsonStringContent
    case '.ts':
      return tsSingleQuotedContent
    case '.tsx':
      return jsxTextContent
    case '.md':
    case '.mdx':
      return markdownTextContent
    default:
      return null
  }
}

/** `file` 是写到磁盘的相对路径，用来挑编码与写报错 */
function substitute(
  text: string,
  values: Record<string, string>,
  file: string,
  encodeTitle: ((value: string) => string) | null,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`模板 ${file} 里有认不出的占位符 {{${key}}}`)
    if (key !== FREE_TEXT_PLACEHOLDER) return value
    if (encodeTitle === null) {
      throw new Error(`模板 ${file} 里用了 {{title}}，但本包没定义这类文件里 title 怎么编码：在 titleEncoderFor 里加一条，或者别在这类文件里用它`)
    }
    return encodeTitle(value)
  })
}

/**
 * 认不出的占位符直接抛错：留在生成的仓里的 `{{typo}}` 没人知道它本来该是什么。
 * `file` 是写到磁盘的相对路径：`{{title}}` 按它的类型编码，Markdown / MDX 的 frontmatter 按 YAML 双引号字符串编码
 */
export function render(text: string, values: Record<string, string>, file: string): string {
  const extension = path.extname(file)
  const front = extension === '.md' || extension === '.mdx' ? FRONTMATTER.exec(text) : null
  if (front === null) return substitute(text, values, file, titleEncoderFor(file))
  const [, open = '', yaml = '', close = '', body = ''] = front
  return open + substitute(yaml, values, file, jsonStringContent) + close + substitute(body, values, file, titleEncoderFor(file))
}

/** 模板文件的相对路径 → 写到磁盘的相对路径（去掉 .tpl）。不带后缀的原样保留 */
export function targetRel(rel: string): string {
  return rel.endsWith(TEMPLATE_SUFFIX) ? rel.slice(0, -TEMPLATE_SUFFIX.length) : rel
}

/** 模板相对路径 → 写到磁盘的相对路径（相对仓根）。不属于 `repo/`、`pkg/`、`site/plugin.mdx.tpl` 的文件直接抛错 */
export function landRel(rel: string, pluginName: string): string {
  if (rel.startsWith(`${PKG_ZONE}/`)) {
    return `plugins/${pluginName}/${targetRel(rel.slice(PKG_ZONE.length + 1))}`
  }
  if (rel.startsWith(`${REPO_ZONE}/`)) {
    return targetRel(rel.slice(REPO_ZONE.length + 1))
  }
  if (rel === PLUGIN_PAGE_TEMPLATE) return pluginPageRel(pluginName)
  throw new Error(
    `模板文件 ${rel} 不属于任何部分（${REPO_ZONE}/、${PKG_ZONE}/，或 ${PLUGIN_PAGE_TEMPLATE} 这一个文件）——每个文件都得声明写到哪`,
  )
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
 * 仓根与插件包两部分先整套渲染在内存里，占位符出错在写磁盘之前就抛；插件页另由 `renderPluginPage` 渲染。
 * 生成的 JSON / YAML / frontmatter 读不读得懂由 `tests/scaffold.test.ts` 对本包的模板核对
 */
export function renderTemplate(templateRoot: string, plan: ScaffoldPlan): RenderedFile[] {
  const values = placeholders(plan)
  const repoAndPackageFiles = listTemplateFiles(templateRoot).filter((rel) => !rel.startsWith(`${SITE_ZONE}/`))
  return repoAndPackageFiles.map((rel) => {
    const landed = landRel(rel, plan.name)
    return { rel: landed, text: render(fs.readFileSync(path.join(templateRoot, rel), 'utf8'), values, landed) }
  })
}

/** 往已有的 workspace 仓加插件：只渲染插件包部分（`pkg/`），rel 相对插件包根 */
export function renderPlugin(templateRoot: string, plan: Placeholdable): RenderedFile[] {
  const values = corePlaceholders(plan)
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

/** 插件页相对仓根的路径：文档站现状区的 `plugins/<短名>.mdx` */
export function pluginPageRel(name: string): string {
  return `docs-site/content/docs/plugins/${name}.mdx`
}

/** 插件页草稿，rel 相对仓根 */
export function renderPluginPage(templateRoot: string, plan: Placeholdable): RenderedFile {
  const rel = landRel(PLUGIN_PAGE_TEMPLATE, plan.name)
  return { rel, text: render(fs.readFileSync(path.join(templateRoot, PLUGIN_PAGE_TEMPLATE), 'utf8'), corePlaceholders(plan), rel) }
}

/**
 * 仓根的文档站装好了六区（`docs-site/docfirst.config.mjs` 在）才写，否则回 null。
 * 只有骨架的站不能写：`docfirst.attach` 只在没加过页的骨架上装得了
 */
export function pluginPageTarget(repoDir: string, name: string): string | null {
  if (!fs.existsSync(path.join(repoDir, 'docs-site', 'docfirst.config.mjs'))) return null
  return path.join(repoDir, pluginPageRel(name))
}

/** 写插件页。文件已经存在就拒，不覆盖别人写过的页 */
export function writePluginPage(target: string, page: RenderedFile): void {
  if (fs.existsSync(target)) throw new Error(`插件页已经存在，不覆盖：${target}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, page.text, 'utf8')
}

/** 回执里指向说明书的那一步：流程只写在说明书里，回执只带这次建仓特有的路径与包目录 */
function followManualStep(repoDir: string, name: string): string {
  const devCall = commandCall('devkit.dev', { home: '<隔离 home 名>', dir: repoDir, packages: [`plugins/${name}`] })
  return `往下照说明书 gwb-devkit 的「新写一个插件」第 4 步起做（${commandCall('skill.read', { name: 'gwb-devkit' })}）；在隔离 home 里验证时是 ${devCall}`
}

/**
 * 只写这次建仓特有的：仓与插件包在哪、站实际建到哪一步（`site`，不是计划里想不想建）与端口；流程指向说明书。
 * 骨架生成了而六区没装是第三种情况：站在磁盘上，但 `pnpm doc` 那几条脚本还没有，插件页也没写
 */
export function nextSteps(plan: ScaffoldPlan, site: { built: boolean; attached: boolean; port?: number }): string[] {
  const siteDir = path.join(plan.dir, 'docs-site')
  const pageRel = pluginPageRel(plan.name)
  const writePageAfterwards = `装完在 ${pageRel} 写插件页`
  const siteAt = `文档站在 ${siteDir}${site.port === undefined ? '' : `，端口 ${String(site.port)}`}`
  let siteStep: string
  if (site.built && site.attached) {
    siteStep = `${siteAt}；插件页起稿已写到 ${pageRel}`
  } else if (site.built) {
    siteStep = `${siteAt}，只有骨架、六区没装：立刻补 ${commandCall('docfirst.attach', { dir: siteDir })}（它只在还没加过页的骨架上装得了），${writePageAfterwards}`
  } else {
    siteStep = `没建站。要补是两步：${commandCall('docs-site.create', { dir: siteDir, title: plan.title })}，紧接着 ${commandCall('docfirst.attach', { dir: siteDir })}；${writePageAfterwards}`
  }
  return [`仓在 ${plan.dir}，插件包 ${plan.pkg} 在 plugins/${plan.name}/`, siteStep, followManualStep(plan.dir, plan.name)]
}

/** 回执里给的一条命令调用：参数用 JSON.stringify 写，Windows 路径的反斜杠转义过，照抄就是合法 JSON */
function commandCall(command: string, args: Record<string, unknown>): string {
  return `${command} ${JSON.stringify(args)}`
}

/** `pageTarget` 是这次写下的插件页（绝对路径），没写时是 null */
export function nextStepsPlugin(plan: ScaffoldPluginPlan, pageTarget: string | null): string[] {
  const pageStep =
    pageTarget === null
      ? `仓里没有装好六区的文档站，插件页没写；以后建了站，在 ${pluginPageRel(plan.name)} 写插件页`
      : `插件页起稿已写到 ${pageTarget}`
  return [
    `插件包 ${plan.pkg} 在 ${plan.dir}`,
    pageStep,
    followManualStep(plan.repoDir, plan.name),
    'README 的插件清单由人补上这个插件（正本在 docs-site/content/outputs/，改完 doc:render）',
  ]
}
