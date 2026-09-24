import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { planScaffold, planScaffoldPlugin, renderPlugin, renderTemplate, writeRepo } from '../src/scaffold.js'
import { auditStructure, scanRepo, type StructureFinding } from '../src/structure.js'

/**
 * 结构体检的规则。**真写临时目录**——扫描本来就读磁盘，用替身测等于没测。
 * 最要紧的是往返测试：scaffold 模板生成的仓必须零 findings——规则以模板为准，
 * 这条测试保证两边一致。
 */

const TEMPLATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template')

/** 运行建仓命令的内核版本号 */
const KERNEL = '0.3.0'

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

/** 插件包 manifest 要覆盖的字段——按结构改，不改字符串（stringify 出来的文本没有空格可以对齐） */
interface ManifestOver {
  name?: string
  keywords?: string[]
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  exports?: Record<string, unknown>
  gwb?: Record<string, unknown>
}

/** 一个合规插件包的文件表（路径相对插件包根）。over 替换或追加文件，值给 null 就删 */
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

/** 一个合规 workspace 仓的文件表（路径相对仓根） */
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
    writeRepo(dir, renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir, docs: false, kernelVersion: KERNEL })))
    const report = audit(dir)
    expect(report.shape).toBe('workspace')
    expect(report.findings).toEqual([])
  })

  it('加件：往同一个仓再加第二件，两件都过检', () => {
    const dir = path.join(sandbox(), 'repo')
    writeRepo(dir, renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir, docs: false, kernelVersion: KERNEL })))
    const plan = planScaffoldPlugin({ name: 'world', repo: dir, kernelVersion: KERNEL })
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
    // 基础插件仓的数据插件都是 Service 形式的插件，拿引号风格或写法当判据只会误报
    expect(audit(build(workspaceFiles('x', { 'src/index.ts': 'export default class X extends Service {}\n' }))).findings).toEqual([])
    expect(audit(build(workspaceFiles('x', { 'src/index.ts': 'export const name = "gwb-x"\n' }))).findings).toEqual([])
  })

  it('plugins/ 目录用全名（gwb- 前缀）→ warn，block-note 式历史形状', () => {
    // 短名取 'gwb-foo'：包名跟着目录派生（@godcreator/gwb-gwb-foo），包名与目录名对得上，
    // 只剩「目录名带前缀」这一条 warn
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
    expect(noDist.findings[0]?.detail).toContain('加载失败')
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

  it('paths 只有指向包内的 @/* 一项时放行：界面插件仓 shell / baseui 的写法，带注释与末尾逗号', () => {
    const shellStyle = [
      '{',
      '  "extends": "../../tsconfig.base.json",',
      '  "compilerOptions": {',
      '    // 只给 shadcn CLI 看，"paths": {"@x/*": ["../x"]} 写在注释里不算',
      '    /* 不写 baseUrl */',
      '    "paths": {',
      '      "@/*": ["./src/client/*"],',
      '    },',
      '  },',
      '  "include": ["src/*.ts"]',
      '}',
    ].join('\n')
    expect(audit(build(workspaceFiles('x', { 'tsconfig.json': shellStyle }))).findings).toEqual([])
    const plain = '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}\n'
    expect(audit(build(workspaceFiles('x', { 'tsconfig.json': plain }))).findings).toEqual([])
  })

  it('@/* 以外还有别的键、@/* 指出包目录、目标不以 ./ 开头、目标为空，都报 tsconfig-paths', () => {
    for (const paths of [
      '{"@/*":["./src/*"],"@x/*":["./x/*"]}',
      '{"@/*":["../other/src/*"]}',
      '{"@/*":["./src/../../other/*"]}',
      '{"@/*":["src/*"]}',
      '{"@/*":[]}',
      '{"@x/*":["./src/*"]}',
    ]) {
      const report = audit(build(workspaceFiles('x', { 'tsconfig.json': `{"compilerOptions":{"paths":${paths}}}\n` })))
      expect(report.kinds, paths).toEqual(['tsconfig-paths'])
    }
  })

  it('解析不了的 tsconfig：有 "paths" 就报（确认不了只有包内的 @/*），没有就不报', () => {
    const broken = audit(build(workspaceFiles('x', { 'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}\n' })))
    expect(broken.kinds).toEqual(['tsconfig-paths'])
    expect(broken.findings[0]?.detail).toContain('解析不了')
    const brokenWithoutPaths = audit(build(workspaceFiles('x', { 'tsconfig.json': '{"compilerOptions":{\n' })))
    expect(brokenWithoutPaths.findings).toEqual([])
  })

  it('link: / file: 依赖 → error，哪个字段里都一样', () => {
    const dir = build(
      workspaceFiles('x', {}, { dependencies: { '@godcreator/other': 'link:../other' } }),
    )
    expect(audit(dir).kinds).toEqual(['local-protocol-dep'])
  })
})

describe('gwb.provides 与源码对应', () => {
  const serviceSource = "export const name = 'gwb-x'\nclass X { constructor(ctx) { super(ctx, 'gwbX') } }\n"
  const declared = { summary: '一句话', usage: '怎么用' }

  it('源码提供的服务没声明 → error，路径指到 package.json，说明发版也会拒', () => {
    const report = audit(build(workspaceFiles('x', { 'src/index.ts': serviceSource })))
    expect(report.kinds).toEqual(['provides-declaration'])
    expect(report.findings[0]).toMatchObject({ level: 'error', path: 'plugins/x/package.json' })
    expect(report.findings[0]?.detail).toContain('源码提供服务 gwbX')
    expect(report.findings[0]?.detail).toContain('devkit.release 会拒')
  })

  it('服务名键与 exports 里的说明符键都放行；src/ 子目录里的源码也算', () => {
    const exports = { '.': './dist/index.js', './client': './dist/client.js' }
    const gwb = { provides: { gwbX: declared, '@godcreator/gwb-x/client': declared } }
    const nested = { 'src/node/service.ts': "super(ctx, 'gwbX')\n" }
    expect(audit(build(workspaceFiles('x', nested, { exports, gwb }))).findings).toEqual([])
  })

  it('packages/ 下的库（keywords 只有 gwb）也查：键不是入口说明符 → error', () => {
    const dir = build({
      ...workspaceFiles('x'),
      'packages/util/package.json': JSON.stringify({ name: '@godcreator/util', keywords: ['gwb'], exports: { '.': './dist/index.js' }, gwb: { provides: { '@godcreator/util/nope': declared } } }),
    })
    const report = audit(dir)
    expect(report.kinds).toEqual(['provides-declaration'])
    expect(report.findings[0]?.path).toBe('packages/util/package.json')
  })
})
