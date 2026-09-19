import fs from 'node:fs'
import path from 'node:path'
import type { GuardVt } from './vitest-context.js'

/**
 * 自述防漏：包的 `description`（唯一随包的一句话自述）与站现状区不许撒谎。
 *
 * 身份卡（`catalog.md`）2026-09-18 退休，卡上守过的几格搬到这儿：
 *
 * - **格式**：`description` 里得有「服务 / skill / 命令」三格——缺了就是没按口径写
 * - **服务**：源码里 `super(ctx, '<名>')` 提供的服务名，description 必须点名；
 *   一个服务都没有的件要写「服务无」（两边互斥）
 * - **provides**：`gwb.provides` 的键与源码提供的服务名互为充要，每条 `summary` / `usage`
 *   非空——`devkit.services` 靠它把用法带进回执，撒谎等于误导每一个写件的人
 * - **skill**：`skills/` 下带 `SKILL.md` 的目录数 == description 里那个数
 * - **inject 防漏**：源码里注入的服务名必须出现在站现状区（默认 `docs-site/content/docs`）——
 *   这条原来盯卡（「该写的没写」），现在盯站；没有文档站的包跳过
 *
 * **数不出来的不守**：命令条数。源码里命令名有字面量、常量、模板串、条件注册几种形态，
 * 扫出来的数与运行时对不上（2026-09-18 实测：devkit 源码 10 / 运行时 9，shell 源码 4 / 运行时 10），
 * 所以只做形状校验（得是 `命令 <数字> 条` 或 `命令无`）——条数真伪只有运行时知道。
 *
 * **只管件**：manifest 的 `keywords` 里没写 `gwb-plugin` 的（库、共享包、工具）直接跳过——
 * 三格口径是给件的；库的自述另有一套（`库/工具：…`，`["gwb"]`）。
 */

export interface SelfReportGuardOptions {
  /** 包根：`package.json` / `src/` / `skills/` 的家。薄壳里用 `path.resolve(here, '..')` 算 */
  root: string
  /** 站现状区相对包根的位置。指不到就不守 inject 那一条 */
  docsDir?: string
}

/** 源码里 inject 的服务名全表。三种写法都扫：export const / static / 局部 ctx.inject */
export function injectServicesOf(srcText: string): Set<string> {
  const services = new Set<string>()
  for (const m of srcText.matchAll(/(?:export const inject|static inject)\s*=\s*\[([^\]]*)\]/g)) {
    for (const q of m[1]!.matchAll(/'([^']+)'/g)) services.add(q[1]!)
  }
  for (const m of srcText.matchAll(/\.inject\(\s*\[([^\]]*)\]/g)) {
    for (const q of m[1]!.matchAll(/'([^']+)'/g)) services.add(q[1]!)
  }
  return services
}

/**
 * 源码里提供的服务名。生态里有三种写法，都得扫到（2026-09-18 全仓点过一遍）：
 *
 * - `super(ctx, '<名>')`——`extends Service` 的构造函数（多数件）
 * - `ctx.provide('<名>', api)`——自己造 api 对象直接挂（commands 这么做）
 * - `new SomethingService(ctx, '<名>')`——直接 new 一个 Service 子类并当场起名（logger 这么做）
 */
export function providedServicesOf(srcText: string): Set<string> {
  const services = new Set<string>()
  for (const m of srcText.matchAll(/super\(\s*ctx\s*,\s*'([^']+)'/g)) services.add(m[1]!)
  for (const m of srcText.matchAll(/\.provide\(\s*'([^']+)'/g)) services.add(m[1]!)
  for (const m of srcText.matchAll(/new\s+[\w.]+\s*\(\s*ctx\s*,\s*'([^']+)'/g)) services.add(m[1]!)
  return services
}

function readTree(dir: string, filter: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...readTree(full, filter))
    else if (filter(full)) out.push(full)
  }
  return out
}

function srcTextOf(root: string): string {
  return readTree(path.join(root, 'src'), (f) => /\.tsx?$/.test(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
}

/** `skills/` 下带 SKILL.md 的目录数 */
function skillCount(root: string): number {
  const dir = path.join(root, 'skills')
  if (!fs.existsSync(dir)) return 0
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))).length
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** `gwb.provides` 的声明表；字段形状不对当没写那一条 */
function providesOf(manifest: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const provides = asRecord(asRecord(asRecord(manifest)?.['gwb'])?.['provides'])
  if (provides === undefined) return out
  for (const [key, value] of Object.entries(provides)) {
    const entry = asRecord(value)
    if (entry !== undefined) out.set(key, entry)
  }
  return out
}

export function registerSelfReportGuard(vt: GuardVt, options: SelfReportGuardOptions): void {
  const root = options.root
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    description?: unknown
    keywords?: unknown
  }
  const isPlugin = Array.isArray(manifest.keywords) && manifest.keywords.includes('gwb-plugin')
  if (!isPlugin) return
  const description = typeof manifest.description === 'string' ? manifest.description : ''
  const srcText = srcTextOf(root)
  const provided = providedServicesOf(srcText)
  const injected = injectServicesOf(srcText)
  const provides = providesOf(manifest)
  const skills = skillCount(root)
  const docsDir = path.resolve(root, options.docsDir ?? 'docs-site/content/docs')
  const docsText = readTree(docsDir, (f) => f.endsWith('.mdx'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')

  vt.describe('自述防漏：description、provides 与站现状区', () => {
    vt.it('description 三格齐全（服务 / skill / 命令）', () => {
      vt.expect(description, 'description 少了「服务」那格').toContain('服务')
      vt.expect(description, 'description 少了「skill」那格').toContain('skill')
      vt.expect(description, 'description 的「命令」那格要写成「命令 N 条」或「命令无」').toMatch(/命令 (\d+ 条|无)/)
    })

    vt.it('提供的服务名都点了名', () => {
      for (const name of provided) vt.expect(description, `description 没提服务 ${name}`).toContain(name)
    })

    vt.it('gwb.provides 与源码提供的服务互为充要，summary / usage 非空', () => {
      for (const name of provided) {
        vt.expect(provides.has(name), `源码提供 ${name}，但 gwb.provides 里没声明——devkit.services 带不出它的用法`).toBe(true)
      }
      for (const [name, entry] of provides) {
        vt.expect(provided.has(name), `gwb.provides 声明了 ${name}，源码里并不提供`).toBe(true)
        vt.expect(typeof entry['summary'] === 'string' && entry['summary'] !== '', `gwb.provides.${name}.summary 要是非空字符串`).toBe(true)
        vt.expect(typeof entry['usage'] === 'string' && entry['usage'] !== '', `gwb.provides.${name}.usage 要是非空字符串`).toBe(true)
      }
    })

    vt.it('说明书份数对得上 skills/ 目录', () => {
      vt.expect(description, `skills/ 下有 ${String(skills)} 份说明书`).toMatch(new RegExp(`skill ${String(skills)} 份`))
    })

    vt.it('源码 inject 的服务名，站现状区里都写了', () => {
      if (docsText === '') return
      for (const name of injected) vt.expect(docsText, `站现状区没写注入了 ${name}`).toContain(name)
    })
  })
}
