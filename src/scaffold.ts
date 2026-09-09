import fs from 'node:fs'
import path from 'node:path'

/**
 * 建仓的纯逻辑：校验短名与目标目录，把包内 `template/` 那套骨架渲染好、落下去。
 *
 * 短名即名字：包名 `@godcreator02/gwb-<短名>`、插件名（`export const name`）`gwb-<短名>`、
 * 命令名 `<短名>.<动作>` 的前半，全从它派生。
 *
 * 模板文件一律带 `.tpl` 后缀，落盘时脱掉：`npm pack` 不打 `.gitignore`（硬行为），一条
 * 规则管所有文件，不必记哪几个特殊。落盘之前整套先在内存里渲染完——目标目录一旦开始
 * 写就没有干净的回滚点，而占位符出错是最可能的失败。
 *
 * **这儿只有件那半。** 文档站是件落盘之后的第二步，由 `index.ts` 经 `devkit.livedoc`
 * 这条 node CLI 调 `livedoc init` 铺——本模块只决定 README 里那段话怎么写。
 */

/** 短名：kebab-case。段之间只许一个连字符、结尾不留——松写法会放过 `x--`，生成的包名带着那条尾巴过一辈子 */
export const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** 件的包名 scope。命名规矩全仓统一，不做成参数 */
export const SCOPE = '@godcreator02'

/** 模板文件的后缀，落盘时脱掉 */
export const TEMPLATE_SUFFIX = '.tpl'

export interface ScaffoldInput {
  name: string
  dir: string
  title?: string
  /** 连文档站一起建吗。**缺省建**——人记得事后补第二条命令的概率，跟容器里那一堆仓至今没有站是同一个概率 */
  docs?: boolean
  /** 文档站端口。不给就由 `livedoc init` 自己挑（扫邻居已占的，从 4310 起找空位） */
  port?: number
}

export interface ScaffoldPlan {
  /** 短名 */
  name: string
  /** 显示名，缺省用短名 */
  title: string
  /** 完整包名 `@godcreator02/gwb-<短名>` */
  pkg: string
  /** 插件名 `gwb-<短名>`——`export const name` 的值 */
  pluginName: string
  /** 绝对化之后的目标目录 */
  dir: string
  /**
   * 这一趟建不建站。**站那半的知识不在本包**：件落盘之后调 livedoc 的 `init` 子命令
   * （经 `devkit.livedoc` 这条 node CLI）。方向单向——devkit 知道 livedoc，livedoc
   * 不知道 devkit
   */
  docs: boolean
  /** 站端口，没指定就是 undefined（由 livedoc 挑，本包不猜一个写进 README） */
  port: number | undefined
}

/** 一份渲染好的文件：相对目标目录的路径（已脱掉 .tpl）+ 正文 */
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
 * README 里讲文档站的那一段。**别写一个不存在的站**——建了讲怎么跑，没建讲怎么补一个。
 *
 * 端口只在人指定过的时候才敢写死：不指定时是 `livedoc init` 现挑的，本包猜一个写进
 * README，读者照着敲的那条 `pnpm dev` 就是错的。
 */
export function docsBlock(plan: ScaffoldPlan): string {
  if (!plan.docs) {
    return `## 文档站

还没有。补一个（devkit 把 livedoc 登记成了一条 node CLI，工作台跑着就走它）：

\`\`\`
devkit.livedoc {"args":["init","--dir","${plan.dir}"]}
\`\`\`

工作台没起就直接跑：

\`\`\`powershell
pnpm dlx @godcreator02/live-doc-cli init --dir ${plan.dir}
\`\`\``
  }
  const dev =
    plan.port === undefined
      ? 'pnpm dev            # 端口写在 docs-site/package.json 的 dev 脚本里（livedoc 从 4310 起挑的空位）'
      : `pnpm dev            # http://localhost:${String(plan.port)}`
  return `## 文档站

文档在 \`docs-site/\`，自己一套依赖：

\`\`\`powershell
cd docs-site
pnpm install
pnpm doc            # livedoc check：论断跟源码脱节了会报黄
${dev}
\`\`\`

改了被钉住的源码，先 \`git commit\` 再 \`pnpm doc:confirm\`——git 比较器只对已提交、
工作区干净的内容钉。文档写什么见 skill「livedoc-docs」。`
}

/** 占位符表。模板里写 `{{name}}` 这种，替换是纯字符串替换，不做转义 */
export function placeholders(plan: ScaffoldPlan): Record<string, string> {
  return {
    name: plan.name,
    title: plan.title,
    pkg: plan.pkg,
    pkgName: plan.pluginName,
    docsBlock: docsBlock(plan),
  }
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

/** 整套模板渲染成内存里的文件表。任何一处占位符出错，这一步整个抛，盘还没碰过 */
export function renderTemplate(templateRoot: string, plan: ScaffoldPlan): RenderedFile[] {
  const values = placeholders(plan)
  return listTemplateFiles(templateRoot).map((rel) => ({
    rel: targetRel(rel),
    text: render(fs.readFileSync(path.join(templateRoot, rel), 'utf8'), values),
  }))
}

/** 落盘。目标目录必须还不存在——建仓是一次性动作，往已有目录里铺文件没有干净的回滚点 */
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
 * `site` 说的是**站真的建起来了没有**，不是计划里想不想建：node-cli 件不在、`livedoc init`
 * 自己失败，两种都落到「没建」那一支——回执里给一条不存在的 `cd docs-site` 比不给还坏。
 */
export function nextSteps(plan: ScaffoldPlan, site?: { built: boolean; port?: number }): string[] {
  const built = site?.built ?? plan.docs
  const port = site?.port ?? plan.port
  const steps = [
    `cd ${plan.dir}`,
    'pnpm install',
    'pnpm check          # typecheck + oxlint + vitest，模板自带一条测试',
    'pnpm build',
  ]
  if (built) {
    steps.push(
      `文档站那半（自己一套依赖，跟件分开装）：cd ${path.join(plan.dir, 'docs-site')} && pnpm install && pnpm doc${
        port === undefined ? '' : `，pnpm dev 起在 http://localhost:${String(port)}`
      }`,
      '先 git init 落第一个提交，再在 docs-site 里 pnpm doc:confirm——git 比较器只对已提交、工作区干净的内容钉',
    )
  } else {
    steps.push(
      `没有文档站。补一个：devkit.livedoc {"args":["init","--dir","${plan.dir}"]}，或 pnpm dlx @godcreator02/live-doc-cli init --dir ${plan.dir}`,
    )
  }
  steps.push(
    '发一版：先抬 package.json 的版本号，再 pnpm publish --registry http://127.0.0.1:4873/ --no-git-checks',
    `装进 home：调 plugins.install {"pkg":"${plan.pkg}"}，或手动 pnpm add + 在 cordis.yml 手写 id 条目`,
    '写件手册：读 skill「gwb-devkit」——红线、能力面菜单、验机都在里面；文档写什么读 skill「livedoc-docs」',
  )
  return steps
}
