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
  return { name, title, pkg: `${SCOPE}/gwb-${name}`, pluginName: `gwb-${name}`, dir }
}

/** 占位符表。模板里写 `{{name}}` 这种，替换是纯字符串替换，不做转义 */
export function placeholders(plan: ScaffoldPlan): Record<string, string> {
  return { name: plan.name, title: plan.title, pkg: plan.pkg, pkgName: plan.pluginName }
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

/** 生成的仓建好之后，下一步做什么。回执里带着它，调用方不用再问一遍 */
export function nextSteps(plan: ScaffoldPlan): string[] {
  return [
    `cd ${plan.dir}`,
    'pnpm install',
    'pnpm build',
    '发一版：先抬 package.json 的版本号，再 pnpm publish --registry http://127.0.0.1:4873/ --no-git-checks',
    `装进 home：调 plugins.install {"pkg":"${plan.pkg}"}，或手动 pnpm add + 在 cordis.yml 手写 id 条目`,
    '写件手册：读 skill「gwb-devkit」——红线、服务地图、验机都在里面',
  ]
}
