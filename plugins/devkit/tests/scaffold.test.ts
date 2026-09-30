import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import {
  COMMANDS_PACKAGE,
  homePeerVersions,
  NAME_RE,
  type PeerVersions,
  PKG_ZONE,
  SHELL_PACKAGE,
  PLUGINS_GLOB,
  REPO_ZONE,
  landRel,
  listTemplateFiles,
  nextSteps,
  nextStepsPlugin,
  packageRoot,
  planScaffold,
  planScaffoldPlugin,
  render,
  renderPlugin,
  renderTemplate,
  targetRel,
  writeRepo,
} from '../src/scaffold.js'
import { TEAM_REGISTRY, TEAM_SCOPE } from '../src/vocab.js'
import { KERNEL_PACKAGE, isCaretRange } from '@godcreator/gwb-plugin-manager'

/**
 * 建仓与加插件的纯逻辑。**写磁盘的那几条真的写临时目录**——`writeRepo` 做的就是往磁盘上写文件，
 * 用替身测等于没测。`planScaffoldPlugin` 要检查仓的形状，也是在临时目录里现建一个仓。
 */

const TEMPLATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template')

/** 运行建仓命令的内核版本号 */
const KERNEL = '0.3.0'

/** 运行建仓命令的 home：正在运行的内核与装着的命令总线、外壳 */
const PEERS: PeerVersions = { kernel: KERNEL, commands: '0.5.2', shell: '0.14.1' }

const sandboxes: string[] = []
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-scaffold-'))
  sandboxes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 生成的包清单里 peer 写的内核包范围；没写是 undefined */
function kernelPeerOf(manifestText: string | undefined): string | undefined {
  const manifest = JSON.parse(manifestText ?? '') as { peerDependencies?: Record<string, string> }
  return manifest.peerDependencies?.[KERNEL_PACKAGE]
}

/** 临时目录里搭一个 workspace 仓（pnpm-workspace.yaml 带 plugins/ 那条） */
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
  it('短名派生出包名与插件名；计划里没有显示名，也没有建不建站', () => {
    const plan = planScaffold({ name: 'hello-world', dir: 'D:\\tmp\\x', peerVersions: PEERS })
    expect(plan.name).toBe('hello-world')
    expect(plan.pkg).toBe(`${TEAM_SCOPE}/gwb-hello-world`)
    expect(plan.pluginName).toBe('gwb-hello-world')
    expect(plan).not.toHaveProperty('title')
    expect(plan).not.toHaveProperty('docs')
  })

  it('dir 绝对化：相对路径按当前工作目录算，那不是调用方心里那个「相对谁」', () => {
    expect(path.isAbsolute(planScaffold({ name: 'x', dir: 'tmp/x', peerVersions: PEERS }).dir)).toBe(true)
  })

  it('短名不合规就拒，报错里带上规则；dir 空着也拒', () => {
    for (const bad of ['', 'Hello', 'hello_world']) {
      expect(() => planScaffold({ name: bad, dir: 'D:\\tmp\\x', peerVersions: PEERS })).toThrow(/kebab-case/)
    }
    expect(() => planScaffold({ name: 'x', dir: '   ', peerVersions: PEERS })).toThrow(/dir/)
  })

})

describe('planScaffoldPlugin：往 workspace 仓加插件', () => {
  it('派生同一套身份，dir 直指 <repo>/plugins/<短名>', () => {
    const repo = fakeWorkspace()
    const plan = planScaffoldPlugin({ name: 'world', repo, peerVersions: PEERS })
    expect(plan.pkg).toBe(`${TEAM_SCOPE}/gwb-world`)
    expect(plan.pluginName).toBe('gwb-world')
    expect(plan.repoDir).toBe(repo)
    expect(plan.dir).toBe(path.join(repo, 'plugins', 'world'))
    expect(plan).not.toHaveProperty('title')
  })

  it('repo 不在、yaml 不在、yaml 的 packages 里没有 plugins/*，三种都拒', () => {
    expect(() => planScaffoldPlugin({ name: 'x', repo: path.join(sandbox(), 'nope'), peerVersions: PEERS })).toThrow(/不在/)
    const bare = path.join(sandbox(), 'bare')
    fs.mkdirSync(bare, { recursive: true })
    expect(() => planScaffoldPlugin({ name: 'x', repo: bare, peerVersions: PEERS })).toThrow(/不是 workspace 仓/)
    const noPlugins = fakeWorkspace('packages:\n  - docs-site\n')
    expect(() => planScaffoldPlugin({ name: 'x', repo: noPlugins, peerVersions: PEERS })).toThrow(/不是 workspace 仓/)
    for (const bad of ['', 'Hello', 'x--']) {
      expect(() => planScaffoldPlugin({ name: bad, repo: fakeWorkspace(), peerVersions: PEERS })).toThrow(/kebab-case/)
    }
    expect(() => planScaffoldPlugin({ name: 'x', repo: '   ', peerVersions: PEERS })).toThrow(/repo/)
  })
})

describe('包名范围与发布目标（GWB-17）', () => {
  const SOMEONE = '@someone'
  const LOCAL = 'http://localhost:9999/'

  /** 生成的插件包清单：建仓时在 plugins/<短名>/，加插件时在插件包根 */
  function manifestOf(files: Array<{ rel: string; text: string }>, rel: string): { name: string; publishConfig?: { registry?: unknown } } {
    return JSON.parse(files.find((f) => f.rel === rel)?.text ?? '') as { name: string; publishConfig?: { registry?: unknown } }
  }

  it('不给 scope、registry：包名在团队范围下，publishConfig.registry 写团队源', () => {
    const plan = planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS })
    expect(plan.pkg).toBe(`${TEAM_SCOPE}/gwb-hello`)
    expect(plan.registry).toBe(TEAM_REGISTRY)
    const manifest = manifestOf(renderTemplate(TEMPLATE_ROOT, plan), 'plugins/hello/package.json')
    expect(manifest.publishConfig?.registry).toBe(TEAM_REGISTRY)
  })

  it('给了 scope、registry：包名 <scope>/gwb-<短名>，publishConfig.registry 是给的地址；建仓与加插件一样', () => {
    const plan = planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', scope: SOMEONE, registry: LOCAL, peerVersions: PEERS })
    expect(plan.pkg).toBe('@someone/gwb-hello')
    const fromScaffold = manifestOf(renderTemplate(TEMPLATE_ROOT, plan), 'plugins/hello/package.json')
    expect(fromScaffold).toMatchObject({ name: '@someone/gwb-hello', publishConfig: { registry: LOCAL } })

    const second = planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), scope: SOMEONE, registry: LOCAL, peerVersions: PEERS })
    expect(second.pkg).toBe('@someone/gwb-world')
    expect(second.registry).toBe(LOCAL)
    expect(manifestOf(renderPlugin(TEMPLATE_ROOT, second), 'package.json')).toMatchObject({ name: '@someone/gwb-world', publishConfig: { registry: LOCAL } })
  })

  it('README、回执里的包名跟着 scope 走；内核包与模板用到的两个插件仍是团队范围', () => {
    const plan = planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', scope: SOMEONE, registry: LOCAL, peerVersions: PEERS })
    const files = renderTemplate(TEMPLATE_ROOT, plan)
    expect(files.find((f) => f.rel === 'README.md')?.text).toContain('`@someone/gwb-hello`')
    expect(nextSteps(plan).join('\n')).toContain('@someone/gwb-hello')
    const manifest = JSON.parse(files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? '') as { peerDependencies: Record<string, string> }
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual([KERNEL_PACKAGE, `${TEAM_SCOPE}/gwb-commands`, `${TEAM_SCOPE}/gwb-shell`].sort())
  })

  it('scope 不是 @ 开头的合法 npm 范围：拒，报错里带原文，不修正', () => {
    for (const bad of ['someone', '@', '@Someone', '@.x', '@_x', '@x/y', ' @x', '@x ', '@中文', '']) {
      expect(() => planScaffold({ name: 'x', dir: 'D:\\tmp\\x', scope: bad, peerVersions: PEERS }), JSON.stringify(bad)).toThrow(
        `scope 要是 @ 开头的 npm 范围`,
      )
      expect(() => planScaffoldPlugin({ name: 'x', repo: fakeWorkspace(), scope: bad, peerVersions: PEERS }), JSON.stringify(bad)).toThrow(/scope/)
    }
    for (const good of ['@someone', '@a1', '@my-org', '@x.y', '@x_y']) {
      expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', scope: good, peerVersions: PEERS }).pkg).toBe(`${good}/gwb-x`)
    }
  })

  it('registry 不是 http(s) 地址、不是规范写法、带账号或查询串：拒，报错里带原文，不修正', () => {
    const rejected: Array<[string, RegExp]> = [
      ['', /registry 要是 http\(s\) 地址/],
      ['localhost:9999', /registry 要是 http\(s\) 地址/],
      ['not a url', /registry 要是 http\(s\) 地址/],
      ['ftp://host/', /registry 要是 http\(s\) 地址/],
      ['http://localhost:9999', /规范写法 "http:\/\/localhost:9999\/"/],
      ['HTTP://Host/npm/', /规范写法 "http:\/\/host\/npm\/"/],
      ['http://user:pass@host/', /不许带账号、查询串或 #/],
      ['http://host/?a=1', /不许带账号、查询串或 #/],
      ['http://host/#x', /不许带账号、查询串或 #/],
    ]
    for (const [bad, why] of rejected) {
      expect(() => planScaffold({ name: 'x', dir: 'D:\\tmp\\x', registry: bad, peerVersions: PEERS }), JSON.stringify(bad)).toThrow(why)
      expect(() => planScaffoldPlugin({ name: 'x', repo: fakeWorkspace(), registry: bad, peerVersions: PEERS }), JSON.stringify(bad)).toThrow(why)
    }
    for (const good of ['http://localhost:9999/', 'https://npm.example.com/api/packages/me/npm/']) {
      expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', registry: good, peerVersions: PEERS }).registry).toBe(good)
    }
  })
})

describe('nextSteps：只写这次建仓特有的，流程指向说明书', () => {
  const plan = planScaffold({ name: 'x', dir: 'D:\\tmp\\x', peerVersions: PEERS })

  it('报仓的路径、包名，指向说明书 gwb-devkit 的「新写一个插件」，devkit.dev 的 packages 指到 plugins/ 下', () => {
    const steps = nextSteps(plan).join('\n')
    expect(steps).toContain('D:\\tmp\\x')
    expect(steps).toContain('@godcreator/gwb-x')
    expect(steps).toContain('gwb-devkit')
    expect(steps).toContain('新写一个插件')
    expect(steps).toContain('"packages":["plugins/x"]')
  })

  it('流程不在回执里复述，也不提文档站：没有装包、发版、构建那几步，没有建站的命令与插件页', () => {
    const steps = nextSteps(plan).join('\n')
    for (const gone of ['pnpm install', 'pnpm build', 'devkit.release', 'plugin-manager.install', 'devkit.cdp', 'docs-site', 'docfirst', '插件页']) {
      expect(steps, gone).not.toContain(gone)
    }
  })

  it('nextStepsPlugin：报插件包路径与包名；README 的插件清单由人补；不提文档站与插件页', () => {
    const repo = fakeWorkspace()
    const plan = planScaffoldPlugin({ name: 'w', repo, peerVersions: PEERS })
    const steps = nextStepsPlugin(plan).join('\n')
    expect(steps).toContain(plan.dir)
    expect(steps).toContain('@godcreator/gwb-w')
    expect(steps).toContain('"packages":["plugins/w"]')
    expect(steps).toContain('新写一个插件')
    expect(steps).toContain('README')
    for (const gone of ['plugin-manager.install', 'docs-site', 'docfirst', '插件页']) expect(steps, gone).not.toContain(gone)
  })
})

describe('render：占位符', () => {
  const values = { name: 'hello', pkg: '@godcreator/gwb-hello', pkgName: 'gwb-hello' }

  it('认得的键替换掉', () => {
    expect(render('{{name}} / {{pkgName}} / {{name}}', values, 'README.md')).toBe('hello / gwb-hello / hello')
  })

  it('认不出的占位符当场抛——留着它会一路活到别人的 package.json 里；显示名的占位符 {{title}} 已经没有了', () => {
    expect(() => render('{{typo}}', values, 'README.md')).toThrow(/typo/)
    expect(() => render('{{title}}', values, 'README.md')).toThrow(/README\.md.*title/)
  })

  it('值里带着占位符的样子也不会被再替换一次', () => {
    expect(render('{{pkg}}', { ...values, pkg: '{{name}}' }, 'x.ts')).toBe('{{name}}')
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
    expect(() => landRel('src/index.ts.tpl', 'hello')).toThrow(/不属于任何部分/)
    expect(() => landRel('site/plugin.mdx.tpl', 'hello')).toThrow(/不属于任何部分/)
  })
})

describe('包内 template/：两部分', () => {
  it('每个文件都带 .tpl 后缀，且都声明了自己属于哪一部分；只有 repo/ 与 pkg/ 两部分', () => {
    const files = listTemplateFiles(TEMPLATE_ROOT)
    expect(files.filter((f) => !f.endsWith('.tpl'))).toEqual([])
    for (const zone of [REPO_ZONE, PKG_ZONE]) {
      expect(files.some((f) => f.startsWith(`${zone}/`)), `${zone}/ 这部分是空的`).toBe(true)
    }
    expect(files.filter((f) => !f.startsWith(`${REPO_ZONE}/`) && !f.startsWith(`${PKG_ZONE}/`))).toEqual([])
    // 没声明落点的文件过不了 landRel——模板里长出一棵没人认领的树，建仓当场报错
    for (const file of files) expect(() => landRel(file, 'x')).not.toThrow()
  })

  it('真渲染一套：占位符一个不剩，仓根 + 插件包的树形都对', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    expect(files.map((f) => f.rel).sort()).toEqual([
      '.gitignore',
      'README.md',
      'package.json',
      'plugins/hello/.oxlintrc.json',
      'plugins/hello/build.ts',
      'plugins/hello/components.json',
      'plugins/hello/package.json',
      'plugins/hello/src/client/index.tsx',
      'plugins/hello/src/client/styles.css',
      'plugins/hello/src/client/tsconfig.json',
      'plugins/hello/src/index.ts',
      'plugins/hello/tsconfig.json',
      'pnpm-workspace.yaml',
    ])
    const shell = JSON.parse(files.find((f) => f.rel === 'package.json')?.text ?? '') as {
      name: string
      private: boolean
      scripts: Record<string, string>
    }
    // 仓根是 private 包：无依赖、build 只递归 plugins/*（fresh 仓没有 packages/，过滤器不带它）
    expect(shell.name).toBe('gwb-hello-workspace')
    expect(shell.private).toBe(true)
    expect(shell.scripts.build).toContain('./plugins/*')
    expect(files.find((f) => f.rel === 'pnpm-workspace.yaml')?.text ?? '').toContain('- plugins/*')

    const pkg = JSON.parse(files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? '') as {
      name: string
      scripts: Record<string, string>
    }
    expect(pkg.name).toBe('@godcreator/gwb-hello')
    // 发版只走 devkit.release，它自己先构建；没有手工 pnpm publish 这条路，也就不要 prepublishOnly
    expect(pkg.scripts.prepublishOnly).toBeUndefined()
    expect(pkg.scripts.check).toBeDefined()
    const entry = files.find((f) => f.rel === 'plugins/hello/src/index.ts')?.text ?? ''
    expect(entry).toContain("export const name = 'gwb-hello'")
    for (const file of files) expect(file.text).not.toContain('{{')
  })

  it('renderPlugin 只渲染件包那半：rel 相对件包根，仓半的文件一个都不在', () => {
    const repo = fakeWorkspace()
    const files = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo, peerVersions: PEERS }))
    expect(files.length).toBeGreaterThan(0)
    // 仓半不在：根壳、README、workspace 是建仓的事，加件不碰
    expect(files.some((f) => f.rel === 'pnpm-workspace.yaml' || f.rel === 'README.md')).toBe(false)
    expect(files.some((f) => f.rel.startsWith('plugins/'))).toBe(false)
    for (const file of files) expect(file.text).not.toContain('{{')
  })

  it('生成的插件包 peer 里写了内核包 ^<运行命令的内核版本号>：建仓与加插件都一样，发版前检查认', () => {
    const fromScaffold = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const fromPlugin = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), peerVersions: PEERS }))
    for (const manifestText of [
      fromScaffold.find((f) => f.rel === 'plugins/hello/package.json')?.text,
      fromPlugin.find((f) => f.rel === 'package.json')?.text,
    ]) {
      const range = kernelPeerOf(manifestText)
      expect(range).toBe(`^${KERNEL}`)
      expect(isCaretRange(range ?? '')).toBe(true)
    }
  })

  it('运行建仓命令的内核与 home 里装的是开发版：peer 里的范围都只取 x.y.z 三段', () => {
    const devPeers = { kernel: '0.3.1-dev.202609241500', commands: '0.5.3-dev.202609241500', shell: '0.14.2-dev.202609241500' }
    const files = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), peerVersions: devPeers }))
    const manifestText = files.find((f) => f.rel === 'package.json')?.text
    expect(kernelPeerOf(manifestText)).toBe('^0.3.1')
    const peers = (JSON.parse(manifestText ?? '') as { peerDependencies: Record<string, string> }).peerDependencies
    expect(peers[COMMANDS_PACKAGE]).toBe('^0.5.3')
    expect(peers[SHELL_PACKAGE]).toBe('^0.14.2')
  })

  it('命令总线与外壳的 peer 范围是 ^<建仓那个 home 里装着的版本>，模板里不写死：建仓与加插件都一样', () => {
    const fromScaffold = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const fromPlugin = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), peerVersions: PEERS }))
    for (const manifestText of [
      fromScaffold.find((f) => f.rel === 'plugins/hello/package.json')?.text,
      fromPlugin.find((f) => f.rel === 'package.json')?.text,
    ]) {
      const peers = (JSON.parse(manifestText ?? '') as { peerDependencies: Record<string, string> }).peerDependencies
      expect(peers[COMMANDS_PACKAGE]).toBe(`^${PEERS.commands}`)
      expect(peers[SHELL_PACKAGE]).toBe(`^${PEERS.shell}`)
    }
    const templateManifest = fs.readFileSync(path.join(TEMPLATE_ROOT, PKG_ZONE, 'package.json.tpl'), 'utf8')
    expect(templateManifest).toContain('"@godcreator/gwb-commands": "^{{commandsVersion}}"')
    expect(templateManifest).toContain('"@godcreator/gwb-shell": "^{{shellVersion}}"')
  })

  it('生成的清单按「依赖怎么写」：peer 里有内核包与用到的两个插件；cordis 只在 node 侧按值 import 了 cordis 时才写', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
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

  it('生成的清单：命令总线、外壳写 peer、不写 dev', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const text = files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? ''
    const manifest = JSON.parse(text) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string> }
    for (const pkg of ['@godcreator/gwb-commands', '@godcreator/gwb-shell']) {
      expect(manifest.peerDependencies[pkg], `${pkg} 不在 peer 里`).toMatch(/^\^\d+\.\d+\.\d+$/)
      expect(manifest.devDependencies[pkg], `${pkg} 不该再写 dev`).toBeUndefined()
    }
  })

  it('生成的源码从 peer 里的内核包取接口类型', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const nodeEntry = files.find((f) => f.rel === 'plugins/hello/src/index.ts')?.text ?? ''
    expect(nodeEntry).toContain("import type { GwbContext } from '@godcreator/gwb-kernel-desktop'")
  })

  it('生成的 build.ts 从提供方代码出口读外置名单', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const buildScript = files.find((f) => f.rel === 'plugins/hello/build.ts')?.text ?? ''
    expect(buildScript).toContain("import { browserImports } from '@godcreator/gwb-shell/browser-imports'")
    expect(buildScript).not.toContain('dist/index.html')
    expect(buildScript).toContain('external: Object.keys(browserImports())')
    // 提供方决定名字，模板不维护另一份名单
    for (const name of ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']) {
      expect(buildScript).not.toContain(`'${name}'`)
    }
  })

  it('生成的样式入口从外壳导出的 theme.reference.css 引令牌映射', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const styles = files.find((f) => f.rel === 'plugins/hello/src/client/styles.css')?.text ?? ''
    const imports = [...styles.replaceAll(/\/\*[\s\S]*?\*\//g, '').matchAll(/^@import '([^']+)'/gm)].map((m) => m[1])
    expect(imports).toContain('@godcreator/gwb-shell/theme.reference.css')
  })

  it('模板不带测试文件：产物与样式的检查由 devkit.dev / devkit.release 做，复制进各仓的副本不会跟着更新', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    expect(files.filter((f) => f.rel.includes('/tests/'))).toEqual([])
    const manifest = JSON.parse(files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? '') as { devDependencies: Record<string, string> }
    expect(manifest.devDependencies['@tailwindcss/node']).toBeUndefined()
  })

  it('node 侧也用 esbuild 打成一个文件：外置 peer、electron 与 cordis；不输出类型声明', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const text = (rel: string): string => files.find((f) => f.rel === rel)?.text ?? ''
    const buildScript = text('plugins/hello/build.ts')
    expect(buildScript).toContain("entryPoints: ['src/index.ts']")
    expect(buildScript).toContain('external: nodeSideExternals()')
    expect(buildScript).toContain("['electron', 'cordis', ...peers]")
    // 模板插件不提供服务，没有别的插件要 import type 它，不出 .d.ts
    const manifest = JSON.parse(text('plugins/hello/package.json')) as { exports: Record<string, unknown>; scripts: Record<string, string> }
    expect(manifest.exports['.']).toBe('./dist/index.js')
    expect(manifest.scripts['build']).not.toContain('tsc')
    expect(files.some((f) => f.rel.endsWith('tsconfig.build.json'))).toBe(false)
    // 关掉 verbatimModuleSyntax，esbuild 才会去掉只引类型的 import，不需要「只写 import type」这条规矩
    for (const rel of ['plugins/hello/tsconfig.json', 'plugins/hello/src/client/tsconfig.json']) expect(text(rel), rel).not.toContain('verbatimModuleSyntax')
  })

  it('生成的清单只写有人读的字段：keywords 只有 gwb-plugin，files 只有 dist，exports 只有 "."，没有 author 与 engines', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const manifest = JSON.parse(files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? '') as Record<string, unknown>
    expect(manifest['keywords']).toEqual(['gwb-plugin'])
    expect(manifest['files']).toEqual(['dist'])
    expect(Object.keys(manifest['exports'] as Record<string, unknown>)).toEqual(['.'])
    expect(manifest).not.toHaveProperty('author')
    expect(manifest).not.toHaveProperty('engines')
  })

  it('生成的清单：description 是一句话，不带服务 / skill / 命令计数；dev 里没有已退役的 gwb-repo-kit', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const text = files.find((f) => f.rel === 'plugins/hello/package.json')?.text ?? ''
    const manifest = JSON.parse(text) as { description: string }
    expect(manifest.description.startsWith('hello：')).toBe(true)
    expect(manifest.description).not.toMatch(/服务无|skill \d+ 份|命令 \d+ 条/)
    for (const file of files) expect(file.text, file.rel).not.toContain('gwb-repo-kit')
  })

  it('生成的插件包：清单里没有 gwb 字段；测试不分快慢标签（没有 test:all、不带 --tags-filter）；oxlint 不替仓根忽略 docs-site 与 .claude', () => {
    const files = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), peerVersions: PEERS }))
    const text = (rel: string): string => files.find((f) => f.rel === rel)?.text ?? ''
    const manifest = JSON.parse(text('package.json')) as { gwb?: unknown; scripts: Record<string, string> }
    expect(manifest.gwb).toBeUndefined()
    expect(manifest.scripts['test:all']).toBeUndefined()
    expect(manifest.scripts['test']).not.toContain('--tags-filter')
    const ignored = (JSON.parse(text('.oxlintrc.json')) as { ignorePatterns: string[] }).ignorePatterns
    expect(ignored).not.toContain('docs-site/**')
    expect(ignored).not.toContain('.claude/**')
  })

  it('生成的每份 package.json 在任何一层都没有 // 开头的说明键：JSON 没有注释，这类键没有工具读、会随包发出去', () => {
    const fromScaffold = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const fromPlugin = renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), peerVersions: PEERS }))
    const manifests = [...fromScaffold, ...fromPlugin].filter((f) => path.basename(f.rel) === 'package.json')
    expect(manifests.map((f) => f.rel).sort()).toEqual(['package.json', 'package.json', 'plugins/hello/package.json'])
    const commentKeysOf = (value: unknown): string[] =>
      value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, child]) => [...(key.startsWith('//') ? [key] : []), ...commentKeysOf(child)])
        : []
    for (const manifest of manifests) expect(commentKeysOf(JSON.parse(manifest.text)), manifest.rel).toEqual([])
  })

  it('模板里的占位符全在 placeholders 的表上——认不出的当场抛，那正是这条要守的', () => {
    expect(() => renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'x', dir: 'D:\\tmp\\x', peerVersions: PEERS }))).not.toThrow()
    expect(() => renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'x', repo: fakeWorkspace(), peerVersions: PEERS }))).not.toThrow()
  })

  it('要显示名的地方用短名：README 标题、仓根与插件包的 description、窗格标题、加载日志、窗格里的问候', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello-world', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const text = (rel: string): string => files.find((f) => f.rel === rel)?.text ?? ''
    expect(text('README.md').split('\n')[0]).toBe('# hello-world')
    expect((JSON.parse(text('package.json')) as { description: string }).description.startsWith('hello-world 的 pnpm workspace')).toBe(true)
    expect((JSON.parse(text('plugins/hello-world/package.json')) as { description: string }).description.startsWith('hello-world：')).toBe(true)
    const entry = text('plugins/hello-world/src/index.ts')
    expect(entry).toContain("title: 'hello-world'")
    expect(entry).toContain("log.info('hello-world 已加载')")
    expect(text('plugins/hello-world/src/client/index.tsx')).toContain('你好，hello-world</h1>')
  })

  it('建仓不带文档站的任何东西：没有 docs-site 下的文件，仓根清单与 .gitignore 不提 docs-site，README 没有讲文档站的那一节', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    for (const file of files) {
      expect(file.rel, file.rel).not.toContain('docs-site')
      for (const gone of ['docs-site.create', 'docfirst.attach']) expect(file.text, file.rel).not.toContain(gone)
    }
    const text = (rel: string): string => files.find((f) => f.rel === rel)?.text ?? ''
    for (const rel of ['package.json', '.gitignore']) expect(text(rel), rel).not.toContain('docs-site')
    expect(text('README.md')).not.toContain('## 文档站')
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
    const plan = planScaffoldPlugin({ name: 'world', repo, peerVersions: PEERS })
    writeRepo(plan.dir, renderPlugin(TEMPLATE_ROOT, plan))
    expect(fs.readFileSync(path.join(repo, 'plugins', 'world', 'package.json'), 'utf8')).toContain('@godcreator/gwb-world')
    // 仓根原样：只有搭仓时写的那份 yaml，件那半没往根上放任何东西
    expect(fs.readdirSync(repo).sort()).toEqual(['plugins', 'pnpm-workspace.yaml'])
  })
})

describe('模板插件的命令登记', () => {
  it('ping 命令的参数形状写在 usage 里，description 只说它做什么', () => {
    const plan = planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS })
    const entry = renderTemplate(TEMPLATE_ROOT, plan).find((f) => f.rel === 'plugins/hello/src/index.ts')?.text ?? ''
    expect(entry).toContain("usage: '无参数'")
    const description = /description: '([^']*)'/.exec(entry)?.[1]
    expect(description).toBeDefined()
    expect(description).not.toContain('无参数')
  })

  it('不写 plugin 字段：命令总线 0.5.0 起从调用方取包名', () => {
    const plan = planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS })
    const entry = renderTemplate(TEMPLATE_ROOT, plan).find((f) => f.rel === 'plugins/hello/src/index.ts')?.text ?? ''
    expect(entry).not.toMatch(/^\s*plugin:/m)
  })
})

describe('模板的窗格入口', () => {
  it('PaneArgs 与 PaneHandle 从外壳的 @godcreator/gwb-shell/pane 取，不手写形状', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    const client = files.find((f) => f.rel === 'plugins/hello/src/client/index.tsx')?.text ?? ''
    expect(client).toContain("import type { PaneArgs, PaneHandle } from '@godcreator/gwb-shell/pane'")
    expect(client).not.toMatch(/^interface PaneArgs/m)
  })
})

describe('模板接好 shadcn：组件文件由建仓命令调官方 CLI 添加，模板只带配置', () => {
  const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello-world', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
  const text = (rel: string): string => files.find((f) => f.rel === rel)?.text ?? ''

  it('components.json：new-york、zinc，tailwind.prefix 与样式入口 prefix(…) 是同一个前缀，样式入口指向 src/client/styles.css', () => {
    const config = JSON.parse(text('plugins/hello-world/components.json')) as {
      style: string
      rsc: boolean
      tsx: boolean
      tailwind: { config: string; css: string; baseColor: string; cssVariables: boolean; prefix: string }
      aliases: Record<string, string>
      iconLibrary: string
    }
    expect(config).toMatchObject({ style: 'new-york', rsc: false, tsx: true, iconLibrary: 'lucide' })
    expect(config.tailwind).toEqual({ config: '', css: 'src/client/styles.css', baseColor: 'zinc', cssVariables: true, prefix: 'helloworld' })
    expect(config.aliases).toEqual({ components: '@/components', ui: '@/components/ui', lib: '@/lib', utils: '@/lib/utils' })
    expect(text(`plugins/hello-world/${config.tailwind.css}`)).toContain(`prefix(${config.tailwind.prefix})`)
  })

  it('@/ 别名三处都指向 src/client：包根 tsconfig（CLI 按它放组件）、浏览器侧 tsconfig（类型检查）、build.ts 的 esbuild alias（打包）；不写 baseUrl', () => {
    const rootPaths = (JSON.parse(text('plugins/hello-world/tsconfig.json')) as { compilerOptions: { paths: Record<string, string[]>; baseUrl?: string } }).compilerOptions
    expect(rootPaths.paths).toEqual({ '@/*': ['./src/client/*'] })
    expect(rootPaths.baseUrl).toBeUndefined()
    const clientPaths = (JSON.parse(text('plugins/hello-world/src/client/tsconfig.json')) as { compilerOptions: { paths: Record<string, string[]>; baseUrl?: string } }).compilerOptions
    expect(clientPaths.paths).toEqual({ '@/*': ['./*'] })
    expect(clientPaths.baseUrl).toBeUndefined()
    expect(text('plugins/hello-world/build.ts')).toContain("alias: { '@': path.join(here, 'src', 'client') }")
  })

  it('示例窗格用官方 Button，不手写 <button> / <input>；模板里不带组件文件，清单里没有 dependencies（有的都是 CLI 写的，建仓命令整体挪进 dev）', () => {
    const client = text('plugins/hello-world/src/client/index.tsx')
    expect(client).toContain("import { Button } from '@/components/ui/button'")
    expect(client).toContain('<Button')
    expect(client).not.toMatch(/<(button|input)\b/)
    expect(files.filter((f) => f.rel.includes('/components/'))).toEqual([])
    expect(JSON.parse(text('plugins/hello-world/package.json'))).not.toHaveProperty('dependencies')
  })
})

describe('homePeerVersions：从运行建仓命令的 home 读版本号', () => {
  /** 临时目录里搭一个 home：node_modules 下按包名放清单 */
  function fakeHome(versions: Record<string, string>): string {
    const home = sandbox()
    for (const [pkg, version] of Object.entries(versions)) {
      const dir = path.join(home, 'node_modules', ...pkg.split('/'))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version }), 'utf8')
    }
    return home
  }

  it('内核取正在运行的版本号，命令总线与外壳读 home 里装着的', () => {
    const home = fakeHome({ [COMMANDS_PACKAGE]: '0.5.2', [SHELL_PACKAGE]: '0.14.1' })
    expect(homePeerVersions(home, '0.7.1')).toEqual({ kernel: '0.7.1', commands: '0.5.2', shell: '0.14.1' })
  })

  it('home 里没装外壳：拒，报错写出包名与读的是哪个文件', () => {
    const home = fakeHome({ [COMMANDS_PACKAGE]: '0.5.2' })
    expect(() => homePeerVersions(home, '0.7.1')).toThrow(`没装 ${SHELL_PACKAGE}`)
    expect(() => homePeerVersions(home, '0.7.1')).toThrow(path.join(home, 'node_modules', '@godcreator', 'gwb-shell', 'package.json'))
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

  it('一直找到盘根都没有 package.json 就抛', () => {
    expect(() => packageRoot(path.parse(sandbox()).root)).toThrow(/package\.json/)
  })
})

describe('生成的结构化文件都读得懂：模板是本包自己的，由这里核对，运行时不再读一遍', () => {
  /** JSON 与 YAML 整份解析；读不懂的回文件名与原因 */
  function unreadableFiles(files: Array<{ rel: string; text: string }>): string[] {
    const problems: string[] = []
    for (const { rel, text } of files) {
      const extension = path.extname(rel)
      try {
        if (extension === '.json') JSON.parse(text)
        else if (extension === '.yaml' || extension === '.yml') {
          const [error] = YAML.parseDocument(text).errors
          if (error !== undefined) throw error
        }
      } catch (err) {
        problems.push(`${rel}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return problems
  }

  it('建仓与加插件生成的 JSON、YAML 都解析得了；pnpm-workspace.yaml 读得出 plugins/*', () => {
    const scaffold = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', peerVersions: PEERS }))
    expect(unreadableFiles(scaffold)).toEqual([])
    expect(unreadableFiles(renderPlugin(TEMPLATE_ROOT, planScaffoldPlugin({ name: 'world', repo: fakeWorkspace(), peerVersions: PEERS })))).toEqual([])
    const workspace = scaffold.find((f) => f.rel === 'pnpm-workspace.yaml')?.text ?? ''
    expect((YAML.parse(workspace) as { packages: string[] }).packages).toContain(PLUGINS_GLOB)
  })

  it('核对本身认得出坏文件：JSON、YAML', () => {
    expect(
      unreadableFiles([
        { rel: 'a.json', text: '{"a": 1,}' },
        { rel: 'b.yaml', text: "packages: ['plugins/*'\n" },
        { rel: 'c.json', text: '{"a": 1}' },
      ]).map((line) => line.split('：')[0]),
    ).toEqual(['a.json', 'b.yaml'])
  })
})
describe('加插件认 pnpm-workspace.yaml 里各种写法的 plugins/*（GWB-27）', () => {
  const accepted: Array<[string, string]> = [
    ['流式列表带引号', "packages: ['plugins/*', 'packages/*']\n"],
    ['块列表单引号', "packages:\n  - 'plugins/*'\n"],
    ['块列表双引号', 'packages:\n  - "plugins/*"\n'],
    ['块列表不带引号', 'packages:\n  - plugins/*\n  - docs-site\n'],
    ['块列表的短横线与键同一缩进', 'packages:\n- plugins/*\n- docs-site\n'],
    ['流式列表不带引号', 'packages: [packages/*, plugins/*]\n'],
    ['流式列表不带引号、两头有空格', 'packages: [ plugins/* , packages/* ]\n'],
    ['流式列表跨行、带尾逗号', "packages: [\n  'plugins/*',\n  \"packages/*\",\n]\n"],
    ['带注释、别的键有嵌套映射与带引号的键', "# 头注\npackages:\n  # 插件\n  - plugins/* # 行尾注释\n  - docs-site\n\nallowBuilds:\n  '@parcel/watcher': false\n  esbuild: true\n"],
    ['CRLF 换行', 'packages:\r\n  - plugins/*\r\n'],
    ['别的键是跨行的流式映射', 'overrides: {\n  a: 1,\n  b: 2\n}\npackages: [plugins/*]\n'],
    ['别的键是块标量', 'note: |\n  第一行\n  第二行\npackages:\n  - plugins/*\n'],
    ['开头有 --- 文档标记', '---\npackages:\n  - plugins/*\n'],
    ['带锚点', 'packages:\n  - &p plugins/*\n'],
    ['顶层整体缩进', '  packages:\n  - plugins/*\n'],
  ]
  for (const [label, yaml] of accepted) {
    it(`${label}：收`, () => {
      const repo = fakeWorkspace(yaml)
      expect(planScaffoldPlugin({ name: 'w', repo, peerVersions: PEERS }).dir).toBe(path.join(repo, 'plugins', 'w'))
    })
  }

  it('没有 plugins/* 这一条就拒，报错里写出读到的是哪几条（引号与转义已经解开）', () => {
    const rejected: Array<[string, string]> = [
      ["packages: ['packages/*', 'docs-site']\n", '["packages/*","docs-site"]'],
      ['packages:\n  - plugin/*\n', '["plugin/*"]'],
      ["packages:\n  - 'it''s/*'\n", `["it's/*"]`],
      ['packages:\n  - "a\\\\b/*"\n', '["a\\\\b/*"]'],
      ['packages:\n  - "\\x41"\n', '["A"]'],
    ]
    for (const [yaml, found] of rejected) {
      expect(() => planScaffoldPlugin({ name: 'w', repo: fakeWorkspace(yaml), peerVersions: PEERS }), JSON.stringify(yaml)).toThrow(
        `${PLUGINS_GLOB} 这一条（读到的是 ${found}）`,
      )
    }
  })

  it('没有 packages 这个键、或文件是空的，报原来那句「没有 packages」', () => {
    for (const yaml of ['allowBuilds:\n  esbuild: true\n', '']) {
      expect(() => planScaffoldPlugin({ name: 'w', repo: fakeWorkspace(yaml), peerVersions: PEERS }), JSON.stringify(yaml)).toThrow(
        /不是 workspace 仓.*没有 pnpm-workspace\.yaml 或里面没有 packages/,
      )
    }
  })

  it('YAML 写坏了、或 packages 不是字符串列表，报错写出文件与第几行第几列，不当成「没有 plugins/*」', () => {
    const unreadable: Array<[string, RegExp]> = [
      ["packages: ['plugins/*'\n", /第 2 行第 1 列不是合法的 YAML/],
      ["packages:\n  - 'plugins/*\n", /第 3 行第 1 列不是合法的 YAML/],
      ['packages:\n    - plugins/*\n  - docs-site\n', /第 3 行第 1 列不是合法的 YAML/],
      ['packages: plugins/*\n', /第 1 行第 11 列：packages 要是列表/],
      ['packages: {a: 1}\n', /第 1 行第 11 列：packages 要是列表/],
      ['packages:\n  foo: bar\n', /第 2 行第 3 列：packages 要是列表/],
      ['packages:\n', /第 1 行第 10 列：packages 要是列表/],
      ['packages:\n  - [plugins/*]\n', /第 2 行第 5 列：packages 的每一项要是一条字符串/],
      ['packages:\n  - a: b\n', /第 2 行第 5 列：packages 的每一项要是一条字符串/],
      ['packages:\n  -\n', /第 2 行第 4 列：packages 的每一项要是一条字符串/],
      ['packages: [a: b]\n', /第 1 行第 12 列：packages 的每一项要是一条字符串/],
      ['- plugins/*\n', /第 1 行第 1 列：顶层要是「键: 值」/],
    ]
    for (const [yaml, why] of unreadable) {
      const repo = fakeWorkspace(yaml)
      const file = path.join(repo, 'pnpm-workspace.yaml')
      expect(() => planScaffoldPlugin({ name: 'w', repo, peerVersions: PEERS }), JSON.stringify(yaml)).toThrow(why)
      expect(() => planScaffoldPlugin({ name: 'w', repo, peerVersions: PEERS }), JSON.stringify(yaml)).toThrow(file)
    }
  })

  it('建仓生成的仓，加插件认得出', () => {
    const repoDir = path.join(sandbox(), 'repo')
    writeRepo(repoDir, renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: repoDir, peerVersions: PEERS })))
    expect(() => planScaffoldPlugin({ name: 'world', repo: repoDir, peerVersions: PEERS })).not.toThrow()
  })
})

describe('路径参数正斜杠、反斜杠都认（09-14 反馈）', () => {
  it('planScaffold：D:/a/b 与 D:\\a\\b 归一成同一个绝对路径', () => {
    const forward = planScaffold({ name: 'x', dir: 'D:/tmp/gwb/x', peerVersions: PEERS }).dir
    const backward = planScaffold({ name: 'x', dir: 'D:\\tmp\\gwb\\x', peerVersions: PEERS }).dir
    expect(forward).toBe('D:\\tmp\\gwb\\x')
    expect(backward).toBe(forward)
  })

  it('planScaffoldPlugin：repo 用正斜杠写，认得出仓、插件包目录落在同一处', () => {
    const repo = fakeWorkspace()
    const plan = planScaffoldPlugin({ name: 'w', repo: repo.replaceAll('\\', '/'), peerVersions: PEERS })
    expect(plan.repoDir).toBe(repo)
    expect(plan.dir).toBe(path.join(repo, 'plugins', 'w'))
  })

  it('回执里给的命令参数是合法 JSON：Windows 路径的反斜杠转义过，照抄就能用', () => {
    const plan = planScaffold({ name: 'x', dir: 'D:\\tmp\\x', peerVersions: PEERS })
    expect(nextSteps(plan).join('\n')).toContain(JSON.stringify({ home: '<隔离 home 名>', dir: 'D:\\tmp\\x', packages: ['plugins/x'] }))
    for (const step of [...nextSteps(plan), ...nextStepsPlugin(planScaffoldPlugin({ name: 'w', repo: fakeWorkspace(), peerVersions: PEERS }))]) {
      // 回执里凡是 `命令名 {…}` 的写法，花括号那一段都要是合法 JSON（`<名>` 这种要人替换的占位只出现在字符串里）
      for (const match of step.matchAll(/[a-z-]+(?:\.[a-z-]+)+ (\{[^{}]*(?:\[[^\]]*\])?[^{}]*\})/g)) {
        expect(() => JSON.parse(match[1] ?? ''), `${step}\n里的 ${match[1] ?? ''}`).not.toThrow()
      }
    }
  })
})
