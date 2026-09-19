import fs from 'node:fs'
import path from 'node:path'

/**
 * 建仓与加件的纯机：校验短名与目标，把包内 `template/` 两区渲染好、落下去。
 *
 * **只有一种仓形：薄壳 workspace。** 根是 private 壳（`pnpm build` / `pnpm check` 递归到成员，
 * 自己没有代码），件住 `plugins/<短名>/`，非件包住 `packages/`（repo-kit 那类仓侧工具，按需）。
 * 「单件仓」不是另一种仓形，只是 plugins/ 下恰好一个目录；加第二个件永远是
 * `devkit.scaffold.plugin` 往 plugins/ 再铺一个——不存在「当初建小了、现在要迁移」的悬崖。
 *
 * 短名即名字：包名 `@godcreator/gwb-<短名>`、插件名（`export const name`）`gwb-<短名>`、
 * 命令名 `<短名>.<动作>` 的前半，全从它派生。
 *
 * 模板文件一律带 `.tpl` 后缀，落盘时脱掉：`npm pack` 不打 `.gitignore`（硬行为），一条
 * 规则管所有文件。模板分两区：`repo/` 铺仓根（薄壳半），`pkg/` 铺 `plugins/<短名>/`
 * （件包半，**唯一正本**——建仓与加件落的是同一份件包形状，格式统一靠这个，不靠纪律）。
 * 落盘之前整套先在内存里渲染完——目标目录一旦开始写就没有干净的回滚点，而占位符出错
 * 是最可能的失败。
 *
 * 建仓的站那半是件落盘之后的事，两步（`index.ts` 经命令总线转给站件与 docfirst 件）；
 * 加件不碰站——一份站盖全仓，件清单的更新归 docfirst（`nextStepsPlugin` 提醒）。
 */

/** 短名：kebab-case。段之间只许一个连字符、结尾不留——松写法会放过 `x--`，生成的包名带着那条尾巴过一辈子 */
export const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** 件的包名 scope。命名规矩全仓统一，不做成参数 */
export const SCOPE = '@godcreator'

/** 模板文件的后缀，落盘时脱掉 */
export const TEMPLATE_SUFFIX = '.tpl'

/** 模板的仓半：铺仓根（薄壳壳子）。建仓时用，加件不碰 */
export const REPO_ZONE = 'repo'

/** 模板的件包半：铺 `plugins/<短名>/`。建仓与加件落的是同一份——格式统一的物理保证 */
export const PKG_ZONE = 'pkg'

export interface ScaffoldInput {
  name: string
  dir: string
  title?: string
  /** 连文档站一起建吗。**缺省建**——人记得事后补第二条命令的概率，跟容器里那一堆仓至今没有站是同一个概率 */
  docs?: boolean
  /** 文档站端口。不给就由站件的 `docs-site.create` 自己挑（扫邻居已占的，从 4310 起找空位） */
  port?: number
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
  /** 绝对化之后的目标目录 */
  dir: string
  /**
   * 这一趟建不建站。**站那半的知识不在本包**：件落盘之后经命令总线转出去，两步
   * （站件 `docs-site.create` 铺骨架 → docfirst 件 `docfirst.attach` 装六区）。
   * 依赖方向上本包**谁都不依赖**——只按名字在总线上找那两条命令
   */
  docs: boolean
  /** 站端口，没指定就是 undefined（由站件挑，本包不猜一个写进 README） */
  port: number | undefined
}

/** 往既有薄壳仓加一件的入参 */
export interface ScaffoldPluginInput {
  name: string
  repo: string
  title?: string
}

/** 加一件的计划。派生规则与 `ScaffoldPlan` 同一套，dir 直接指到件包落点 */
export interface ScaffoldPluginPlan {
  /** 短名 */
  name: string
  /** 显示名，缺省用短名 */
  title: string
  /** 完整包名 `@godcreator/gwb-<短名>` */
  pkg: string
  /** 插件名 `gwb-<短名>` */
  pluginName: string
  /** 薄壳仓根（绝对化之后） */
  repoDir: string
  /** 件包落点：`<repo>/plugins/<短名>` */
  dir: string
}

/** 一份渲染好的文件：相对仓根的路径（已脱 .tpl、已按区落到该落的地方）+ 正文 */
export interface RenderedFile {
  rel: string
  text: string
}

/**
 * 本包的根（那个有 package.json 的目录）。
 *
 * **向上找而不是写死相对层数**：源码态这个模块在 `src/`，构建产物是 `dist/index.js`
 * ——两态到包根的层数不一样，找 package.json 两态都对。
 */
export function packageRoot(from: string = import.meta.dirname): string | null {
  let dir = from
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * 校验入参并派生出整份计划。**报错要说得出该怎么改**——这条命令的主要调用方是 agent，
 * 命令总线不带参数形状，它认得出自己错在哪全靠这句话。
 */
export function planScaffold(input: ScaffoldInput): ScaffoldPlan {
  const name = input.name.trim()
  if (!NAME_RE.test(name)) {
    throw new Error(`name 要是 kebab-case（${String(NAME_RE)}），实得 ${JSON.stringify(input.name)}`)
  }
  const rawDir = input.dir.trim()
  if (rawDir === '') throw new Error('dir 是必给的：目标目录的绝对路径，且必须还不存在')
  // 绝对化只在这一处做：调用方给相对路径时，「相对谁」得有个不含糊的答案
  const dir = path.resolve(rawDir)
  const title = input.title !== undefined && input.title.trim() !== '' ? input.title.trim() : name
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
  }
}

/**
 * 校验加件的入参并派生计划。**这一步真读盘**（`planScaffold` 不读）：repo 必须已经是个
 * 薄壳 workspace 才收——`pnpm-workspace.yaml` 在、packages 里有 `plugins/` 那条。老裸根
 * 单件仓（仓根即包根）过不了这条，报错里把迁移的路说清，而不是把件铺进一个长不成的形状。
 */
export function planScaffoldPlugin(input: ScaffoldPluginInput): ScaffoldPluginPlan {
  const name = input.name.trim()
  if (!NAME_RE.test(name)) {
    throw new Error(`name 要是 kebab-case（${String(NAME_RE)}），实得 ${JSON.stringify(input.name)}`)
  }
  const rawRepo = input.repo.trim()
  if (rawRepo === '') throw new Error('repo 是必给的：薄壳仓根的绝对路径（pnpm-workspace.yaml 住的那层）')
  const repoDir = path.resolve(rawRepo)
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new Error(`${repoDir} 不在——repo 给的是薄壳仓根，不是件包目录`)
  }
  const yamlPath = path.join(repoDir, 'pnpm-workspace.yaml')
  const yaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : ''
  if (!/^\s*-\s+plugins\//m.test(yaml)) {
    throw new Error(
      `${repoDir} 不是薄壳 workspace：pnpm-workspace.yaml 里没有 plugins/ 那条。` +
        '老裸根单件仓（仓根即包根）加件前先迁成薄壳：件包 git mv 进 plugins/<短名>/、根换 private 壳（照 devkit 仓的样子），再来',
    )
  }
  const title = input.title !== undefined && input.title.trim() !== '' ? input.title.trim() : name
  return {
    name,
    title,
    pkg: `${SCOPE}/gwb-${name}`,
    pluginName: `gwb-${name}`,
    repoDir,
    dir: path.join(repoDir, 'plugins', name),
  }
}

/**
 * README 里讲文档站的那段。**别写一个不存在的站**——建了讲怎么跑，没建讲怎么补一个。
 *
 * 端口只在人指定过的时候才敢写死：不指定时是站件现挑的，本包猜一个写进 README，
 * 读者照着敲的那条 `pnpm dev` 就是错的。
 */
export function docsBlock(plan: ScaffoldPlan): string {
  const siteDir = path.join(plan.dir, 'docs-site')
  if (!plan.docs) {
    return `## 文档站

还没有。补一个是**两步**（都经命令总线，工作台跑着就走它）：

\`\`\`
docs-site.create {"dir":"${siteDir}","title":"${plan.title}"}   # 站件：铺 fumadocs 骨架
docfirst.attach  {"dir":"${siteDir}"}                            # docfirst 件：在骨架上装六区
\`\`\`

**两步要连着跑**：\`docfirst.attach\` 只在还没写过内容的骨架上装得了，往里写过东西
就得人工接线。命令不在就是那个件没装：\`plugin-manager.install\`
\`@godcreator/gwb-docs-site\` / \`@godcreator/gwb-docfirst-workflow\`。`
  }
  const dev =
    plan.port === undefined
      ? 'pnpm dev            # 端口写在 docs-site/package.json 的 dev 脚本里（站件从 4310 起挑的空位）'
      : `pnpm dev            # http://localhost:${String(plan.port)}`
  return `## 文档站

文档在 \`docs-site/\`，自己一套依赖：

\`\`\`powershell
cd docs-site
pnpm install
pnpm doc            # docfirst check：论断跟源码脱节了会报黄
${dev}
\`\`\`

改了被钉住的源码，先 \`git commit\` 再 \`pnpm doc:confirm\`——git 比较器只对已提交、
工作区干净的内容钉。文档写什么见 skill「docfirst-docs」（随 \`@godcreator/gwb-docfirst-workflow\` 发）。`
}

/** 占位符表需要的最小形状——建仓计划与加件计划都给得出 */
interface Placeholdable {
  name: string
  title: string
  pkg: string
  pluginName: string
}

/** 前五个占位符的值。`{{docsBlock}}` 只有仓半的 README 用，加件那趟不建站、不掺和 */
function corePlaceholders(plan: Placeholdable): Record<string, string> {
  return {
    name: plan.name,
    title: plan.title,
    pkg: plan.pkg,
    pkgName: plan.pluginName,
    // 样式类前缀：短名剔除非小写字母。Tailwind 4 的 prefix() 只收 a-z，短名里的连字符与数字
    // 都会被当场拒（build 阶段才炸，check 全绿——探针 2026-09-15 实测）；连字符版只做包名与命令名
    cssPrefix: plan.name.replace(/[^a-z]/g, ''),
  }
}

/** 占位符表（全套六个，建仓用）。模板里写 `{{name}}` 这种，替换是纯字符串替换，不做转义 */
export function placeholders(plan: ScaffoldPlan): Record<string, string> {
  return { ...corePlaceholders(plan), docsBlock: docsBlock(plan) }
}

/**
 * 一份模板正文 → 落盘正文。**认不出的占位符当场抛**：留一个 `{{typo}}` 在生成的仓里，
 * 它会一路活到别人的 package.json 里去，那时已经没人知道它本来该是什么。
 */
export function render(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`模板里有认不出的占位符 {{${key}}}`)
    return value
  })
}

/** 模板文件的相对路径 → 落盘的相对路径（脱掉 .tpl）。不带后缀的原样留着 */
export function targetRel(rel: string): string {
  return rel.endsWith(TEMPLATE_SUFFIX) ? rel.slice(0, -TEMPLATE_SUFFIX.length) : rel
}

/**
 * 模板相对路径 → 落盘相对路径。两区各有一条落点规则：`repo/` 铺仓根、`pkg/` 铺
 * `plugins/<短名>/`。**区外的文件当场抛**——模板里每个文件都得声明自己落哪，
 * 没声明的落下去就是一棵没人认领的树。
 */
export function landRel(rel: string, pluginName: string): string {
  if (rel.startsWith(`${PKG_ZONE}/`)) {
    return `plugins/${pluginName}/${targetRel(rel.slice(PKG_ZONE.length + 1))}`
  }
  if (rel.startsWith(`${REPO_ZONE}/`)) {
    return targetRel(rel.slice(REPO_ZONE.length + 1))
  }
  throw new Error(`模板文件 ${rel} 不在两区里（${REPO_ZONE}/ 或 ${PKG_ZONE}/）——每个文件都得声明落点`)
}

/** 递归列出模板目录下的所有文件，回相对 root 的路径（正斜杠） */
export function listTemplateFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out
}

/** 整套模板（两区一起）渲染成内存里的文件表。任何一处占位符出错，这一步整个抛，盘还没碰过 */
export function renderTemplate(templateRoot: string, plan: ScaffoldPlan): RenderedFile[] {
  const values = placeholders(plan)
  return listTemplateFiles(templateRoot).map((rel) => ({
    rel: landRel(rel, plan.name),
    text: render(fs.readFileSync(path.join(templateRoot, rel), 'utf8'), values),
  }))
}

/**
 * 只渲染件包那半（`pkg/`），rel 相对件包根——往既有薄壳仓加件用。
 * 仓半（`repo/`）是建仓时的事，加件不碰：根壳、workspace、站全都已经在盘上，
 * 这一趟只许长出 `plugins/<短名>/` 一个新目录（`writeRepo` 对它守着「必须还不存在」）。
 */
export function renderPlugin(templateRoot: string, plan: Placeholdable): RenderedFile[] {
  const values = corePlaceholders(plan)
  return listTemplateFiles(path.join(templateRoot, PKG_ZONE)).map((rel) => ({
    rel: targetRel(rel),
    text: render(fs.readFileSync(path.join(templateRoot, PKG_ZONE, rel), 'utf8'), values),
  }))
}

/** 落盘。目标目录必须还不存在——建仓与加件都是一次性动作，往已有目录里铺文件没有干净的回滚点 */
export function writeRepo(dir: string, files: RenderedFile[]): void {
  if (fs.existsSync(dir)) throw new Error(`目标目录已经存在，不覆盖任何东西：${dir}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) {
    const full = path.join(dir, file.rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, file.text, 'utf8')
  }
}

/**
 * 生成的仓建好之后，下一步做什么。回执里带着它，调用方不用再问一遍。
 *
 * `site` 说的是**站真的建起来了没有**，不是计划里想不想建：站件没装、`docs-site.create`
 * 自己失败，两种都落到「没铺」那一支——回执里给一条不存在的 `cd docs-site` 比不给还坏。
 * 骨架铺了而六区没装（docfirst 件没装、attach 失败）是第三种，单独一支：那时站在盘上，
 * 但 `pnpm doc` 那几条还不存在。
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
  const steps = [
    `cd ${plan.dir}`,
    'pnpm install',
    'pnpm build          # 根壳递归（tsc + esbuild + tailwindcss 三步）——先 build：check 里的产物守卫吃 dist/',
    'pnpm check          # 根壳递归：typecheck（node 半 + 浏览器半）+ oxlint + vitest，模板自带四份测试',
  ]
  if (built && attached) {
    steps.push(
      `文档站那半（自己一套依赖，跟件分开装）：cd ${siteDir} && pnpm install && pnpm doc${
        port === undefined ? '' : `，pnpm dev 起在 http://localhost:${String(port)}`
      }`,
      '先 git init 落第一个提交，再在 docs-site 里 pnpm doc:confirm——git 比较器只对已提交、工作区干净的内容钉',
    )
  } else if (built) {
    steps.push(
      `站只有骨架、六区还没装：docfirst.attach {"dir":"${siteDir}"}——**立刻补**，它只在还没写过内容的骨架上装得了`,
    )
  } else {
    steps.push(
      `没有文档站。补一个是两步：docs-site.create {"dir":"${siteDir}","title":"${plan.title}"}（站件铺骨架），紧接着 docfirst.attach {"dir":"${siteDir}"}（docfirst 件装六区）`,
    )
  }
  steps.push(
    `进隔离 home：devkit.home.new 开一个，devkit.dev {"home":"<名>","dir":"${plan.dir}","packages":["plugins/${plan.name}"]} 发出开发版并装进去（回执说没有条目可挂）`,
    `建条目：plugin-manager.install {"pkg":"${plan.pkg}","spec":"<回执里那个 dev 号>"}；之后每改一版走 devkit.dev（packages 同上）`,
    `验收：${plan.name}.ping 回 {ok:true,…}；plugins/${plan.name} 那格窗格「你好」+计数按钮点得动`,
    `发正式版照 skill「gwb-release」：抬号、提交、devkit.release {"dir":"${plan.dir}","packages":["plugins/${plan.name}"]}，发完当场升 default`,
    `加第二个件：devkit.scaffold.plugin {"repo":"${plan.dir}","name":"<短名>"}；写插件读 skill「gwb-devkit」；文档写什么读 skill「docfirst-docs」`,
  )
  return steps
}

/**
 * 加完一件之后，下一步做什么。与 `nextSteps` 的站那半无关——一份站盖全仓，件清单的
 * 更新归 docfirst，所以最后一步是提醒把新件写进 README 与站现状区的正本。
 */
export function nextStepsPlugin(plan: ScaffoldPluginPlan): string[] {
  return [
    `cd ${plan.repoDir}`,
    'pnpm install',
    'pnpm build          # 根壳递归，新件一起构建',
    'pnpm check          # 模板插件自带四份测试，红了先看三格自述改没改',
    `进隔离 home：devkit.home.new 开一个，devkit.dev {"home":"<名>","dir":"${plan.repoDir}","packages":["plugins/${plan.name}"]} 发出开发版并装进去（回执说没有条目可挂）`,
    `建条目：plugin-manager.install {"pkg":"${plan.pkg}","spec":"<回执里那个 dev 号>"}；之后每改一版走 devkit.dev（packages 同上）`,
    `验收：${plan.name}.ping 回 {ok:true,…}；plugins/${plan.name} 那格窗格「你好」+计数按钮点得动`,
    `发正式版照 skill「gwb-release」：抬号、提交、devkit.release {"dir":"${plan.repoDir}","packages":["plugins/${plan.name}"]}（同趟还要发别的件就按依赖序排进数组），发完当场升 default`,
    '把新件写进 README 的件清单与站现状区（正本在 docs-site/content/outputs/，改完 doc:render）；写插件读 skill「gwb-devkit」',
  ]
}
