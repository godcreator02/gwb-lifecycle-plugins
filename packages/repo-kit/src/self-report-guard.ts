import fs from 'node:fs'
import path from 'node:path'
import type { GuardVt } from './vitest-context.js'

export interface SelfReportGuardOptions {
  /** 包根：`package.json`、`src/`、`skills/` 所在的目录 */
  root: string
  /** 文档站现状区，相对包根；读不到一个 `.mdx` 就不查 inject 那一条 */
  docsDir?: string
}

function quotedNamesIn(listText: string): string[] {
  return [...listText.matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]!)
}

/** 按文本扫三种写法：`export const inject = [...]`、`static inject = [...]`、局部 `ctx.inject([...])` */
export function injectServicesOf(srcText: string): Set<string> {
  const injectedServiceNames = new Set<string>()
  for (const declaration of srcText.matchAll(/(?:export const inject|static inject)\s*=\s*\[([^\]]*)\]/g)) {
    for (const name of quotedNamesIn(declaration[1]!)) injectedServiceNames.add(name)
  }
  for (const localInject of srcText.matchAll(/\.inject\(\s*\[([^\]]*)\]/g)) {
    for (const name of quotedNamesIn(localInject[1]!)) injectedServiceNames.add(name)
  }
  return injectedServiceNames
}

/** 按文本扫三种写法：`super(ctx, '<名>')`、`ctx.provide('<名>', …)`、`new XxxService(ctx, '<名>')` */
export function providedServicesOf(srcText: string): Set<string> {
  const providedServiceNames = new Set<string>()
  for (const match of srcText.matchAll(/super\(\s*ctx\s*,\s*'([^']+)'/g)) providedServiceNames.add(match[1]!)
  for (const match of srcText.matchAll(/\.provide\(\s*'([^']+)'/g)) providedServiceNames.add(match[1]!)
  for (const match of srcText.matchAll(/new\s+[\w.]+\s*\(\s*ctx\s*,\s*'([^']+)'/g)) providedServiceNames.add(match[1]!)
  return providedServiceNames
}

function listFilesRecursively(dir: string, keepFile: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return []
  const keptFiles: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) keptFiles.push(...listFilesRecursively(full, keepFile))
    else if (keepFile(full)) keptFiles.push(full)
  }
  return keptFiles
}

function joinedTextOf(files: string[]): string {
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
}

function joinedSourceTextOf(root: string): string {
  return joinedTextOf(listFilesRecursively(path.join(root, 'src'), (file) => /\.tsx?$/.test(file)))
}

function joinedMdxTextUnder(docsDir: string): string {
  return joinedTextOf(listFilesRecursively(docsDir, (file) => file.endsWith('.mdx')))
}

function countSkillDirectories(root: string): number {
  const skillsDir = path.join(root, 'skills')
  if (!fs.existsSync(skillsDir)) return 0
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))).length
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** `gwb.provides` 的声明表；值不是对象的那一条当没写 */
function declaredProvidesOf(manifest: unknown): Map<string, Record<string, unknown>> {
  const declarationsByServiceName = new Map<string, Record<string, unknown>>()
  const provides = asRecord(asRecord(asRecord(manifest)?.['gwb'])?.['provides'])
  if (provides === undefined) return declarationsByServiceName
  for (const [serviceName, value] of Object.entries(provides)) {
    const declaration = asRecord(value)
    if (declaration !== undefined) declarationsByServiceName.set(serviceName, declaration)
  }
  return declarationsByServiceName
}

interface PackageManifest {
  description?: unknown
  keywords?: unknown
}

function readManifest(root: string): PackageManifest {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest
}

function isGwbPlugin(manifest: PackageManifest): boolean {
  return Array.isArray(manifest.keywords) && manifest.keywords.includes('gwb-plugin')
}

export function registerSelfReportGuard(vt: GuardVt, options: SelfReportGuardOptions): void {
  const root = options.root
  const manifest = readManifest(root)
  if (!isGwbPlugin(manifest)) return
  const description = typeof manifest.description === 'string' ? manifest.description : ''
  const sourceText = joinedSourceTextOf(root)
  const providedServiceNames = providedServicesOf(sourceText)
  const injectedServiceNames = injectServicesOf(sourceText)
  const declaredProvides = declaredProvidesOf(manifest)
  const skillDirectoryCount = countSkillDirectories(root)
  const docsText = joinedMdxTextUnder(path.resolve(root, options.docsDir ?? 'docs-site/content/docs'))

  vt.describe('自述防漏：description、provides 与站现状区', () => {
    vt.it('description 三格齐全（服务 / skill / 命令）', () => {
      vt.expect(description, 'description 少了「服务」那格').toContain('服务')
      vt.expect(description, 'description 少了「skill」那格').toContain('skill')
      vt.expect(description, 'description 的「命令」那格要写成「命令 N 条」或「命令无」').toMatch(/命令 (\d+ 条|无)/)
    })

    vt.it('提供的服务名都点了名', () => {
      for (const name of providedServiceNames) vt.expect(description, `description 没提服务 ${name}`).toContain(name)
    })

    vt.it('gwb.provides 与源码提供的服务互为充要，summary / usage 非空', () => {
      for (const name of providedServiceNames) {
        vt.expect(declaredProvides.has(name), `源码提供 ${name}，但 gwb.provides 里没声明——devkit.services 带不出它的用法`).toBe(true)
      }
      for (const [name, declaration] of declaredProvides) {
        vt.expect(providedServiceNames.has(name), `gwb.provides 声明了 ${name}，源码里并不提供`).toBe(true)
        vt.expect(typeof declaration['summary'] === 'string' && declaration['summary'] !== '', `gwb.provides.${name}.summary 要是非空字符串`).toBe(true)
        vt.expect(typeof declaration['usage'] === 'string' && declaration['usage'] !== '', `gwb.provides.${name}.usage 要是非空字符串`).toBe(true)
      }
    })

    vt.it('说明书份数对得上 skills/ 目录', () => {
      vt.expect(description, `skills/ 下有 ${String(skillDirectoryCount)} 份说明书`).toMatch(new RegExp(`skill ${String(skillDirectoryCount)} 份`))
    })

    vt.it('源码 inject 的服务名，站现状区里都写了', () => {
      if (docsText === '') return
      for (const name of injectedServiceNames) vt.expect(docsText, `站现状区没写注入了 ${name}`).toContain(name)
    })
  })
}
