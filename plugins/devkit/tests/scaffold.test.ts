import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NAME_RE,
  PKG_ZONE,
  REPO_ZONE,
  SCOPE,
  landRel,
  listTemplateFiles,
  nextSteps,
  nextStepsPlugin,
  packageRoot,
  placeholders,
  planScaffold,
  planScaffoldPlugin,
  render,
  renderPlugin,
  renderTemplate,
  targetRel,
  writeRepo,
} from '../src/scaffold.js'
import { declaredTestedKernel, testedOnSameKernelLine } from '../src/tested-kernel.js'

/**
 * 建仓与加件的纯机。**落盘那几条真写临时目录**——`writeRepo` 的活就是往盘上放文件，
 * 拿替身测等于没测。`planScaffoldPlugin` 要验仓的形状，也是在临时目录里现搭。
 */

const TEMPLATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template')

/** 运行建仓命令的内核版本号 */
const KERNEL = '0.2.7'

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
    const plan = planScaffold({ name: 'hello-world', dir: 'D:\\tmp\\x', testedKernel: KERNEL })
    expect(plan.name).toBe('hello-world')
    expect(plan.pkg).toBe(`${SCOPE}/gwb-hello-world`)
    expect(plan.pluginName).toBe('gwb-hello-world')
    expect(plan.title).toBe('hello-world')
  })

  it('title 给了就用给的，两头空白削掉；空白串等于没给', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', title: '  打招呼  ', testedKernel: KERNEL }).title).toBe('打招呼')
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', title: '   ', testedKernel: KERNEL }).title).toBe('x')
  })

  it('dir 绝对化：相对路径按当前工作目录算，那不是调用方心里那个「相对谁」', () => {
    expect(path.isAbsolute(planScaffold({ name: 'x', dir: 'tmp/x', testedKernel: KERNEL }).dir)).toBe(true)
  })

  it('短名不合规就拒，报错里带上规则；dir 空着也拒', () => {
    for (const bad of ['', 'Hello', 'hello_world']) {
      expect(() => planScaffold({ name: bad, dir: 'D:\\tmp\\x', testedKernel: KERNEL })).toThrow(/kebab-case/)
    }
    expect(() => planScaffold({ name: 'x', dir: '   ', testedKernel: KERNEL })).toThrow(/dir/)
  })

  it('docs 缺省是建：人记得事后补第二条命令的概率，跟那一堆仓至今没有站是同一个概率', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', testedKernel: KERNEL }).docs).toBe(true)
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false, testedKernel: KERNEL }).docs).toBe(false)
  })

  it('port 不给就是 undefined（本包不猜一个写进 README）；给了要在 1024–65535', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', testedKernel: KERNEL }).port).toBeUndefined()
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: 4321, testedKernel: KERNEL }).port).toBe(4321)
    for (const bad of [80, 70000, 4321.5]) {
      expect(() => planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: bad, testedKernel: KERNEL })).toThrow(/port/)
    }
  })
})

describe('planScaffoldPlugin：往薄壳仓加件', () => {
  it('派生同一套身份，dir 直指 <repo>/plugins/<短名>', () => {
    const repo = fakeWorkspace()
    const plan = planScaffoldPlugin({ name: 'world', repo, title: '第二件', testedKernel: KERNEL })
    expect(plan.pkg).toBe(`${SCOPE}/gwb-world`)
    expect(plan.pluginName).toBe('gwb-world')
    expect(plan.repoDir).toBe(repo)
    expect(plan.dir).toBe(path.join(repo, 'plugins', 'world'))
    expect(plan.title).toBe('第二件')
  })

  it('repo 不在、yaml 不在（老裸根单件仓）、yaml 没有 plugins/ 那条，三种都拒，话里带路', () => {
    expect(() => planScaffoldPlugin({ name: 'x', repo: path.join(sandbox(), 'nope'), testedKernel: KERNEL })).toThrow(/不在/)
    const bare = path.join(sandbox(), 'bare')
    fs.mkdirSync(bare, { recursive: true })
    expect(() => planScaffoldPlugin({ name: 'x', repo: bare, testedKernel: KERNEL })).toThrow(/薄壳 workspace/)
    const noPlugins = fakeWorkspace('packages:\n  - docs-site\n')
    expect(() => planScaffoldPlugin({ name: 'x', repo: noPlugins, testedKernel: KERNEL })).toThrow(/薄壳 workspace/)
    for (const bad of ['', 'Hello', 'x--']) {
      expect(() => planScaffoldPlugin({ name: bad, repo: fakeWorkspace(), testedKernel: KERNEL })).toThrow(/kebab-case/)
    }
    expect(() => planScaffoldPlugin({ name: 'x', repo: '   ', testedKernel: KERNEL })).toThrow(/repo/)
  })
})

describe('docsBlock：README 里讲站的那段', () => {
  it('建了站就讲怎么跑；端口给了才敢写死，没给只说去哪儿看', () => {
    const withPort = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: 4321, testedKernel: KERNEL })).docsBlock ?? ''
    expect(withPort).toContain('cd docs-site')
    expect(withPort).toContain('http://localhost:4321')

    const noPort = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', testedKernel: KERNEL })).docsBlock ?? ''
    expect(noPort).toContain('cd docs-site')
    // 猜一个端口写进 README，读者照着敲的那条 pnpm dev 就是错的
    expect(noPort).not.toMatch(/localhost:\d/)
    expect(noPort).toContain('docs-site/package.json')
  })

  it('没建站就讲怎么补一个——两步，而且点名那两个件的命令', () => {
    const block = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false, testedKernel: KERNEL })).docsBlock ?? ''
    expect(block).not.toContain('cd docs-site')
    expect(block).toContain('docs-site.create')
    expect(block).toContain('docfirst.attach')
    // 旧线的包与命令一个都不许再出现在生成的 README 里
    expect(block).not.toContain('devkit.livedoc')
    expect(block).not.toContain('live-doc-cli')
  })
})

describe('nextSteps：按站真建到哪一步分三支', () => {
  const plan = planScaffold({ name: 'x', dir: 'D:\\tmp\\x', testedKernel: KERNEL })

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
    expect(nextSteps(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false, testedKernel: KERNEL })).join('\n')).toContain(
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

  it('nextStepsPlugin：没有站那半，尾巴是把新件写进 README 与站的正本', () => {
    const repo = fakeWorkspace()
    const steps = nextStepsPlugin(planScaffoldPlugin({ name: 'w', repo, testedKernel: KERNEL })).join('\n')
    expect(steps).toContain('"packages":["plugins/w"]')
    expect(steps).toContain('doc:render')
    expect(steps).not.toContain('docs-site.create')
  })
})

describe('render：占位符', () => {
  const values = { name: 'hello', title: '打招呼', pkg: '@godcreator/gwb-hello', pkgName: 'gwb-hello' }

  it('认得的键替换掉', () => {
    expect(render('{{name}} / {{title}} / {{name}}', values)).toBe('hello / 打招呼 / hello')
  })

  it('认不出的占位符当场抛——留着它会一路活到别人的 package.json 里', () => {
    expect(() => render('{{typo}}', values)).toThrow(/typo/)
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
    expect(() => landRel('src/index.ts.tpl', 'hello')).toThrow(/两区/)
  })
})

describe('包内 template/：两区', () => {
  it('每个文件都带 .tpl 后缀，且都声明了自己住哪一区', () => {
    const files = listTemplateFiles(TEMPLATE_ROOT)
    expect(files.filter((f) => !f.endsWith('.tpl'))).toEqual([])
    for (const zone of [REPO_ZONE, PKG_ZONE]) {
      expect(files.some((f) => f.startsWith(`${zone}/`)), `${zone}/ 区是空的`).toBe(true)
    }
    // 没声明落点的文件过不了 landRel——模板里长出一棵没人认领的树，建仓当场炸
    for (const file of files) expect(() => landRel(file, 'x')).not.toThrow()
  })

  it('真渲染一套：占位符一个不剩，薄壳根 + 件包的树形都对', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', title: '打招呼', testedKernel: KERNEL }))
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
      'plugins/hello/tests/plugin.test.ts',
      'plugins/hello/tests/prefix.test.ts',
      'plugins/hello/tests/self-report.test.ts',
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
    const files = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo, testedKernel: KERNEL }))
    expect(files.length).toBeGreaterThan(0)
    // 仓半不在：根壳、README、workspace 是建仓的事，加件不碰
    expect(files.some((f) => f.rel === 'pnpm-workspace.yaml' || f.rel === 'README.md')).toBe(false)
    expect(files.some((f) => f.rel.startsWith('plugins/'))).toBe(false)
    for (const file of files) expect(file.text).not.toContain('{{')
  })

  it('生成的插件包写了 gwb.testedKernel：建仓与加插件都是运行命令的那个内核的版本号，发版前检查认', () => {
    const fromScaffold = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', testedKernel: KERNEL }))
    const fromPlugin = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), testedKernel: KERNEL }))
    for (const manifestText of [
      fromScaffold.find((f) => f.rel === 'plugins/hello/package.json')?.text,
      fromPlugin.find((f) => f.rel === 'package.json')?.text,
    ]) {
      const manifest: unknown = JSON.parse(manifestText ?? '')
      expect(declaredTestedKernel(manifest)).toBe(KERNEL)
      expect(testedOnSameKernelLine(declaredTestedKernel(manifest), KERNEL)).toBe(true)
    }
  })

  it('生成的清单按「依赖怎么写」：peer 只可能是 cordis，且只在 node 侧按值 import 了 cordis 时才写', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', testedKernel: KERNEL }))
    const manifest = JSON.parse(files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? '') as {
      peerDependencies?: Record<string, string>
      devDependencies: Record<string, string>
    }
    const nodeSources = files.filter((f) => f.rel.startsWith('plugins/hello/src/') && !f.rel.startsWith('plugins/hello/src/client/'))
    const importsCordisByValue = nodeSources.some((f) => /^import\s+(?!type\b)[^'"]*from\s*['"]cordis['"]/m.test(f.text))
    const peers = Object.keys(manifest.peerDependencies ?? {})
    expect(peers).toEqual(importsCordisByValue ? ['cordis'] : [])
    // 按值 import 了就 peer 与 dev 各一份：dev 给本地构建与类型检查用
    expect(manifest.devDependencies['cordis']).toBeDefined()
  })

  it('生成的清单：词汇表包、命令总线、外壳写 dev；已停发的 gwb-tokens、gwb-shared-react 不出现', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', testedKernel: KERNEL }))
    const text = files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? ''
    const manifest = JSON.parse(text) as { devDependencies: Record<string, string> }
    for (const pkg of ['@godcreator/gwb-plugin-api', '@godcreator/gwb-commands', '@godcreator/gwb-shell']) {
      expect(manifest.devDependencies[pkg], `${pkg} 不在 dev 里`).toBeDefined()
    }
    for (const retired of ['gwb-tokens', 'gwb-shared-react']) expect(text).not.toContain(retired)
  })

  it('生成的清单里词汇表包的版本与 devkit 自己的 dev 写法一致', () => {
    const devkitManifest = JSON.parse(fs.readFileSync(path.resolve(TEMPLATE_ROOT, '..', 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', testedKernel: KERNEL }))
    const manifest = JSON.parse(files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? '') as {
      devDependencies: Record<string, string>
    }
    const vocabulary = '@godcreator/gwb-plugin-api'
    expect(manifest.devDependencies[vocabulary]).toBe(devkitManifest.devDependencies[vocabulary])
  })

  it('生成的自述检查把 docsDir 指到仓根文档站的现状区，inject 那一条不会因为找不到站而跳过', () => {
    const repoDir = path.join(sandbox(), 'repo')
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: repoDir, testedKernel: KERNEL }))
    const selfReport = files.find((f) => f.rel === 'plugins/hello/tests/self-report.test.ts')?.text ?? ''
    const docsDirArg = /docsDir: path\.resolve\(here, '([^']+)'\)/.exec(selfReport)?.[1]
    expect(docsDirArg, 'self-report.test.ts 里没有给 docsDir').toBeDefined()
    const testsDir = path.join(repoDir, 'plugins', 'hello', 'tests')
    expect(path.resolve(testsDir, docsDirArg ?? '')).toBe(path.join(repoDir, 'docs-site', 'content', 'docs'))
  })

  it('模板里的占位符全在 placeholders 的表上——认不出的当场抛，那正是这条要钉的', () => {
    expect(() => renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false, testedKernel: KERNEL }))).not.toThrow()
    expect(() => renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'x', repo: fakeWorkspace(), testedKernel: KERNEL }))).not.toThrow()
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
    const plan = planScaffoldPlugin({ name: 'world', repo, testedKernel: KERNEL })
    writeRepo(plan.dir, renderPlugin(TEMPLATE_ROOT, plan))
    expect(fs.readFileSync(path.join(repo, 'plugins', 'world', 'package.json'), 'utf8')).toContain('@godcreator/gwb-world')
    // 仓根原样：只有搭仓时写的那份 yaml，件那半没往根上放任何东西
    expect(fs.readdirSync(repo).sort()).toEqual(['plugins', 'pnpm-workspace.yaml'])
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
