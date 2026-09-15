import path from 'node:path'
import {
  BUILD_TIMEOUT_MS,
  DEFAULT_REGISTRY,
  type Manifest,
  literalArtifacts,
  parseManifest,
  pnpmPlan,
  type RunPlan,
} from './dev.js'

/**
 * 发正式版那条链的纯机:守卫、号从哪来、依赖写成什么、按什么顺序发。
 *
 * **与「改一版看一版」是两种安全模型。** devkit.dev 要站在被换的那个进程外面(重挂那一下
 * 会把跑在目标里的调用方停掉),所以它住控制台、操作另一个 home;而这一条只碰 registry、
 * 一个 home 都不碰——从哪个 home 调都行,没有自停问题。
 *
 * **号在仓里抬,不在这一趟里抬。** 抬号是语义行为(这一版变了什么),该跟着版本提交一起走
 * git 纪律;这条链只发 package.json 里声明的那个号,同号在源上就拒。于是「仓根 git 树干净」
 * 成了第一道守卫:正式版把未提交的改动发成 latest,是最贵的那种事故——别的仓悄悄换代码,
 * 一点异常都看不出来。
 *
 * **依赖写 `>=` 范围,不钉准确号。** 开发版必须钉(semver 不拿预发布版满足范围,不钉就是
 * 新件配旧库);正式版正相反——它就是要被 `>=` 认到,消费方跟着拿后续 patch。这一趟同发的
 * 兄弟写成 `>= 新号`,没跟着发的 workspace 依赖写成 `>= 工作区里那个号`。
 */

/** git 树的状态。`dirty` 里是 porcelain 条目原文(两列状态加路径) */
export type GitStatus = { ok: true; dirty: string[] } | { ok: false; error: string }

export interface ReleaseDeps {
  /** 前台跑一条命令到结束:成没成加输出尾巴 */
  run(plan: RunPlan, timeoutMs: number): Promise<{ ok: boolean; tail: string }>
  /**
   * 发一个正式版:在临时目录摆一份分发形态再 publish(**不改仓里的 package.json**)。
   * `ranges` 是依赖名 → 该写进去的范围:这一趟同发的包给 `>= 新号`,其余 workspace 依赖
   * 由真身那层照工作区现号补。
   */
  publish(input: { pkgDir: string; version: string; registry: string; ranges: Record<string, string> }): Promise<{ ok: boolean; tail: string }>
  /** 这个号在源上有没有。问不出来当没有(发的时候源会再拒一次,那才是权威) */
  published(spec: string, registry: string): Promise<boolean>
  /** 仓根的 git 树干不干净。问不出(不是 git 仓 / git 不在)也是一种答案:拒 */
  gitStatus(repoDir: string): Promise<GitStatus>
  readText(file: string): string | undefined
  exists(target: string): boolean
  platform: NodeJS.Platform
}

export interface ReleaseInput {
  /** 仓根。构建与 git 守卫都在这儿跑 */
  repoDir: string
  /** 要发的包目录,相对仓根,按依赖顺序(被依赖的排前面)。空表＝仓根自己(一仓一包一插件的常态) */
  packages: string[]
}

export interface ReleasedPackage {
  pkg: string
  version: string
  dir: string
}

export interface ReleaseReport {
  repoDir: string
  shipped: ReleasedPackage[]
  /** 发完之后的下一步。说清「升 default」为什么不在这条链里,免得人以为少了半截 */
  note: string
}

export type ReleaseOutcome =
  | { ok: true; data: ReleaseReport }
  | { ok: false; error: string; data?: { shipped: ReleasedPackage[] } }

/** 干净树守卫拒不拒的口径单独成一条,测试里两种平台都跑得到 */
export function dirtyLines(tail: string): string[] {
  return tail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    // porcelain 条目长成「两列状态加路径」(`?? out/`、` M src/x.ts`);别的行多半是 stderr
    // 里的噪音(git 的 safe.directory 警告之类),不拿来当脏
    .filter((line) => /^[ MADRCU?!]{1,3}\s+\S/.test(line))
}

/**
 * 走完一趟:干净树守卫 → 仓根构建 → 算号与验产物 → 按序发。
 *
 * **守卫全部在发第一个包之前跑完**:正式版发一半停下比开发版发一半糟得多(latest 上出现
 * 新旧混搭的兄弟号),所以清单读不出、产物不全、同号已发,一个都在动手之前拦下。
 */
export async function runRelease(input: ReleaseInput, deps: ReleaseDeps): Promise<ReleaseOutcome> {
  // ── 一、干净树 ──────────────────────────────────────────────────────────────
  // 发出去的必须是你提交过的状态。构建排它后面:构建产物按 files 白名单现生成,而源有没有
  // 改过,git 说了算
  const status = await deps.gitStatus(input.repoDir)
  if (!status.ok) {
    return { ok: false, error: `问不出 ${input.repoDir} 的 git 状态:${status.error}——正式版只从 git 仓里发。还没 init 的话,先 init 并提交` }
  }
  if (status.dirty.length > 0) {
    const shown = status.dirty.slice(0, 8)
    const rest = status.dirty.length > shown.length ? `\n…共 ${String(status.dirty.length)} 条` : ''
    return { ok: false, error: `仓根的 git 树不干净,一个都没发。正式版只从提交过的状态发——先提交或收掉这些:\n${shown.join('\n')}${rest}` }
  }

  // ── 二、构建 ────────────────────────────────────────────────────────────────
  // **仓根构建,不是包目录**:工作区里的件常常吃着同仓另一个包的产物,只构建被发的那一个,
  // 发出去的就是「新件配旧库」
  const built = await deps.run(pnpmPlan(['build'], input.repoDir, deps.platform), BUILD_TIMEOUT_MS)
  if (!built.ok) return { ok: false, error: `仓根 pnpm build 没成,一个都没发。输出尾巴:\n${built.tail}` }

  // ── 三、算号与守卫 ──────────────────────────────────────────────────────────
  const dirs = input.packages.length > 0 ? input.packages : ['.']
  const planned: { pkgDir: string; manifest: Manifest }[] = []
  const ranges: Record<string, string> = {}
  for (const rel of dirs) {
    const pkgDir = path.resolve(input.repoDir, rel)
    const manifest = parseManifest(deps.readText(path.join(pkgDir, 'package.json')))
    if (manifest === undefined) {
      return { ok: false, error: `${pkgDir} 下没有能读的 package.json(或缺 name/version)——包目录给的是相对仓根的路径` }
    }
    // 产物在不在照 `files` 白名单问。**不另列一份名单**:两份必然漂,而漂了的表现是
    // 「发出去了,装上了,新写的东西全没生效」
    const missing = literalArtifacts(manifest.files ?? []).filter((one) => !deps.exists(path.join(pkgDir, one)))
    if (missing.length > 0) {
      return { ok: false, error: `${manifest.name} 的产物不全,没发:${missing.join('、')} 不在。仓根 pnpm build 刚跑过还缺,多半是 files 白名单里那一项根本没人生成` }
    }
    // **发的是声明的那个号**:要发新的一版,先在仓里抬号、提交,再回来
    if (await deps.published(`${manifest.name}@${manifest.version}`, DEFAULT_REGISTRY)) {
      return { ok: false, error: `${manifest.name}@${manifest.version} 已经在源上了——同一个号永不重发,先抬 package.json 里的号再发` }
    }
    planned.push({ pkgDir, manifest })
    ranges[manifest.name] = `>=${manifest.version}`
  }

  // ── 四、按序发 ──────────────────────────────────────────────────────────────
  // **按给的顺序发**:被依赖的先发,不然装的时候源上还没有它。顺序是调用方的事,这儿不猜
  const shipped: ReleasedPackage[] = []
  for (const one of planned) {
    const sent = await deps.publish({ pkgDir: one.pkgDir, version: one.manifest.version, registry: DEFAULT_REGISTRY, ranges })
    if (!sent.ok) {
      return { ok: false, error: `${one.manifest.name}@${one.manifest.version} 发版没成:\n${sent.tail}`, data: { shipped } }
    }
    shipped.push({ pkg: one.manifest.name, version: one.manifest.version, dir: one.pkgDir })
  }

  const list = shipped.map((one) => `${one.pkg}@${one.version}`).join('、')
  return {
    ok: true,
    data: {
      repoDir: input.repoDir,
      shipped,
      note: `发好了 ${list}(tag latest)。这条链只碰源、没碰任何 home:升 default 走 plugin-manager.update-all(那是插件件在调,活得过热重挂)。发版前该在隔离 home 里验过的,验完再升`,
    },
  }
}
