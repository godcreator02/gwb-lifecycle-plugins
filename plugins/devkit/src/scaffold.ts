import fs from 'node:fs'
import path from 'node:path'
import { versionCore } from './vocab.js'

/** 短名：kebab-case。段之间只许一个连字符、结尾不许有连字符——宽松的写法会放过 `x--`，生成的包名就一直带着它 */
export const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** 插件包名的 scope。全生态统一，不做成参数 */
export const SCOPE = '@godcreator'

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

export interface ScaffoldInput {
  name: string
  dir: string
  title?: string
  /** 连文档站一起建吗。缺省建 */
  docs?: boolean
  /** 文档站端口。不给就由站点插件的 `docs-site.create` 自己选（跳过别的站已占用的，从 4310 起找空位） */
  port?: number
  /** 运行 `devkit.scaffold` 的那个内核的版本号。生成的插件包在 peer 里写内核包 `^<它的 x.y.z>` */
  kernelVersion: string
}

export interface ScaffoldPlan {
  /** 短名 */
  name: string
  /** 显示名，缺省用短名 */
  title: string
  /** 完整包名 `@godcreator/gwb-<短名>` */
  pkg: string
  /** 插件名 `gwb-<短名>`——`export const name` 的值 */
  pluginName: string
  /** 转成绝对路径之后的目标目录 */
  dir: string
  /** 这次建不建站。建站经命令总线按名字交给站点插件与 docfirst 插件，本包不依赖它们的包 */
  docs: boolean
  /** 站端口，没指定就是 undefined（由站点插件选，本包不猜一个写进 README） */
  port: number | undefined
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
}

/** 加一个插件的计划。派生规则与 `ScaffoldPlan` 相同，dir 直接指到插件包目录 */
export interface ScaffoldPluginPlan {
  /** 短名 */
  name: string
  /** 显示名，缺省用短名 */
  title: string
  /** 完整包名 `@godcreator/gwb-<短名>` */
  pkg: string
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

/** 本包的根。向上找 package.json、不写死层数：从源码运行时本模块在 `src/`，从构建产物运行时在 `dist/` */
export function packageRoot(from: string = import.meta.dirname): string | null {
  let dir = from
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
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

function titleOrShortName(title: string | undefined, name: string): string {
  return title !== undefined && title.trim() !== '' ? title.trim() : name
}

export function planScaffold(input: ScaffoldInput): ScaffoldPlan {
  const name = validShortName(input.name)
  const rawDir = input.dir.trim()
  if (rawDir === '') throw new Error('dir 是必给的：目标目录的绝对路径，且必须还不存在')
  // 只在这一处转成绝对路径：调用方给相对路径时，「相对谁」得有个明确的答案
  const dir = path.resolve(rawDir)
  const title = titleOrShortName(input.title, name)
  const port = input.port
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error(`port 要是 1024–65535 的整数，实得 ${String(port)}`)
  }
  return {
    name,
    title,
    pkg: `${SCOPE}/gwb-${name}`,
    pluginName: `gwb-${name}`,
    dir,
    docs: input.docs !== false,
    port,
    kernelVersion: versionCore(input.kernelVersion),
  }
}

/** 要读磁盘：repo 必须已经是 workspace 仓（`pnpm-workspace.yaml` 的 packages 里有 `plugins/` 那条），旧布局仓报错里写清怎么迁 */
export function planScaffoldPlugin(input: ScaffoldPluginInput): ScaffoldPluginPlan {
  const name = validShortName(input.name)
  const rawRepo = input.repo.trim()
  if (rawRepo === '') throw new Error('repo 是必给的：workspace 仓根的绝对路径（pnpm-workspace.yaml 所在的那一层）')
  const repoDir = path.resolve(rawRepo)
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new Error(`${repoDir} 不在——repo 给的是 workspace 仓根，不是插件包目录`)
  }
  const yamlPath = path.join(repoDir, 'pnpm-workspace.yaml')
  const yaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : ''
  if (!/^\s*-\s+plugins\//m.test(yaml)) {
    throw new Error(
      `${repoDir} 不是薄壳 workspace：pnpm-workspace.yaml 里没有 plugins/ 那条。` +
        '仓根就是插件的旧布局仓，加插件之前先迁成 workspace 布局：插件包的文件 git mv 进 plugins/<短名>/，仓根换成 private: true 的 package.json（照 devkit 仓），再来',
    )
  }
  return {
    name,
    title: titleOrShortName(input.title, name),
    pkg: `${SCOPE}/gwb-${name}`,
    pluginName: `gwb-${name}`,
    repoDir,
    dir: path.join(repoDir, 'plugins', name),
    kernelVersion: versionCore(input.kernelVersion),
  }
}

/** README 里讲文档站的那段：建了讲怎么运行，没建讲怎么补。端口只在人指定过时写出来，不指定时由站点插件选 */
export function docsBlock(plan: ScaffoldPlan): string {
  const siteDir = path.join(plan.dir, 'docs-site')
  if (!plan.docs) {
    return `## 文档站

还没有。补一个是**两步**（都经命令总线，工作台运行时调用）：

\`\`\`
docs-site.create {"dir":"${siteDir}","title":"${plan.title}"}   # 站点插件：生成 fumadocs 骨架
docfirst.attach  {"dir":"${siteDir}"}                            # docfirst 插件：在骨架上装六区
\`\`\`

**两步要连着运行**：\`docfirst.attach\` 只在还没加过页的骨架上装得了，加过页
就得手工配置。命令不在就是那个插件没装：\`plugin-manager.install\`
\`@godcreator/gwb-docs-site\` / \`@godcreator/gwb-docfirst-workflow\`。`
  }
  const dev =
    plan.port === undefined
      ? 'pnpm dev            # 端口写在 docs-site/package.json 的 dev 脚本里（站点插件从 4310 起选的空闲端口）'
      : `pnpm dev            # http://localhost:${String(plan.port)}`
  return `## 文档站

文档在 \`docs-site/\`，自己一套依赖：

\`\`\`powershell
cd docs-site
pnpm install
pnpm doc            # docfirst check：文档里引用的源码改了会报黄
${dev}
\`\`\`

改了文档引用的源码，先 \`git commit\` 再 \`pnpm doc:confirm\`——git 比较器只对已提交、
工作区干净的内容记录。文档写什么见 skill「docfirst-docs」（随 \`@godcreator/gwb-docfirst-workflow\` 发）。`
}

/** 占位符表需要的最小形状——建仓计划与加插件计划都满足 */
interface Placeholdable {
  name: string
  title: string
  pkg: string
  pluginName: string
  kernelVersion: string
}

/** 除 `{{docsBlock}}` 以外六个占位符的值。`{{docsBlock}}` 只有仓根的 README 用；加插件不建站，用不到它 */
function corePlaceholders(plan: Placeholdable): Record<string, string> {
  return {
    name: plan.name,
    title: plan.title,
    pkg: plan.pkg,
    pkgName: plan.pluginName,
    // 样式类前缀：短名去掉非小写字母。Tailwind 4 的 prefix() 只收 a-z，有连字符或数字时 build 才报错，check 照样全绿
    cssPrefix: plan.name.replace(/[^a-z]/g, ''),
    kernelVersion: plan.kernelVersion,
  }
}

/** 占位符表（全套七个，建仓用）。模板里写 `{{name}}` 这种，替换是纯字符串替换，不做转义 */
export function placeholders(plan: ScaffoldPlan): Record<string, string> {
  return { ...corePlaceholders(plan), docsBlock: docsBlock(plan) }
}

/** 认不出的占位符直接抛错：留在生成的仓里的 `{{typo}}` 没人知道它本来该是什么 */
export function render(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`模板里有认不出的占位符 {{${key}}}`)
    return value
  })
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

/** 仓根与插件包两部分先整套渲染在内存里，占位符出错在写磁盘之前就抛；插件页另由 `renderPluginPage` 渲染 */
export function renderTemplate(templateRoot: string, plan: ScaffoldPlan): RenderedFile[] {
  const values = placeholders(plan)
  const repoAndPackageFiles = listTemplateFiles(templateRoot).filter((rel) => !rel.startsWith(`${SITE_ZONE}/`))
  return repoAndPackageFiles.map((rel) => ({
    rel: landRel(rel, plan.name),
    text: render(fs.readFileSync(path.join(templateRoot, rel), 'utf8'), values),
  }))
}

/** 往已有的 workspace 仓加插件：只渲染插件包部分（`pkg/`），rel 相对插件包根 */
export function renderPlugin(templateRoot: string, plan: Placeholdable): RenderedFile[] {
  const values = corePlaceholders(plan)
  return listTemplateFiles(path.join(templateRoot, PKG_ZONE)).map((rel) => ({
    rel: targetRel(rel),
    text: render(fs.readFileSync(path.join(templateRoot, PKG_ZONE, rel), 'utf8'), values),
  }))
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
  return {
    rel: landRel(PLUGIN_PAGE_TEMPLATE, plan.name),
    text: render(fs.readFileSync(path.join(templateRoot, PLUGIN_PAGE_TEMPLATE), 'utf8'), corePlaceholders(plan)),
  }
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

/**
 * `site` 是站实际建成了没有，不是计划里想不想建：给一条不存在的 `cd docs-site` 比不给还坏。
 * 骨架生成了而六区没装是第三种情况：站在磁盘上，但 `pnpm doc` 那几条脚本还没有，插件页也没写
 */
export function nextSteps(
  plan: ScaffoldPlan,
  site?: { built: boolean; attached?: boolean; port?: number },
): string[] {
  const built = site?.built ?? plan.docs
  // 不给 site 就照计划里的意思说：计划要建站，就是两步都要走
  const attached = site === undefined ? plan.docs : (site.attached ?? false)
  const port = site?.port ?? plan.port
  const siteDir = path.join(plan.dir, 'docs-site')
  const pageRel = pluginPageRel(plan.name)
  const writePageYourself = `在 ${pageRel} 写插件页：功能、接口（命令与窗格）、依赖的服务、不做的事`
  const steps = [
    `cd ${plan.dir}`,
    'pnpm install',
    'pnpm build          # 仓根递归构建各插件（tsc + esbuild + tailwindcss 三步）——先构建：check 里的产物测试读 dist/',
    'pnpm check          # 仓根递归：typecheck（node 侧与浏览器侧）+ oxlint + vitest，模板自带两份测试（类名前缀、构建产物）',
  ]
  if (built && attached) {
    steps.push(
      `插件页起稿已写到 ${pageRel}（插件名、包名、命令、窗格、依赖的服务）：按插件的实际功能改写`,
      `文档站那部分（自己一套依赖，跟插件分开装）：cd ${siteDir} && pnpm install && pnpm doc${
        port === undefined ? '' : `，pnpm dev 运行在 http://localhost:${String(port)}`
      }`,
      '先 git init 做第一个提交，再在 docs-site 里 pnpm doc:confirm——git 比较器只对已提交、工作区干净的内容记录',
    )
  } else if (built) {
    steps.push(
      `站只有骨架、六区还没装：docfirst.attach {"dir":"${siteDir}"}——**立刻补**，它只在还没加过页的骨架上装得了；装完之后${writePageYourself}`,
    )
  } else {
    steps.push(
      `没有文档站。补一个是两步：docs-site.create {"dir":"${siteDir}","title":"${plan.title}"}（站点插件生成骨架），紧接着 docfirst.attach {"dir":"${siteDir}"}（docfirst 插件装六区）；装完之后${writePageYourself}`,
    )
  }
  steps.push(
    `进隔离 home：devkit.home.new 开一个，devkit.dev {"home":"<名>","dir":"${plan.dir}","packages":["plugins/${plan.name}"]} 发出开发版并装进去（回执说没有条目可重新加载）`,
    `建条目：在这个隔离 home 里经 devkit.cdp 的 cmd 调 plugin-manager.install {"pkg":"${plan.pkg}","spec":"<回执里那个开发版号>"}（经 MCP 调会装进 default）；之后每改一版用 devkit.dev（packages 同上）`,
    `验收：${plan.name}.ping 回 {ok:true,…}；plugins/${plan.name} 的窗格显示「你好」，计数按钮点得动`,
    `发正式版照 skill「gwb-release」：升版本号、提交、devkit.release {"dir":"${plan.dir}","packages":["plugins/${plan.name}"]}，发完马上升级 default`,
    `加第二个插件：devkit.scaffold.plugin {"repo":"${plan.dir}","name":"<短名>"}；写插件读 skill「gwb-devkit」；文档写什么读 skill「docfirst-docs」`,
  )
  return steps
}

/** `pageTarget` 是这次写下的插件页（绝对路径），没写时是 null */
export function nextStepsPlugin(plan: ScaffoldPluginPlan, pageTarget: string | null): string[] {
  const pageStep =
    pageTarget === null
      ? `仓里没有装好六区的文档站，插件页没写。以后建了站，在 ${pluginPageRel(plan.name)} 写插件页：功能、接口（命令与窗格）、依赖的服务、不做的事`
      : `插件页起稿已写到 ${pageTarget}（插件名、包名、命令、窗格、依赖的服务）：按插件的实际功能改写`
  return [
    `cd ${plan.repoDir}`,
    'pnpm install',
    'pnpm build          # 仓根递归构建，新插件一起构建',
    'pnpm check          # 模板插件自带两份测试（类名前缀、构建产物）',
    pageStep,
    `进隔离 home：devkit.home.new 开一个，devkit.dev {"home":"<名>","dir":"${plan.repoDir}","packages":["plugins/${plan.name}"]} 发出开发版并装进去（回执说没有条目可重新加载）`,
    `建条目：在这个隔离 home 里经 devkit.cdp 的 cmd 调 plugin-manager.install {"pkg":"${plan.pkg}","spec":"<回执里那个开发版号>"}（经 MCP 调会装进 default）；之后每改一版用 devkit.dev（packages 同上）`,
    `验收：${plan.name}.ping 回 {ok:true,…}；plugins/${plan.name} 的窗格显示「你好」，计数按钮点得动`,
    `发正式版照 skill「gwb-release」：升版本号、提交、devkit.release {"dir":"${plan.repoDir}","packages":["plugins/${plan.name}"]}（同一次还要发别的包就按依赖顺序排进数组），发完马上升级 default`,
    '把新插件写进 README 的插件清单（正本在 docs-site/content/outputs/，改完 doc:render）；写插件读 skill「gwb-devkit」',
  ]
}
