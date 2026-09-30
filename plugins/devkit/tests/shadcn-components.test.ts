import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { planScaffoldPlugin, renderPlugin, writeRepo, type PeerVersions } from '../src/scaffold.js'
import {
  addTemplateComponents,
  componentDependencyProblems,
  componentsStepFailure,
  COMPONENTS_UI_DIR,
  devDependencySpecs,
  importedPackagesOf,
  shadcnAddArgs,
  TEMPLATE_COMPONENTS,
} from '../src/shadcn-components.js'
import { BUTTON_IMPORTS, CLI_DEPENDENCIES, fakePnpm } from './fake-shadcn-pnpm.js'

/**
 * 建仓与加插件写完文件后添加 shadcn 组件那一步。插件包真的由模板渲染、写进临时目录；pnpm 换成照实测样子改清单的假 pnpm
 * （tests/fake-shadcn-pnpm.ts），不联网
 */

const TEMPLATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template')
const PEERS: PeerVersions = { kernel: '0.10.1', commands: '0.5.9', shell: '0.15.6' }

const sandboxes: string[] = []
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 临时 workspace 仓里按模板生成一个插件包，回插件包目录 */
function generatedPluginDir(name = 'hello'): string {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-shadcn-')), 'repo')
  sandboxes.push(path.dirname(repo))
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
  const plan = planScaffoldPlugin({ name, repo, peerVersions: PEERS })
  writeRepo(plan.dir, renderPlugin(TEMPLATE_ROOT, plan))
  return plan.dir
}

function manifestOf(pluginDir: string): { dependencies?: Record<string, string>; devDependencies: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies: Record<string, string> }
}

describe('shadcnAddArgs', () => {
  it('经 pnpm dlx 调官方 CLI 的 latest，带 --yes 跳过确认；模板只加 button', () => {
    expect(TEMPLATE_COMPONENTS).toEqual(['button'])
    expect(shadcnAddArgs(TEMPLATE_COMPONENTS)).toEqual(['dlx', 'shadcn@latest', 'add', 'button', '--yes'])
  })
})

describe('importedPackagesOf：组件按包名 import 了哪些包', () => {
  it('实测 button.tsx 的 import 读出四个包', () => {
    expect(importedPackagesOf(BUTTON_IMPORTS)).toEqual(['class-variance-authority', 'cn', 'radix-ui', 'react'])
  })

  it('相对路径、@/ 别名、node: 不算；子路径归到包名；跨行 import、export … from、只为副作用的 import 都认', () => {
    const source = [
      'import { cn } from "@/lib/utils"',
      "import { x } from './x'",
      "import fs from 'node:fs'",
      'import {',
      '  DropdownMenu as Primitive,',
      '} from "radix-ui"',
      'import { ChevronDown } from "lucide-react/icons"',
      'import "@scope/pkg/styles.css"',
      'export * from "cmdk"',
    ].join('\n')
    expect(importedPackagesOf(source)).toEqual(['@scope/pkg', 'cmdk', 'lucide-react', 'radix-ui'])
  })

  it('组件正文里的字符串不当成 import：export function 的括号挡住，JSX 属性里的 from 也不算', () => {
    const source = ['export function Tip({ label }) {', '  return <p title="data from \'x\'">{label}</p>', '}', 'export { Tip }'].join('\n')
    expect(importedPackagesOf(source)).toEqual([])
  })
})

describe('devDependencySpecs 与 componentDependencyProblems', () => {
  it('dependencies 里的带原范围挪去 dev；组件 import 了、三张表都没有的补上；dev 与 peer 里已有的不动', () => {
    const manifest = { dependencies: { 'radix-ui': '^1.6.7', cn: '^0.4.0' }, devDependencies: { react: '19.2.8' }, peerDependencies: { '@godcreator/gwb-shell': '^0.15.6' } }
    const imported = ['@godcreator/gwb-shell', 'class-variance-authority', 'cn', 'radix-ui', 'react']
    expect(devDependencySpecs(manifest, imported)).toEqual(['cn@^0.4.0', 'radix-ui@^1.6.7', 'class-variance-authority'])
    expect(devDependencySpecs({ devDependencies: { cn: '^0.4.0' } }, ['cn'])).toEqual([])
  })

  it('还在 dependencies 里的、组件 import 了却不在 dev 与 peer 里的，逐条报', () => {
    expect(componentDependencyProblems({ dependencies: { cn: '^0.4.0' }, devDependencies: { react: '19.2.8' } }, ['cn', 'react'])).toEqual([
      'cn 还在 dependencies 里，要在 devDependencies',
      '组件 import 了 cn，devDependencies 里没有',
    ])
    expect(componentDependencyProblems({ devDependencies: { cn: '^0.4.0', react: '19.2.8' } }, ['cn', 'react'])).toEqual([])
  })

  it('清单的依赖表不是「包名: 范围」就抛', () => {
    expect(() => devDependencySpecs({ dependencies: ['cn'] }, [])).toThrow(/dependencies 不是/)
    expect(() => devDependencySpecs('x', [])).toThrow(/不是一个对象/)
  })
})

describe('addTemplateComponents：在模板生成的插件包里真走一遍（假 pnpm）', () => {
  it('先 dlx 加组件，再一次 add -D 把 CLI 写进 dependencies 的与漏装的都放进 dev；button.tsx 在 src/client/components/ui/', async () => {
    const pluginDir = generatedPluginDir()
    expect(manifestOf(pluginDir).dependencies).toBeUndefined()
    const fake = fakePnpm(pluginDir)
    expect(await addTemplateComponents(pluginDir, fake.pnpm)).toEqual({ ok: true, components: ['button'] })
    expect(fake.calls).toEqual([
      ['dlx', 'shadcn@latest', 'add', 'button', '--yes'],
      ['add', '-D', `cn@${CLI_DEPENDENCIES.cn}`, `radix-ui@${CLI_DEPENDENCIES['radix-ui']}`, 'class-variance-authority'],
    ])
    expect(fs.existsSync(path.join(pluginDir, COMPONENTS_UI_DIR, 'button.tsx'))).toBe(true)
    const manifest = manifestOf(pluginDir)
    expect(manifest.dependencies).toBeUndefined()
    for (const name of ['cn', 'radix-ui', 'class-variance-authority', 'react']) expect(manifest.devDependencies[name], name).toBeDefined()
  })

  it('CLI 没成：回它输出的最后几行，不再调 add -D', async () => {
    const pluginDir = generatedPluginDir()
    const fake = fakePnpm(pluginDir, { cliFails: 'ERR_PNPM_FETCH 连不上 registry.npmjs.org' })
    const outcome = await addTemplateComponents(pluginDir, fake.pnpm)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.error).toContain('pnpm dlx shadcn@latest add button --yes 没成')
    expect(!outcome.ok && outcome.error).toContain('ERR_PNPM_FETCH 连不上 registry.npmjs.org')
    expect(fake.calls).toHaveLength(1)
  })

  it('CLI 报成功、组件文件却不在约定位置：拒，指向 components.json 与 @/ 别名', async () => {
    const pluginDir = generatedPluginDir()
    const outcome = await addTemplateComponents(pluginDir, fakePnpm(pluginDir, { cliWritesNothing: true }).pnpm)
    expect(!outcome.ok && outcome.error).toContain(path.join(pluginDir, COMPONENTS_UI_DIR, 'button.tsx'))
    expect(!outcome.ok && outcome.error).toContain('@/ 别名')
  })

  it('add -D 报成功、清单却没变：拒，逐条写出哪个包放错了地方', async () => {
    const pluginDir = generatedPluginDir()
    const outcome = await addTemplateComponents(pluginDir, fakePnpm(pluginDir, { addDevDoesNothing: true }).pnpm)
    expect(!outcome.ok && outcome.error).toContain('cn 还在 dependencies 里')
    expect(!outcome.ok && outcome.error).toContain('组件 import 了 class-variance-authority，devDependencies 里没有')
  })

  it('没成时的回执：说插件文件已写好，给出补完要运行的命令', () => {
    const text = componentsStepFailure('D:\\r\\plugins\\x', '原因')
    expect(text).toContain('插件文件已写到 D:\\r\\plugins\\x')
    expect(text).toContain('原因')
    expect(text).toContain('pnpm dlx shadcn@latest add button --yes')
    expect(text).toContain('gwb-shell')
  })
})
