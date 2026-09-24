import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { planScaffold, planScaffoldPlugin, renderPlugin, renderTemplate, writeRepo } from '../src/scaffold.js'
import { auditStructure, scanRepo, type StructureFinding } from '../src/structure.js'

/**
 * 结构体检的规则机。**真写临时目录**——scan 本来就是走盘的，拿替身测等于没测。
 * 最要紧的一条是 round-trip：scaffold 模板的产物必须零 findings——模板是形状的正本，
 * 检查器是被这条测试焊住不漂的投影。
 */

const TEMPLATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template')

/** 运行建仓命令的内核版本号 */
const KERNEL = '0.2.7'

const sandboxes: string[] = []
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-structure-'))
  sandboxes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text, 'utf8')
  }
}

/** 件包 manifest 的覆盖面——结构化改，不做字符串手术（stringify 出来的没有空格可对） */
interface ManifestOver {
  name?: string
  keywords?: string[]
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** 一个合规件包的文件表（root 相对件包根）。over 替换/追加文件，值给 null 就删 */
function pluginFiles(short: string, over: Record<string, string | null> = {}, manifestOver: ManifestOver = {}): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: `@godcreator/gwb-${short}`,
      keywords: ['gwb', 'gwb-plugin'],
      files: ['dist', 'src'],
      scripts: { prepublishOnly: 'pnpm build' },
      devDependencies: { cordis: '4.0.0-rc.9' },
      ...manifestOver,
    }),
    'src/index.ts': `export const name = 'gwb-${short}'\n`,
    'tsconfig.json': '{"compilerOptions":{}}\n',
    'vitest.config.ts': 'export {}\n',
    '.oxlintrc.json': '{}\n',
  }
  for (const [rel, text] of Object.entries(over)) {
    if (text === null) delete files[rel]
    else files[rel] = text
  }
  return files
}

/** 一个合规薄壳仓的文件表（root 相对仓根） */
function workspaceFiles(
  short: string,
  pluginOver: Record<string, string | null> = {},
  manifestOver: ManifestOver = {},
  rootExtra: Record<string, string> = {},
): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: `gwb-${short}-workspace`,
      private: true,
      scripts: { build: 'pnpm -r --filter "./plugins/*" build' },
    }),
    'pnpm-workspace.yaml': 'packages:\n  - plugins/*\n',
  }
  for (const [rel, text] of Object.entries(pluginFiles(short, pluginOver, manifestOver))) files[`plugins/${short}/${rel}`] = text
  return { ...files, ...rootExtra }
}

function build(files: Record<string, string>): string {
  const dir = path.join(sandbox(), 'repo')
  writeFiles(dir, files)
  return dir
}

function audit(dir: string): { shape: string; kinds: string[]; findings: StructureFinding[] } {
  const report = auditStructure(scanRepo(dir))
  return { shape: report.shape, kinds: report.findings.map((f) => f.kind), findings: report.findings }
}

describe('round-trip：模板产物零 findings（正本焊接）', () => {
  it('建仓：renderTemplate 的产物过检，一条不剩', () => {
    const dir = path.join(sandbox(), 'repo')
    writeRepo(dir, renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir, docs: false, testedKernel: KERNEL })))
    const report = audit(dir)
    expect(report.shape).toBe('workspace')
    expect(report.findings).toEqual([])
  })

  it('加件：往同一个仓再加第二件，两件都过检', () => {
    const dir = path.join(sandbox(), 'repo')
    writeRepo(dir, renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir, docs: false, testedKernel: KERNEL })))
    const plan = planScaffoldPlugin({ name: 'world', repo: dir, testedKernel: KERNEL })
    writeRepo(plan.dir, renderPlugin(TEMPLATE_ROOT, plan))
    expect(audit(dir).findings).toEqual([])
    expect(scanRepo(dir).members.map((m) => m.dir).sort()).toEqual(['plugins/hello', 'plugins/world'])
  })
})

describe('仓形判定', () => {
  it('裸根单件仓：bare-root-single + 一条 info 迁移清单，不判死刑', () => {
    const dir = build({ ...pluginFiles('x'), 'pnpm-workspace.yaml': 'allowBuilds: {}\n' })
    const report = audit(dir)
    expect(report.shape).toBe('bare-root-single')
    expect(report.kinds).toEqual(['bare-root-single'])
    expect(report.findings[0]?.detail).toContain('git mv')
    expect(report.findings[0]?.level).toBe('info')
  })

  it('不是插件仓（无 plugins 分区、根也不是件）就当没看见；plugins/ 真在而 yaml 没那条才是结构病', () => {
    expect(audit(build({ 'package.json': '{"name":"x","private":true}' })).findings).toEqual([])
    const broken = audit(
      build({
        'package.json': '{"name":"x","private":true}',
        'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
        'plugins/foo/package.json': '{"name":"@godcreator/gwb-foo"}',
      }),
    )
    expect(broken.shape).toBe('unknown')
    expect(broken.kinds).toEqual(['shape-unknown'])
  })

  it('薄壳根：不 private、build 不递归、docs-site 收进 workspace，三条 warn', () => {
    const dir = build(workspaceFiles('x', {}, {}, {
      'package.json': '{"name":"w","scripts":{"build":"tsc"}}',
      'pnpm-workspace.yaml': 'packages:\n  - plugins/*\n  - docs-site\n',
    }))
    expect(audit(dir).kinds.sort()).toEqual(['docs-site-in-workspace', 'root-not-private', 'root-scripts-not-recursive'])
  })
})

describe('件包层', () => {
  it('目录名与包名对不上（派生链第一环）→ error（插件名那环会连带断，两条都是 name-chain）', () => {
    expect(audit(build(workspaceFiles('foo', {}, { name: '@godcreator/gwb-bar' }))).kinds).toEqual(['name-chain', 'name-chain'])
  })

  it('插件名与包名派生对不上（第三环）→ error；src/index.ts 缺了也是 error', () => {
    expect(audit(build(workspaceFiles('foo', { 'src/index.ts': "export const name = 'gwb-else'\n" }))).kinds).toEqual(['name-chain'])
    expect(audit(build(workspaceFiles('foo', { 'src/index.ts': null }))).kinds).toEqual(['name-chain'])
  })

  it('Service 形（default export）不是断链——第三环无从核，放过；双引号也认', () => {
    // base-plugins 的 data 那批是真 Service 形件，拿引号风格或形态当判据只会造误报
    expect(audit(build(workspaceFiles('x', { 'src/index.ts': 'export default class X extends Service {}\n' }))).findings).toEqual([])
    expect(audit(build(workspaceFiles('x', { 'src/index.ts': 'export const name = "gwb-x"\n' }))).findings).toEqual([])
  })

  it('plugins/ 目录用全名（gwb- 前缀）→ warn，block-note 式历史形状', () => {
    // 短名取 'gwb-foo'：包名跟着目录派生（@godcreator/gwb-gwb-foo），链是扣上的，
    // 单独把「目录名带前缀」这条 warn 摘出来
    expect(audit(build(workspaceFiles('gwb-foo'))).kinds).toEqual(['plugin-dir-full-name'])
  })

  it('件住 packages/ → warn；packages 里的非件包不报', () => {
    const okZone = build({
      ...workspaceFiles('x'),
      'packages/util/package.json': JSON.stringify({ name: '@godcreator/util', keywords: ['gwb'], files: ['dist'] }),
    })
    expect(audit(okZone).findings).toEqual([])
    const misplaced = build({
      ...workspaceFiles('x'),
      'packages/util/package.json': pluginFiles('util')['package.json']!,
      'packages/util/src/index.ts': pluginFiles('util')['src/index.ts']!,
      'packages/util/tsconfig.json': '{}\n',
      'packages/util/vitest.config.ts': 'export {}\n',
      'packages/util/.oxlintrc.json': '{}\n',
    })
    expect(audit(misplaced).kinds).toEqual(['plugin-in-packages-zone'])
  })

  it('files 白名单缺 dist → error（插件挂不上）；目录在（skills）而白名单没带也是 error', () => {
    const noDist = audit(build(workspaceFiles('x', {}, { files: ['src'] })))
    expect(noDist.kinds).toEqual(['files-whitelist'])
    expect(noDist.findings[0]?.detail).toContain('挂不上')
    expect(audit(build(workspaceFiles('x', { 'skills/a/SKILL.md': '# a\n' }))).kinds).toEqual(['files-whitelist'])
  })

  it('prepublishOnly 缺了 → error（红线六）', () => {
    expect(audit(build(workspaceFiles('x', {}, { scripts: {} }))).kinds).toEqual(['prepublish-only'])
  })

  it('件包缺 tsconfig / vitest / oxlint 配置 → warn（根共享是老仓形状）', () => {
    const report = audit(build(workspaceFiles('x', { 'vitest.config.ts': null, '.oxlintrc.json': null })))
    expect(report.kinds).toEqual(['pkg-not-self-contained'])
    expect(report.findings[0]?.detail).toContain('vitest.config.ts')
  })

  it('有浏览器半但缺 build.ts / client tsconfig → warn', () => {
    expect(audit(build(workspaceFiles('x', { 'src/client/index.tsx': 'export {}\n' }))).kinds).toEqual(['browser-half-incomplete'])
  })
})

describe('静态红线', () => {
  it('cordis 写在 dependencies → error', () => {
    const dir = build(workspaceFiles('x', {}, { devDependencies: {}, dependencies: { cordis: '4.0.0-rc.9' } }))
    expect(audit(dir).kinds).toEqual(['cordis-in-dependencies'])
  })

  it('tsconfig 开 paths → error；空 paths 不算', () => {
    const withPaths = audit(build(workspaceFiles('x', { 'tsconfig.json': '{"compilerOptions":{"paths":{"@x/*":["../other/src/*"]}}}\n' })))
    expect(withPaths.kinds).toEqual(['tsconfig-paths'])
    const emptyPaths = audit(build(workspaceFiles('x', { 'tsconfig.json': '{"compilerOptions":{"paths":{}}}\n' })))
    expect(emptyPaths.findings).toEqual([])
  })

  it('link: / file: 依赖 → error，哪个字段里都一样', () => {
    const dir = build(
      workspaceFiles('x', {}, { dependencies: { '@godcreator/other': 'link:../other' } }),
    )
    expect(audit(dir).kinds).toEqual(['local-protocol-dep'])
  })
})
