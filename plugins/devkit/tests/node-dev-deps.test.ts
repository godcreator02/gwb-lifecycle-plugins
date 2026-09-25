import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { distManifest, registryPinArgs, withPublishRegistry, workspaceRootOf, workspaceVersions } from '../src/node-dev-deps.js'

/**
 * `node-dev-deps.ts` 的其余部分是读写磁盘、启动进程，不进单元测试；`distManifest` 与 `workspaceRootOf` 不是：
 * 它们决定发布内容与开发版包文件里每一条依赖写什么版本号。写错的后果是「新插件配旧库」——装得上、能运行、
 * 不报错，最难查。所以单独测
 */

/** 一份典型的工作区清单：同仓兄弟用 workspace:，外来包用普通范围 */
const MANIFEST = {
  name: '@godcreator/gwb-fake',
  version: '0.3.1',
  files: ['dist'],
  scripts: { build: 'tsc', test: 'vitest run' },
  dependencies: {
    '@godcreator/gwb-sibling': 'workspace:^',
    'yaml': '^2.8.0',
  },
  peerDependencies: {
    '@godcreator/gwb-plugin-api': 'workspace:^',
  },
  devDependencies: { typescript: '^7.0.2' },
  gwb: { title: '假的' },
} as const

/** 正式版：同一次发的包写 `^新版本号` */
const SIBLINGS = { '@godcreator/gwb-sibling': '^0.4.0' }
const WORKSPACE = new Map([
  ['@godcreator/gwb-sibling', '0.3.9'],
  ['@godcreator/gwb-plugin-api', '0.1.0'],
])

describe('分发清单', () => {
  it('版本号换成这次的，scripts 与 devDependencies 删掉，别的字段原样带过去', () => {
    const out = distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE)
    expect(out.version).toBe('0.4.0')
    expect(out.scripts).toBeUndefined()
    expect(out.devDependencies).toBeUndefined()
    expect(out.gwb).toEqual({ title: '假的' })
    expect(out.name).toBe('@godcreator/gwb-fake')
  })

  it('不改入参那份清单——仓里的 package.json 一个字都不动', () => {
    distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE)
    expect(MANIFEST.version).toBe('0.3.1')
    expect(MANIFEST.scripts).toEqual({ build: 'tsc', test: 'vitest run' })
    expect(MANIFEST.devDependencies).toEqual({ typescript: '^7.0.2' })
  })

  it('正式版给的是 ^ 范围，原样写进去——消费方跟得上破坏边界以内的后续版本', () => {
    const out = distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE)
    expect(out.dependencies?.['@godcreator/gwb-sibling']).toBe('^0.4.0')
  })

  it('开发版打包不给同一次的写法：workspace: 换成 ^<工作区里的版本号>；工作区里没有就 ^0.0.0', () => {
    const out = distManifest(
      { ...MANIFEST, dependencies: { '@godcreator/gwb-sibling': 'workspace:^', '@godcreator/gwb-stranger': 'workspace:*' } },
      '0.4.1-dev.20260913120000',
      {},
      WORKSPACE,
    )
    expect(out.dependencies?.['@godcreator/gwb-sibling']).toBe('^0.3.9')
    expect(out.dependencies?.['@godcreator/gwb-stranger']).toBe('^0.0.0')
  })

  it('普通范围原样写，不是本仓的包不改', () => {
    const out = distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE)
    expect(out.dependencies?.['yaml']).toBe('^2.8.0')
  })

  it('peer 不写同一次发的写法——peer 的意思是「你自己带一个」；workspace: 照样换成工作区里的版本号', () => {
    const out = distManifest(
      { ...MANIFEST, peerDependencies: { '@godcreator/gwb-sibling': 'workspace:^', '@godcreator/gwb-plugin-api': '>=0.1.0' } },
      '0.4.0',
      SIBLINGS,
      WORKSPACE,
    )
    expect(out.peerDependencies?.['@godcreator/gwb-sibling']).toBe('^0.3.9')
    expect(out.peerDependencies?.['@godcreator/gwb-plugin-api']).toBe('>=0.1.0')
  })
})

describe('发布目标写进发布内容的清单，查源时钉住那个源（GWB-17）', () => {
  const LOCAL = 'http://localhost:9999/'

  it('withPublishRegistry：publishConfig.registry 换成发布目标，publishConfig 的别的字段原样；入参那份不改', () => {
    const source = { ...MANIFEST, publishConfig: { access: 'public', registry: 'https://old.example.com/' } }
    const out = withPublishRegistry(source, LOCAL)
    expect(out.publishConfig).toEqual({ access: 'public', registry: LOCAL })
    expect(source.publishConfig.registry).toBe('https://old.example.com/')
    expect(withPublishRegistry(MANIFEST, LOCAL).publishConfig).toEqual({ registry: LOCAL })
  })

  it('registryPinArgs：带范围的包名用 --config.<范围>:registry——pnpm 12 的 --registry 盖不过 .npmrc 的范围行；不带范围的用 --registry', () => {
    expect(registryPinArgs('@someone/gwb-x@0.1.0', LOCAL)).toEqual([`--config.@someone:registry=${LOCAL}`])
    expect(registryPinArgs('@someone/gwb-x', LOCAL)).toEqual([`--config.@someone:registry=${LOCAL}`])
    expect(registryPinArgs('gwb-x@0.1.0', LOCAL)).toEqual(['--registry', LOCAL])
  })
})

describe('workspaceRootOf：从包目录往上找工作区根', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** 临时目录里搭一个工作区：插件在 plugins/a，被它依赖的库在 packages/lib */
  function workspaceWithPluginAndLib(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ws-'))
    made.push(root)
    const writeJson = (rel: string, value: unknown): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), JSON.stringify(value))
    }
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'plugins/*'\n  - 'packages/*'\n")
    writeJson('package.json', { name: 'ws-root', version: '0.0.0', private: true })
    writeJson('plugins/a/package.json', { name: '@x/a', version: '0.1.0', dependencies: { '@x/lib': 'workspace:*' } })
    writeJson('packages/lib/package.json', { name: '@x/lib', version: '0.4.2' })
    return root
  }

  it('包在 plugins/<名>/ 时，根是有 pnpm-workspace.yaml 的那层，packages/ 下的号找得到', () => {
    const root = workspaceWithPluginAndLib()
    const found = workspaceRootOf(path.join(root, 'plugins', 'a'))
    expect(found).toBe(root)
    expect(workspaceVersions(found).get('@x/lib')).toBe('0.4.2')
  })

  it('包目录自己有 pnpm-workspace.yaml 时就是它自己', () => {
    const root = workspaceWithPluginAndLib()
    expect(workspaceRootOf(root)).toBe(root)
  })

  it('一路往上都没有 pnpm-workspace.yaml：报错', () => {
    const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-lonely-'))
    made.push(lonely)
    expect(() => workspaceRootOf(lonely)).toThrow(/pnpm-workspace\.yaml/)
  })
})
