import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluate } from '@mdx-js/mdx'
import { transform } from 'esbuild'
import remarkGfm from 'remark-gfm'
import YAML from 'yaml'
import {
  NAME_RE,
  PKG_ZONE,
  PLUGINS_GLOB,
  REPO_ZONE,
  SCOPE,
  SITE_ZONE,
  jsonStringContent,
  jsxTextContent,
  landRel,
  listTemplateFiles,
  markdownTextContent,
  nextSteps,
  nextStepsPlugin,
  packageRoot,
  placeholders,
  planScaffold,
  planScaffoldPlugin,
  pluginPageRel,
  pluginPageTarget,
  render,
  renderPlugin,
  renderPluginPage,
  renderTemplate,
  targetRel,
  tsSingleQuotedContent,
  writePluginPage,
  writeRepo,
} from '../src/scaffold.js'
import { KERNEL_PACKAGE, declaredKernelRange, isCaretRange, kernelRangeCovers } from '@godcreator/gwb-plugin-manager'

/**
 * 建仓与加插件的纯逻辑。**写磁盘的那几条真的写临时目录**——`writeRepo` 做的就是往磁盘上写文件，
 * 用替身测等于没测。`planScaffoldPlugin` 要检查仓的形状，也是在临时目录里现建一个仓。
 */

const TEMPLATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template')

/** 运行建仓命令的内核版本号 */
const KERNEL = '0.3.0'

const sandboxes: string[] = []
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-scaffold-'))
  sandboxes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 临时目录里搭一个薄壳仓（pnpm-workspace.yaml 带 plugins/ 那条） */
function fakeWorkspace(yaml = 'packages:\n  - plugins/*\n'): string {
  const dir = path.join(sandbox(), 'repo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), yaml, 'utf8')
  return dir
}

describe('短名校验', () => {
  it('kebab-case 过，别的都拒——段间一个连字符、结尾不留', () => {
    for (const good of ['hello', 'hello-world', 'a1', 'a1-b2']) expect(NAME_RE.test(good)).toBe(true)
    for (const bad of ['', 'Hello', 'hello_world', '1x', 'x--', 'x-', '-x', 'gwb plugin']) {
      expect(NAME_RE.test(bad), String(bad)).toBe(false)
    }
  })
})

describe('planScaffold：校验与派生', () => {
  it('短名派生出包名与插件名，title 缺省用短名', () => {
    const plan = planScaffold({ name: 'hello-world', dir: 'D:\\tmp\\x', kernelVersion: KERNEL })
    expect(plan.name).toBe('hello-world')
    expect(plan.pkg).toBe(`${SCOPE}/gwb-hello-world`)
    expect(plan.pluginName).toBe('gwb-hello-world')
    expect(plan.title).toBe('hello-world')
  })

  it('title 给了就用给的，两头空白削掉；空白串等于没给', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', title: '  打招呼  ', kernelVersion: KERNEL }).title).toBe('打招呼')
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', title: '   ', kernelVersion: KERNEL }).title).toBe('x')
  })

  it('dir 绝对化：相对路径按当前工作目录算，那不是调用方心里那个「相对谁」', () => {
    expect(path.isAbsolute(planScaffold({ name: 'x', dir: 'tmp/x', kernelVersion: KERNEL }).dir)).toBe(true)
  })

  it('短名不合规就拒，报错里带上规则；dir 空着也拒', () => {
    for (const bad of ['', 'Hello', 'hello_world']) {
      expect(() => planScaffold({ name: bad, dir: 'D:\\tmp\\x', kernelVersion: KERNEL })).toThrow(/kebab-case/)
    }
    expect(() => planScaffold({ name: 'x', dir: '   ', kernelVersion: KERNEL })).toThrow(/dir/)
  })

  it('docs 缺省是建：人记得事后补第二条命令的概率，跟那一堆仓至今没有站是同一个概率', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }).docs).toBe(true)
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false, kernelVersion: KERNEL }).docs).toBe(false)
  })

  it('port 不给就是 undefined（本包不猜一个写进 README）；给了要在 1024–65535', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }).port).toBeUndefined()
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: 4321, kernelVersion: KERNEL }).port).toBe(4321)
    for (const bad of [80, 70000, 4321.5]) {
      expect(() => planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: bad, kernelVersion: KERNEL })).toThrow(/port/)
    }
  })
})

describe('planScaffoldPlugin：往薄壳仓加件', () => {
  it('派生同一套身份，dir 直指 <repo>/plugins/<短名>', () => {
    const repo = fakeWorkspace()
    const plan = planScaffoldPlugin({ name: 'world', repo, title: '第二件', kernelVersion: KERNEL })
    expect(plan.pkg).toBe(`${SCOPE}/gwb-world`)
    expect(plan.pluginName).toBe('gwb-world')
    expect(plan.repoDir).toBe(repo)
    expect(plan.dir).toBe(path.join(repo, 'plugins', 'world'))
    expect(plan.title).toBe('第二件')
  })

  it('repo 不在、yaml 不在（仓根就是插件的旧布局仓）、yaml 的 packages 里没有 plugins/*，三种都拒，报错里写怎么迁', () => {
    expect(() => planScaffoldPlugin({ name: 'x', repo: path.join(sandbox(), 'nope'), kernelVersion: KERNEL })).toThrow(/不在/)
    const bare = path.join(sandbox(), 'bare')
    fs.mkdirSync(bare, { recursive: true })
    expect(() => planScaffoldPlugin({ name: 'x', repo: bare, kernelVersion: KERNEL })).toThrow(/薄壳 workspace/)
    const noPlugins = fakeWorkspace('packages:\n  - docs-site\n')
    expect(() => planScaffoldPlugin({ name: 'x', repo: noPlugins, kernelVersion: KERNEL })).toThrow(/薄壳 workspace/)
    for (const bad of ['', 'Hello', 'x--']) {
      expect(() => planScaffoldPlugin({ name: bad, repo: fakeWorkspace(), kernelVersion: KERNEL })).toThrow(/kebab-case/)
    }
    expect(() => planScaffoldPlugin({ name: 'x', repo: '   ', kernelVersion: KERNEL })).toThrow(/repo/)
  })
})

describe('docsBlock：README 里讲站的那段', () => {
  it('建了站就讲怎么跑；端口给了才敢写死，没给只说去哪儿看', () => {
    const withPort = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: 4321, kernelVersion: KERNEL })).docsBlock ?? ''
    expect(withPort).toContain('cd docs-site')
    expect(withPort).toContain('http://localhost:4321')

    const noPort = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', kernelVersion: KERNEL })).docsBlock ?? ''
    expect(noPort).toContain('cd docs-site')
    // 猜一个端口写进 README，读者照着敲的那条 pnpm dev 就是错的
    expect(noPort).not.toMatch(/localhost:\d/)
    expect(noPort).toContain('docs-site/package.json')
  })

  it('没建站就讲怎么补一个——两步，而且点名那两个件的命令', () => {
    const block = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false, kernelVersion: KERNEL })).docsBlock ?? ''
    expect(block).not.toContain('cd docs-site')
    expect(block).toContain('docs-site.create')
    expect(block).toContain('docfirst.attach')
    // 旧线的包与命令一个都不许再出现在生成的 README 里
    expect(block).not.toContain('devkit.livedoc')
    expect(block).not.toContain('live-doc-cli')
  })
})

describe('nextSteps：按站真建到哪一步分三支', () => {
  const plan = planScaffold({ name: 'x', dir: 'D:\\tmp\\x', kernelVersion: KERNEL })

  it('骨架铺了、六区也装了，才给 docs-site 那几步，端口有就报出来', () => {
    const steps = nextSteps(plan, { built: true, attached: true, port: 4321 }).join('\n')
    expect(steps).toContain('docs-site')
    expect(steps).toContain('4321')
    expect(steps).toContain('doc:confirm')
  })

  it('骨架铺了但六区没装：给 attach 那条，不给 pnpm doc——那几条脚本还不存在', () => {
    const steps = nextSteps(plan, { built: true, attached: false }).join('\n')
    expect(steps).toContain('docfirst.attach')
    expect(steps).not.toContain('doc:confirm')
  })

  it('骨架都没铺就给两步补建——回执里给一条不存在的 cd docs-site 比不给还坏', () => {
    const steps = nextSteps(plan, { built: false, attached: false }).join('\n')
    expect(steps).not.toContain('cd D:\\tmp\\x\\docs-site')
    expect(steps).toContain('docs-site.create')
    expect(steps).toContain('docfirst.attach')
  })

  it('不给 site 就照计划里的意思说', () => {
    expect(nextSteps(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false, kernelVersion: KERNEL })).join('\n')).toContain(
      'docs-site.create',
    )
    // 计划里要建站 = 两步都走，走到底那一支
    expect(nextSteps(plan).join('\n')).toContain('doc:confirm')
  })

  it('薄壳仓的 dev 与 release 都带 packages 指到 plugins/ 下——packages 缺省只属于老裸根仓', () => {
    const steps = nextSteps(plan).join('\n')
    expect(steps).toContain('"packages":["plugins/x"]')
    expect(steps).toContain('devkit.release')
    expect(steps).toContain('gwb-release')
    expect(steps).toContain('plugin-manager.install')
    expect(steps).not.toContain('pnpm publish')
    expect(steps).not.toContain('--registry')
  })

  it('nextStepsPlugin：不建站；写了插件页就报出路径，没写就说以后建站要补哪一页；尾巴是 README 的插件清单', () => {
    const repo = fakeWorkspace()
    const plan = planScaffoldPlugin({ name: 'w', repo, kernelVersion: KERNEL })
    const written = nextStepsPlugin(plan, 'D:\\repo\\docs-site\\content\\docs\\plugins\\w.mdx').join('\n')
    expect(written).toContain('"packages":["plugins/w"]')
    expect(written).toContain('doc:render')
    expect(written).not.toContain('docs-site.create')
    expect(written).toContain('D:\\repo\\docs-site\\content\\docs\\plugins\\w.mdx')
    const notWritten = nextStepsPlugin(plan, null).join('\n')
    expect(notWritten).toContain(pluginPageRel('w'))
    expect(notWritten).toContain('依赖的服务')
  })

  it('nextSteps：站装好六区时报插件页已写；没装好时每一支都说装完之后写哪一页', () => {
    expect(nextSteps(plan, { built: true, attached: true }).join('\n')).toContain(`插件页起稿已写到 ${pluginPageRel('x')}`)
    for (const site of [{ built: true, attached: false }, { built: false, attached: false }]) {
      expect(nextSteps(plan, site).join('\n')).toContain(pluginPageRel('x'))
    }
  })
})

describe('render：占位符', () => {
  const values = { name: 'hello', title: '打招呼', pkg: '@godcreator/gwb-hello', pkgName: 'gwb-hello' }

  it('认得的键替换掉', () => {
    expect(render('{{name}} / {{title}} / {{name}}', values, 'README.md')).toBe('hello / 打招呼 / hello')
  })

  it('认不出的占位符当场抛——留着它会一路活到别人的 package.json 里', () => {
    expect(() => render('{{typo}}', values, 'README.md')).toThrow(/typo/)
  })

  it('没定义 title 怎么编码的文件类型里出现 {{title}}，当场抛并说是哪个文件', () => {
    expect(() => render('.a { content: "{{title}}" }', values, 'src/client/styles.css')).toThrow(/styles\.css.*title/)
    // 别的占位符的值出自短名与版本号，不需要编码，出现在哪种文件里都行
    expect(render('.{{name}} {}', values, 'src/client/styles.css')).toBe('.hello {}')
  })

  it('值里带着占位符的样子也不会被再替换一次', () => {
    expect(render('{{title}}', { ...values, title: '{{name}}' }, 'x.ts')).toBe('{{name}}')
  })
})

describe('targetRel 与 landRel：后缀与两区落点', () => {
  it('带后缀的脱掉，不带的原样', () => {
    expect(targetRel('package.json.tpl')).toBe('package.json')
    // npm pack 不打 .gitignore，模板里那份必须带后缀存着
    expect(targetRel('.gitignore.tpl')).toBe('.gitignore')
    expect(targetRel('README.md')).toBe('README.md')
  })

  it('repo/ 铺仓根，pkg/ 铺 plugins/<短名>/，区外当场抛', () => {
    expect(landRel('repo/package.json.tpl', 'hello')).toBe('package.json')
    expect(landRel('repo/.gitignore.tpl', 'hello')).toBe('.gitignore')
    expect(landRel('pkg/src/index.ts.tpl', 'hello')).toBe('plugins/hello/src/index.ts')
    expect(landRel('pkg/.oxlintrc.json.tpl', 'hello')).toBe('plugins/hello/.oxlintrc.json')
    expect(landRel('site/plugin.mdx.tpl', 'hello')).toBe('docs-site/content/docs/plugins/hello.mdx')
    expect(() => landRel('src/index.ts.tpl', 'hello')).toThrow(/不属于任何部分/)
    expect(() => landRel('site/other.mdx.tpl', 'hello')).toThrow(/不属于任何部分/)
  })
})

describe('包内 template/：两区', () => {
  it('每个文件都带 .tpl 后缀，且都声明了自己住哪一区', () => {
    const files = listTemplateFiles(TEMPLATE_ROOT)
    expect(files.filter((f) => !f.endsWith('.tpl'))).toEqual([])
    for (const zone of [REPO_ZONE, PKG_ZONE, SITE_ZONE]) {
      expect(files.some((f) => f.startsWith(`${zone}/`)), `${zone}/ 区是空的`).toBe(true)
    }
    // 没声明落点的文件过不了 landRel——模板里长出一棵没人认领的树，建仓当场炸
    for (const file of files) expect(() => landRel(file, 'x')).not.toThrow()
  })

  it('真渲染一套：占位符一个不剩，薄壳根 + 件包的树形都对', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', title: '打招呼', kernelVersion: KERNEL }))
    expect(files.map((f) => f.rel).sort()).toEqual([
      '.gitignore',
      'README.md',
      'package.json',
      'plugins/hello/.oxlintrc.json',
      'plugins/hello/build.ts',
      'plugins/hello/package.json',
      'plugins/hello/src/client/index.tsx',
      'plugins/hello/src/client/styles.css',
      'plugins/hello/src/client/tsconfig.json',
      'plugins/hello/src/index.ts',
      'plugins/hello/tests/artifact.test.ts',
      'plugins/hello/tests/prefix.test.ts',
      'plugins/hello/tsconfig.build.json',
      'plugins/hello/tsconfig.json',
      'plugins/hello/vitest.config.ts',
      'pnpm-workspace.yaml',
    ])
    const shell = JSON.parse(files.find((f) => f.rel === 'package.json')?.text ?? '') as {
      name: string
      private: boolean
      scripts: Record<string, string>
    }
    // 根是薄壳：private、无依赖、build 只递归 plugins/*（fresh 仓没有 packages/，过滤器不带它）
    expect(shell.name).toBe('gwb-hello-workspace')
    expect(shell.private).toBe(true)
    expect(shell.scripts.build).toContain('./plugins/*')
    expect(files.find((f) => f.rel === 'pnpm-workspace.yaml')?.text ?? '').toContain('- plugins/*')

    const pkg = JSON.parse(files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? '') as {
      name: string
      scripts: Record<string, string>
    }
    expect(pkg.name).toBe('@godcreator/gwb-hello')
    // 红线六：漏了 prepublishOnly，publish 会把上一版的 dist/ 原样发出去而且一声不吭
    expect(pkg.scripts.prepublishOnly).toBeDefined()
    expect(pkg.scripts.check).toBeDefined()
    const entry = files.find((f) => f.rel === 'plugins/hello/src/index.ts')?.text ?? ''
    expect(entry).toContain("export const name = 'gwb-hello'")
    for (const file of files) expect(file.text).not.toContain('{{')
  })

  it('renderPlugin 只渲染件包那半：rel 相对件包根，仓半的文件一个都不在', () => {
    const repo = fakeWorkspace()
    const files = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo, kernelVersion: KERNEL }))
    expect(files.length).toBeGreaterThan(0)
    // 仓半不在：根壳、README、workspace 是建仓的事，加件不碰
    expect(files.some((f) => f.rel === 'pnpm-workspace.yaml' || f.rel === 'README.md')).toBe(false)
    expect(files.some((f) => f.rel.startsWith('plugins/'))).toBe(false)
    for (const file of files) expect(file.text).not.toContain('{{')
  })

  it('生成的插件包 peer 里写了内核包 ^<运行命令的内核版本号>：建仓与加插件都一样，发版前检查认', () => {
    const fromScaffold = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const fromPlugin = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), kernelVersion: KERNEL }))
    for (const manifestText of [
      fromScaffold.find((f) => f.rel === 'plugins/hello/package.json')?.text,
      fromPlugin.find((f) => f.rel === 'package.json')?.text,
    ]) {
      const manifest: unknown = JSON.parse(manifestText ?? '')
      const range = declaredKernelRange(manifest)
      expect(range).toBe(`^${KERNEL}`)
      expect(isCaretRange(range ?? '')).toBe(true)
      expect(kernelRangeCovers(range, KERNEL)).toBe(true)
      expect(manifestText).not.toContain('testedKernel')
    }
  })

  it('运行建仓命令的是开发版内核：peer 里的内核包范围只取 x.y.z 三段', () => {
    const files = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), kernelVersion: '0.3.1-dev.202609241500' }))
    const manifest: unknown = JSON.parse(files.find((f) => f.rel === 'package.json')?.text ?? '')
    expect(declaredKernelRange(manifest)).toBe('^0.3.1')
  })

  it('生成的清单按「依赖怎么写」：peer 里有内核包与用到的两个插件；cordis 只在 node 侧按值 import 了 cordis 时才写', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const manifest = JSON.parse(files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? '') as {
      peerDependencies?: Record<string, string>
      devDependencies: Record<string, string>
    }
    const nodeSources = files.filter((f) => f.rel.startsWith('plugins/hello/src/') && !f.rel.startsWith('plugins/hello/src/client/'))
    const importsCordisByValue = nodeSources.some((f) => /^import\s+(?!type\b)[^'"]*from\s*['"]cordis['"]/m.test(f.text))
    const peers = Object.keys(manifest.peerDependencies ?? {}).sort()
    const usedPlugins = ['@godcreator/gwb-commands', '@godcreator/gwb-shell']
    expect(peers).toEqual([KERNEL_PACKAGE, ...usedPlugins, ...(importsCordisByValue ? ['cordis'] : [])].sort())
    // 按值 import 了就 peer 与 dev 各一份：dev 给本地构建与类型检查用
    expect(manifest.devDependencies['cordis']).toBeDefined()
  })

  it('生成的清单：命令总线、外壳写 peer、不写 dev；已停发的 gwb-tokens、gwb-shared-react、gwb-plugin-api 不出现', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const text = files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? ''
    const manifest = JSON.parse(text) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string> }
    for (const pkg of ['@godcreator/gwb-commands', '@godcreator/gwb-shell']) {
      expect(manifest.peerDependencies[pkg], `${pkg} 不在 peer 里`).toMatch(/^\^\d+\.\d+\.\d+$/)
      expect(manifest.devDependencies[pkg], `${pkg} 不该再写 dev`).toBeUndefined()
    }
    for (const retired of ['gwb-tokens', 'gwb-shared-react', 'gwb-plugin-api']) expect(text).not.toContain(retired)
  })

  it('生成的源码从 peer 里的内核包取接口类型', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const nodeEntry = files.find((f) => f.rel === 'plugins/hello/src/index.ts')?.text ?? ''
    expect(nodeEntry).toContain("import type { GwbContext } from '@godcreator/gwb-kernel-desktop'")
  })

  it('生成的 build.ts 不手抄外置名单：从内核包页面入口的 importmap 读键', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const buildScript = files.find((f) => f.rel === 'plugins/hello/build.ts')?.text ?? ''
    expect(buildScript).toContain("import.meta.resolve('@godcreator/gwb-kernel-desktop/package.json')")
    expect(buildScript).toContain("path.join(path.dirname(manifestPath), 'dist', 'index.html')")
    expect(buildScript).toContain('external: importmapNamesOfKernel()')
    // 内核包页面 importmap 里的四个名字，一个都不许以字面量出现在构建脚本里
    for (const name of ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']) {
      expect(buildScript).not.toContain(`'${name}'`)
    }
  })

  it('生成的样式入口从外壳导出的 theme.reference.css 引令牌映射，不再引已停发的 gwb-tokens', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const styles = files.find((f) => f.rel === 'plugins/hello/src/client/styles.css')?.text ?? ''
    const imports = [...styles.replaceAll(/\/\*[\s\S]*?\*\//g, '').matchAll(/^@import '([^']+)'/gm)].map((m) => m[1])
    expect(imports).toContain('@godcreator/gwb-shell/theme.reference.css')
    expect(styles).not.toContain('gwb-tokens')
  })

  it('生成的产物测试：node 侧只放行内置模块、electron 与自己 peer 里的包；浏览器侧只放行内核包页面 importmap 的名字', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const artifactTest = files.find((f) => f.rel === 'plugins/hello/tests/artifact.test.ts')?.text ?? ''
    expect(artifactTest).toContain("spec !== 'electron' && !ownPeers.has(packageNameOf(spec))")
    expect(artifactTest).toContain("ownManifest['peerDependencies']")
    expect(artifactTest).toContain('builtinModules.includes(spec)')
    expect(artifactTest).not.toContain('gwb-plugin-api')
    expect(artifactTest).toContain("resolve('@godcreator/gwb-kernel-desktop/package.json')")
    expect(artifactTest).toContain('bareImportsOf([CLIENT])')
  })

  it('生成的产物测试查颜色类只用主题令牌：色名从外壳的 theme.reference.css 与本插件样式入口读，不手抄名单', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const artifactTest = files.find((f) => f.rel === 'plugins/hello/tests/artifact.test.ts')?.text ?? ''
    expect(artifactTest).toContain("resolve('@godcreator/gwb-shell/theme.reference.css')")
    expect(artifactTest).toContain("path.resolve(here, '../src/client/styles.css')")
    expect(artifactTest).toContain('paletteColorSelectors(')
    // 令牌色名一个都不许以字面量出现：名单只从外壳读
    for (const token of ['muted-foreground', 'primary-foreground', 'destructive']) expect(artifactTest).not.toContain(`'${token}'`)
  })

  it('生成的清单：description 是一句话，不带服务 / skill / 命令计数；dev 里没有已退役的 gwb-repo-kit', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', title: '打招呼', kernelVersion: KERNEL }))
    const text = files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? ''
    const manifest = JSON.parse(text) as { description: string }
    expect(manifest.description.startsWith('打招呼：')).toBe(true)
    expect(manifest.description).not.toMatch(/服务无|skill \d+ 份|命令 \d+ 条/)
    for (const file of files) expect(file.text, file.rel).not.toContain('gwb-repo-kit')
  })

  it('模板里的占位符全在 placeholders 的表上——认不出的当场抛，那正是这条要钉的', () => {
    expect(() => renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false, kernelVersion: KERNEL }))).not.toThrow()
    expect(() => renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'x', repo: fakeWorkspace(), kernelVersion: KERNEL }))).not.toThrow()
  })
})

describe('writeRepo：真写临时目录', () => {
  it('落下去的文件与正文都对', () => {
    // 目标目录本身必须还不存在——建仓与加件都是一次性动作，所以往沙盒里的一个新子目录落
    const dir = path.join(sandbox(), 'repo')
    writeRepo(dir, [
      { rel: 'package.json', text: '{}\n' },
      { rel: 'src/index.ts', text: 'export {}\n' },
    ])
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe('{}\n')
    expect(fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8')).toBe('export {}\n')
  })

  it('目标目录已经存在就拒，不覆盖任何东西', () => {
    const dir = sandbox()
    fs.writeFileSync(path.join(dir, 'keep.txt'), '原有', 'utf8')
    expect(() => writeRepo(dir, [{ rel: 'x', text: 'y' }])).toThrow(/已经存在/)
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('原有')
  })

  it('端到端：薄壳仓里加一件，盘上长出 plugins/world/ 那半', () => {
    const repo = fakeWorkspace()
    const plan = planScaffoldPlugin({ name: 'world', repo, kernelVersion: KERNEL })
    writeRepo(plan.dir, renderPlugin(TEMPLATE_ROOT, plan))
    expect(fs.readFileSync(path.join(repo, 'plugins', 'world', 'package.json'), 'utf8')).toContain('@godcreator/gwb-world')
    // 仓根原样：只有搭仓时写的那份 yaml，件那半没往根上放任何东西
    expect(fs.readdirSync(repo).sort()).toEqual(['plugins', 'pnpm-workspace.yaml'])
  })
})

/** 在临时目录里模拟 `docs-site.create` + `docfirst.attach` 之后的站：六区的配置文件与现状区首页 */
function fakeAttachedSite(repoDir: string): void {
  fs.mkdirSync(path.join(repoDir, 'docs-site', 'content', 'docs'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'docs-site', 'docfirst.config.mjs'), 'export default {}\n', 'utf8')
  fs.writeFileSync(path.join(repoDir, 'docs-site', 'content', 'docs', 'index.mdx'), '---\ntitle: 首页\n---\n\n# 首页\n', 'utf8')
}

describe('插件页', () => {
  it('插件页写出插件名、包名、命令与显示名，占位符一个不剩', () => {
    const plan = planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', title: '打招呼', kernelVersion: KERNEL })
    const page = renderPluginPage(TEMPLATE_ROOT, plan)
    expect(page.rel).toBe('docs-site/content/docs/plugins/hello.mdx')
    for (const identity of ['gwb-hello', '@godcreator/gwb-hello', 'hello.ping', '打招呼']) expect(page.text).toContain(identity)
    expect(page.text).not.toContain('{{')
  })

  it('建仓与加插件都不把插件页混进写仓根或插件包的那批文件', () => {
    const fromScaffold = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))
    const fromPlugin = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), kernelVersion: KERNEL }))
    for (const file of [...fromScaffold, ...fromPlugin]) expect(file.rel).not.toContain('docs-site')
  })

  it('pluginPageTarget：站装好六区（docfirst.config.mjs 在）才给路径；没有站、只有骨架都回 null', () => {
    const repo = fakeWorkspace()
    expect(pluginPageTarget(repo, 'w')).toBeNull()
    fs.mkdirSync(path.join(repo, 'docs-site', 'content', 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'docs-site', 'content', 'docs', 'index.mdx'), '# 骨架\n', 'utf8')
    expect(pluginPageTarget(repo, 'w')).toBeNull()
    fs.writeFileSync(path.join(repo, 'docs-site', 'docfirst.config.mjs'), 'export default {}\n', 'utf8')
    expect(pluginPageTarget(repo, 'w')).toBe(path.join(repo, 'docs-site', 'content', 'docs', 'plugins', 'w.mdx'))
  })

  it('writePluginPage：插件页已经存在就拒，原文不动', () => {
    const repo = fakeWorkspace()
    fakeAttachedSite(repo)
    const target = pluginPageTarget(repo, 'w') ?? ''
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '原有', 'utf8')
    const page = renderPluginPage(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'w', repo, kernelVersion: KERNEL }))
    expect(() => writePluginPage(target, page)).toThrow(/已经存在/)
    expect(fs.readFileSync(target, 'utf8')).toBe('原有')
  })

  it('端到端：往装好六区的仓里加第二个插件，两个插件页都写到现状区的 plugins/ 下', () => {
    const repoDir = path.join(sandbox(), 'repo')
    const plan = planScaffold({ name: 'hello', dir: repoDir, kernelVersion: KERNEL })
    writeRepo(repoDir, renderTemplate(TEMPLATE_ROOT, plan))
    fakeAttachedSite(repoDir)
    writePluginPage(pluginPageTarget(repoDir, plan.name) ?? '', renderPluginPage(TEMPLATE_ROOT, plan))

    const second = planScaffoldPlugin({ name: 'world', repo: repoDir, kernelVersion: KERNEL })
    writeRepo(second.dir, renderPlugin(TEMPLATE_ROOT, second))
    writePluginPage(pluginPageTarget(repoDir, second.name) ?? '', renderPluginPage(TEMPLATE_ROOT, second))

    const docsDir = path.join(repoDir, 'docs-site', 'content', 'docs')
    expect(fs.readdirSync(path.join(docsDir, 'plugins')).sort()).toEqual(['hello.mdx', 'world.mdx'])
  })
})

describe('模板插件的命令登记', () => {
  it('ping 命令的参数形状写在 usage 里，description 只说它做什么', () => {
    const plan = planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', kernelVersion: KERNEL })
    const entry = renderTemplate(TEMPLATE_ROOT, plan).find((f) => f.rel === 'plugins/hello/src/index.ts')?.text ?? ''
    expect(entry).toContain("usage: '无参数'")
    const description = /description: '([^']*)'/.exec(entry)?.[1]
    expect(description).toBeDefined()
    expect(description).not.toContain('无参数')
  })
})

describe('packageRoot：向上找', () => {
  it('从仓里任意一层往上，找到的是仓根', () => {
    expect(packageRoot(path.dirname(fileURLToPath(import.meta.url)))).toBe(path.resolve(TEMPLATE_ROOT, '..'))
  })

  it('一层不落也能找到包根（dist/ 态的样子）', () => {
    const dir = sandbox()
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n', 'utf8')
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    expect(packageRoot(path.join(dir, 'dist'))).toBe(dir)
  })
})

/**
 * 一行里凑齐各种上下文的特殊字符：JSON 与 TS 的引号和反斜杠，MDX 的花括号与尖括号，Markdown 的强调、链接、
 * 表格竖线与标题井号，模板串插值、块注释收尾，以及长得像占位符的一段
 */
const HOSTILE_TITLE = `他说"你好" 'q' \\ {x} {{name}} <b>粗</b> & | # * _ \` ~ [l](u) \${y} */ &amp;`

/** 假元素：MDX 与 JSX 编译出来的调用都落到这个形状上 */
interface FakeElement {
  type: unknown
  props: Record<string, unknown>
}

function isFakeElement(node: unknown): node is FakeElement {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

/** 一棵假元素树里的全部文字，按出现顺序拼起来 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isFakeElement(node)) return textOf(node.props['children'])
  return ''
}

/** 一棵假元素树里 type 为 `tag` 的元素 */
function elementsOf(node: unknown, tag: string): FakeElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => elementsOf(child, tag))
  if (!isFakeElement(node)) return []
  return [...(node.type === tag ? [node] : []), ...elementsOf(node.props['children'], tag)]
}

/** 用 MDX 编译器真编一次（`format: 'md'` 按纯 Markdown 读），回渲染出来的假元素树 */
async function renderMarkdown(text: string, format: 'md' | 'mdx'): Promise<unknown> {
  const jsx = (type: unknown, props: Record<string, unknown>): FakeElement => ({ type, props })
  const module = await evaluate(text, { format, jsx, jsxs: jsx, Fragment: 'fragment', remarkPlugins: [remarkGfm] })
  return (module.default as (props: object) => unknown)({})
}

/** 插件页拆成 frontmatter（YAML）与正文，跟文档站读它的方式一样 */
function splitPage(text: string): { front: unknown; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (match === null) throw new Error('插件页开头没有 frontmatter')
  return { front: YAML.parse(match[1] ?? ''), body: match[2] ?? '' }
}

/** 用 esbuild 把生成的 TS / TSX 编成 CommonJS 再执行，回它的导出。语法不对 esbuild 当场报错 */
async function loadGenerated(
  source: string,
  loader: 'ts' | 'tsx',
  modules: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { code } = await transform(source, {
    loader,
    format: 'cjs',
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    define: { 'import.meta.url': '"file:///D:/x/dist/index.js"' },
  })
  const module = { exports: {} as Record<string, unknown> }
  const requireStub = (spec: string): unknown => {
    if (!(spec in modules)) throw new Error(`生成的代码在运行时 require 了 ${spec}`)
    return modules[spec]
  }
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): FakeElement => ({
    type,
    props: { ...props, children },
  })
  new Function('module', 'exports', 'require', 'h', 'Fragment', code)(module, module.exports, requireStub, h, 'fragment')
  return module.exports
}

describe('title 按所在文件的上下文编码（GWB-25）', () => {
  it('四种编码各自解得回原文：JSON 与 TS 单引号字符串连换行都放得下', () => {
    for (const value of [HOSTILE_TITLE, '第一行\n第二行\r\u2028\u2029']) {
      expect(JSON.parse(`"${jsonStringContent(value)}"`)).toBe(value)
      expect(new Function(`return '${tsSingleQuotedContent(value)}'`)()).toBe(value)
    }
  })

  it('JSX 文本编码：真编一遍 <h1>，文字原样', async () => {
    const exports = await loadGenerated(`export const el = <h1>${jsxTextContent(HOSTILE_TITLE)}</h1>`, 'tsx', {})
    expect(textOf(exports['el'])).toBe(HOSTILE_TITLE)
  })

  it('Markdown 文字编码：标题与 GFM 表格的一格里都原样，表格还是三列', async () => {
    for (const format of ['md', 'mdx'] as const) {
      const tree = await renderMarkdown(
        `# ${markdownTextContent(HOSTILE_TITLE)}\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | ${markdownTextContent(HOSTILE_TITLE)} | 3 |\n`,
        format,
      )
      expect(textOf(elementsOf(tree, 'h1'))).toBe(HOSTILE_TITLE)
      const cells = elementsOf(elementsOf(tree, 'tbody'), 'td')
      expect(cells.map(textOf)).toEqual(['1', HOSTILE_TITLE, '3'])
    }
  })

  it('title 只有一行：换行、制表符、行分隔符都拒，报错里带原文', () => {
    // 两头的空白（含换行）照旧削掉，夹在中间的才拒
    for (const bad of ['一行\n两行', '有\t制表符', '行\u2028分隔', '回\r车']) {
      expect(() => planScaffold({ name: 'x', dir: 'D:\\tmp\\x', title: bad, kernelVersion: KERNEL })).toThrow(/title/)
      expect(() => planScaffoldPlugin({ name: 'x', repo: fakeWorkspace(), title: bad, kernelVersion: KERNEL })).toThrow(/title/)
    }
  })

  describe('整套模板用这个 title 渲染一遍', () => {
    const plan = planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', title: HOSTILE_TITLE, docs: false, kernelVersion: KERNEL })
    const files = renderTemplate(TEMPLATE_ROOT, plan)
    const textOfFile = (rel: string): string => {
      const file = files.find((f) => f.rel === rel)
      if (file === undefined) throw new Error(`没有生成 ${rel}`)
      return file.text
    }

    it('每一份 JSON 都解析得了，title 原样落在 gwb.title 与 description 开头', () => {
      for (const file of files.filter((f) => f.rel.endsWith('.json'))) expect(() => JSON.parse(file.text), file.rel).not.toThrow()
      const manifest = JSON.parse(textOfFile('plugins/hello/package.json')) as { gwb: { title: string }; description: string }
      expect(manifest.gwb.title).toBe(HOSTILE_TITLE)
      expect(manifest.description.startsWith(`${HOSTILE_TITLE}：`)).toBe(true)
      const shell = JSON.parse(textOfFile('package.json')) as { description: string }
      expect(shell.description.startsWith(`${HOSTILE_TITLE} 的 pnpm workspace`)).toBe(true)
    })

    it('pnpm-workspace.yaml 用 yaml 库读得出 plugins/*', () => {
      expect((YAML.parse(textOfFile('pnpm-workspace.yaml')) as { packages: string[] }).packages).toContain(PLUGINS_GLOB)
    })

    it('node 侧入口真执行一次：窗格标题与加载日志里是原样的 title', async () => {
      const exports = await loadGenerated(textOfFile('plugins/hello/src/index.ts'), 'ts', {})
      const logs: string[] = []
      const panes: Array<{ title: string }> = []
      const ctx = {
        logger: () => ({ info: (message: string) => logs.push(message) }),
        gwbShell: { registerPane: (pane: { title: string }) => panes.push(pane) },
        gwbCommands: { register: () => () => {} },
        effect: (fn: () => unknown) => fn(),
      }
      ;(exports['apply'] as (c: typeof ctx) => void)(ctx)
      expect(panes.map((p) => p.title)).toEqual([HOSTILE_TITLE])
      expect(logs).toEqual([`${HOSTILE_TITLE} 已加载`])
    })

    it('浏览器侧窗格真渲染一次：<h1> 的文字是「你好，」加原样的 title', async () => {
      let rendered: unknown
      const exports = await loadGenerated(textOfFile('plugins/hello/src/client/index.tsx'), 'tsx', {
        react: { useState: (initial: unknown) => [initial, () => {}] },
        'react-dom/client': { createRoot: () => ({ render: (el: unknown) => (rendered = el), unmount: () => {} }) },
      })
      ;(exports['mountPane'] as (args: unknown, container: unknown) => unknown)({ pane: { id: 'main', instance: '1' } }, {})
      if (!isFakeElement(rendered)) throw new Error('mountPane 没有渲染任何东西')
      const tree = (rendered.type as () => unknown)()
      expect(textOf(elementsOf(tree, 'h1'))).toBe(`你好，${HOSTILE_TITLE}`)
    })

    it('README 按 Markdown 渲染：一级标题就是原样的 title；不建站那段里的命令参数是合法 JSON', async () => {
      const readme = textOfFile('README.md')
      const tree = await renderMarkdown(readme, 'md')
      expect(textOf(elementsOf(tree, 'h1')[0])).toBe(HOSTILE_TITLE)
      expect(readme).toContain(`docs-site.create ${JSON.stringify({ dir: path.join(plan.dir, 'docs-site'), title: HOSTILE_TITLE })}`)
    })

    it('插件页：frontmatter 的 title 原样，正文按 MDX 编得过，表格那格原样、还是三列', async () => {
      const { front, body } = splitPage(renderPluginPage(TEMPLATE_ROOT, plan).text)
      expect((front as { title: string }).title).toBe(HOSTILE_TITLE)
      const tree = await renderMarkdown(body, 'mdx')
      const paneRow = elementsOf(tree, 'tr').find((row) => textOf(row).includes('标题「'))
      expect(elementsOf(paneRow, 'td').map(textOf)).toEqual(['窗格', 'main', `标题「${HOSTILE_TITLE}」`])
    })

    it('加插件用的是同一套编码', () => {
      const plugin = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), title: HOSTILE_TITLE, kernelVersion: KERNEL }))
      const manifest = JSON.parse(plugin.find((f) => f.rel === 'package.json')?.text ?? '') as { gwb: { title: string } }
      expect(manifest.gwb.title).toBe(HOSTILE_TITLE)
    })
  })

  describe('生成的结构化文件解析不过就拒，一个文件都不写', () => {
    /** 临时目录里搭一份模板：仓根部分一份 JSON、插件包部分一份 */
    function fakeTemplate(files: Record<string, string>): string {
      const root = path.join(sandbox(), 'template')
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
        fs.writeFileSync(path.join(root, rel), text, 'utf8')
      }
      return root
    }

    it('JSON 坏了：renderTemplate 抛错、点名是哪个文件；这时目标目录还不存在', () => {
      const root = fakeTemplate({ 'repo/package.json.tpl': '{"name": {{name}}}\n', 'pkg/package.json.tpl': '{}\n' })
      const dir = path.join(sandbox(), 'repo')
      expect(() => renderTemplate(root, planScaffold({ name: 'x', dir, kernelVersion: KERNEL }))).toThrow(/package\.json.*JSON/)
      expect(fs.existsSync(dir)).toBe(false)
    })

    it('YAML 坏了：同样在渲染时就抛', () => {
      const root = fakeTemplate({ "repo/pnpm-workspace.yaml.tpl": "packages: ['plugins/*'\n", 'pkg/package.json.tpl': '{}\n' })
      expect(() => renderTemplate(root, planScaffold({ name: 'x', dir: 'D:\\tmp\\x', kernelVersion: KERNEL }))).toThrow(/pnpm-workspace\.yaml/)
    })

    it('加插件：插件包里的 JSON 坏了也在渲染时抛', () => {
      const root = fakeTemplate({ 'pkg/package.json.tpl': '{"a": 1,}\n' })
      expect(() => renderPlugin(root, planScaffoldPlugin({ name: 'x', repo: fakeWorkspace(), kernelVersion: KERNEL }))).toThrow(/package\.json/)
    })
  })
})

describe('加插件认 pnpm-workspace.yaml 里各种写法的 plugins/*（GWB-27）', () => {
  const accepted: Array<[string, string]> = [
    ['流式列表带引号', "packages: ['plugins/*', 'packages/*']\n"],
    ['块列表单引号', "packages:\n  - 'plugins/*'\n"],
    ['块列表双引号', 'packages:\n  - "plugins/*"\n'],
    ['块列表不带引号', 'packages:\n  - plugins/*\n  - docs-site\n'],
    ['流式列表不带引号', 'packages: [packages/*, plugins/*]\n'],
  ]
  for (const [label, yaml] of accepted) {
    it(`${label}：收`, () => {
      const repo = fakeWorkspace(yaml)
      expect(planScaffoldPlugin({ name: 'w', repo, kernelVersion: KERNEL }).dir).toBe(path.join(repo, 'plugins', 'w'))
    })
  }

  it('没有 plugins/* 这一条就拒，报错里写出读到的是哪几条', () => {
    for (const yaml of ["packages: ['packages/*', 'docs-site']\n", 'packages:\n  - plugin/*\n']) {
      expect(() => planScaffoldPlugin({ name: 'w', repo: fakeWorkspace(yaml), kernelVersion: KERNEL })).toThrow(/plugins\/\*.*读到的是/)
    }
  })

  it('yaml 读不懂就把读不懂的那一行报出来，不当成「没有 plugins/*」', () => {
    expect(() => planScaffoldPlugin({ name: 'w', repo: fakeWorkspace("packages: ['plugins/*'\n"), kernelVersion: KERNEL })).toThrow(/第 1 行/)
  })

  it('建仓生成的仓，加插件认得出', () => {
    const repoDir = path.join(sandbox(), 'repo')
    writeRepo(repoDir, renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: repoDir, kernelVersion: KERNEL })))
    expect(() => planScaffoldPlugin({ name: 'world', repo: repoDir, kernelVersion: KERNEL })).not.toThrow()
  })
})

describe('路径参数正斜杠、反斜杠都认（09-14 反馈）', () => {
  it('planScaffold：D:/a/b 与 D:\\a\\b 归一成同一个绝对路径', () => {
    const forward = planScaffold({ name: 'x', dir: 'D:/tmp/gwb/x', kernelVersion: KERNEL }).dir
    const backward = planScaffold({ name: 'x', dir: 'D:\\tmp\\gwb\\x', kernelVersion: KERNEL }).dir
    expect(forward).toBe('D:\\tmp\\gwb\\x')
    expect(backward).toBe(forward)
  })

  it('planScaffoldPlugin：repo 用正斜杠写，认得出仓、插件包目录落在同一处', () => {
    const repo = fakeWorkspace()
    const plan = planScaffoldPlugin({ name: 'w', repo: repo.replaceAll('\\', '/'), kernelVersion: KERNEL })
    expect(plan.repoDir).toBe(repo)
    expect(plan.dir).toBe(path.join(repo, 'plugins', 'w'))
  })

  it('回执与 README 里给的命令参数是合法 JSON：Windows 路径的反斜杠转义过，照抄就能用', () => {
    const plan = planScaffold({ name: 'x', dir: 'D:\\tmp\\x', title: '他说"你好"', docs: false, kernelVersion: KERNEL })
    const siteDir = path.join(plan.dir, 'docs-site')
    const create = `docs-site.create ${JSON.stringify({ dir: siteDir, title: plan.title })}`
    expect(placeholders(plan).docsBlock).toContain(create)
    expect(nextSteps(plan).join('\n')).toContain(create)
    for (const step of [...nextSteps(plan), ...nextStepsPlugin(planScaffoldPlugin({ name: 'w', repo: fakeWorkspace(), kernelVersion: KERNEL }), null)]) {
      // 回执里凡是 `命令名 {…}` 的写法，花括号那一段都要是合法 JSON（`<名>` 这种要人替换的占位只出现在字符串里）
      for (const match of step.matchAll(/[a-z-]+(?:\.[a-z-]+)+ (\{[^{}]*(?:\[[^\]]*\])?[^{}]*\})/g)) {
        expect(() => JSON.parse(match[1] ?? ''), `${step}\n里的 ${match[1] ?? ''}`).not.toThrow()
      }
    }
  })
})
