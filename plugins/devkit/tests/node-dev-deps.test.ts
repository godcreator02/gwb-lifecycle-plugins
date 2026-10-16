import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  distManifest,
  installRegistryFromConfig,
  publishedFromView,
  registryPinArgs,
  unsupportedFileEntries,
  withPublishRegistry,
  workspaceCatalogs,
  workspaceCatalogsFromYaml,
  workspaceRootOf,
  workspaceVersions,
} from '../src/node-dev-deps.js'

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

const WORKSPACE_YAML = 'D:/repo/pnpm-workspace.yaml'
/** 默认 catalog 写外来包，具名 catalog `gwb-host` 写工作台带的那几样 */
const CATALOGS = workspaceCatalogsFromYaml(
  [
    'packages:',
    "  - 'plugins/*'",
    'catalog:',
    '  vitefu: ^1.1.1',
    "  '@godcreator/gwb-commands': ^0.6.1",
    'catalogs:',
    '  gwb-host:',
    '    react: 19.2.0',
    "    '@types/node': ^24.0.0",
  ].join('\n'),
  WORKSPACE_YAML,
)

describe('分发清单', () => {
  it('版本号换成这次的，scripts 与 devDependencies 删掉，别的字段原样带过去', () => {
    const out = distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE, CATALOGS)
    expect(out.version).toBe('0.4.0')
    expect(out.scripts).toBeUndefined()
    expect(out.devDependencies).toBeUndefined()
    expect(out.gwb).toEqual({ title: '假的' })
    expect(out.name).toBe('@godcreator/gwb-fake')
  })

  it('不改入参那份清单——仓里的 package.json 一个字都不动', () => {
    distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE, CATALOGS)
    expect(MANIFEST.version).toBe('0.3.1')
    expect(MANIFEST.scripts).toEqual({ build: 'tsc', test: 'vitest run' })
    expect(MANIFEST.devDependencies).toEqual({ typescript: '^7.0.2' })
  })

  it('正式版给的是 ^ 范围，原样写进去——消费方跟得上破坏边界以内的后续版本', () => {
    const out = distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE, CATALOGS)
    expect(out.dependencies?.['@godcreator/gwb-sibling']).toBe('^0.4.0')
  })

  it('开发版打包不给同一次的写法：workspace: 换成 ^<工作区里的版本号>', () => {
    const out = distManifest({ ...MANIFEST, dependencies: { '@godcreator/gwb-sibling': 'workspace:^' } }, '0.4.1-dev.20260913120000', {}, WORKSPACE, CATALOGS)
    expect(out.dependencies?.['@godcreator/gwb-sibling']).toBe('^0.3.9')
  })

  it('workspace: 依赖在工作区里找不到：直接抛，点名是哪个包，不写 ^0.0.0', () => {
    expect(() => distManifest({ ...MANIFEST, dependencies: { '@godcreator/gwb-stranger': 'workspace:*' } }, '0.4.0', {}, WORKSPACE, CATALOGS)).toThrow(
      '@godcreator/gwb-stranger',
    )
  })

  it('普通范围原样写，不是本仓的包不改', () => {
    const out = distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE, CATALOGS)
    expect(out.dependencies?.['yaml']).toBe('^2.8.0')
  })

  it('peer 不写同一次发的写法——peer 的意思是「你自己带一个」；workspace: 照样换成工作区里的版本号', () => {
    const out = distManifest(
      { ...MANIFEST, peerDependencies: { '@godcreator/gwb-sibling': 'workspace:^', '@godcreator/gwb-plugin-api': '>=0.1.0' } },
      '0.4.0',
      SIBLINGS,
      WORKSPACE,
      CATALOGS,
    )
    expect(out.peerDependencies?.['@godcreator/gwb-sibling']).toBe('^0.3.9')
    expect(out.peerDependencies?.['@godcreator/gwb-plugin-api']).toBe('>=0.1.0')
  })
})

describe('catalog: 依赖换成工作区 catalog 里的范围', () => {
  /** 只在 dependencies 或 peer 里写 catalog: 的清单，其余字段同 MANIFEST */
  const withRanges = (dependencies: Record<string, string>, peerDependencies: Record<string, string> = {}) => ({ ...MANIFEST, dependencies, peerDependencies })

  it('catalog: 与 catalog:default 取顶层 catalog 里同名包的范围', () => {
    const out = distManifest(withRanges({ vitefu: 'catalog:', '@godcreator/gwb-commands': 'catalog:default' }), '0.4.0', {}, WORKSPACE, CATALOGS)
    expect(out.dependencies).toEqual({ vitefu: '^1.1.1', '@godcreator/gwb-commands': '^0.6.1' })
  })

  it('catalog:<名> 取 catalogs.<名> 里的范围', () => {
    const out = distManifest(withRanges({ react: 'catalog:gwb-host', '@types/node': 'catalog:gwb-host' }), '0.4.0', {}, WORKSPACE, CATALOGS)
    expect(out.dependencies).toEqual({ react: '19.2.0', '@types/node': '^24.0.0' })
  })

  it('peer 里的 catalog: 照样换', () => {
    const out = distManifest(withRanges({}, { '@godcreator/gwb-commands': 'catalog:', react: 'catalog:gwb-host' }), '0.4.0', {}, WORKSPACE, CATALOGS)
    expect(out.peerDependencies).toEqual({ '@godcreator/gwb-commands': '^0.6.1', react: '19.2.0' })
  })

  it('同一次发的包在 dependencies 里仍以给的写法为准，哪怕它写的是 catalog:', () => {
    const out = distManifest(withRanges({ vitefu: 'catalog:' }), '0.4.0', { vitefu: '^9.0.0' }, WORKSPACE, CATALOGS)
    expect(out.dependencies?.['vitefu']).toBe('^9.0.0')
  })

  it('catalog 里没有这个包：直接抛，写明哪个包、哪个依赖、哪个 catalog、读的哪个文件', () => {
    const call = () => distManifest(withRanges({ vite: 'catalog:' }), '0.4.0', {}, WORKSPACE, CATALOGS)
    expect(call).toThrow('@godcreator/gwb-fake 的 dependencies 里 vite 写的是 catalog:')
    expect(call).toThrow(`${WORKSPACE_YAML} 的 顶层 catalog(或 catalogs.default) 里没有 vite`)
  })

  it('没有这个具名 catalog：直接抛，写明 catalog 名与文件', () => {
    expect(() => distManifest(withRanges({}, { react: 'catalog:browser' }), '0.4.0', {}, WORKSPACE, CATALOGS)).toThrow(
      `@godcreator/gwb-fake 的 peerDependencies 里 react 写的是 catalog:browser,可 ${WORKSPACE_YAML} 里没有 catalogs.browser`,
    )
  })

  it('pnpm-workspace.yaml 没有 catalog 段时用到 catalog:：直接抛，写明文件', () => {
    const noCatalogs = workspaceCatalogsFromYaml("packages:\n  - 'plugins/*'\n", WORKSPACE_YAML)
    expect(() => distManifest(withRanges({ vitefu: 'catalog:' }), '0.4.0', {}, WORKSPACE, noCatalogs)).toThrow(`可 ${WORKSPACE_YAML} 里没有 顶层 catalog`)
    expect(distManifest(MANIFEST, '0.4.0', SIBLINGS, WORKSPACE, noCatalogs).dependencies?.['yaml']).toBe('^2.8.0')
  })

  it('catalogs.default 也是默认 catalog；它与顶层 catalog 都写了就抛', () => {
    const viaCatalogs = workspaceCatalogsFromYaml('catalogs:\n  default:\n    vitefu: ^1.2.0\n', WORKSPACE_YAML)
    expect(distManifest(withRanges({ vitefu: 'catalog:' }), '0.4.0', {}, WORKSPACE, viaCatalogs).dependencies?.['vitefu']).toBe('^1.2.0')
    expect(() => workspaceCatalogsFromYaml('catalog:\n  a: ^1.0.0\ncatalogs:\n  default:\n    a: ^2.0.0\n', WORKSPACE_YAML)).toThrow('顶层 catalog 与 catalogs.default 都写了')
  })

  it('pnpm-workspace.yaml 读不懂（语法错、catalog 形状不对）：直接抛，写明文件', () => {
    expect(() => workspaceCatalogsFromYaml('catalog:\n  a: [1, 2\n', WORKSPACE_YAML)).toThrow(`${WORKSPACE_YAML} 不是合法的 YAML`)
    expect(() => workspaceCatalogsFromYaml('catalog:\n  - vitefu\n', WORKSPACE_YAML)).toThrow(`${WORKSPACE_YAML} 的 catalog 要是「包名: 范围」`)
    expect(() => workspaceCatalogsFromYaml('catalogs:\n  gwb-host:\n    react: 19\n', WORKSPACE_YAML)).toThrow(`${WORKSPACE_YAML} 的 catalogs.gwb-host 里 react 的范围要是一条字符串`)
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

  it('catalog 从工作区根的 pnpm-workspace.yaml 读，报错里写的是那个文件', () => {
    const root = workspaceWithPluginAndLib()
    const file = path.join(root, 'pnpm-workspace.yaml')
    fs.appendFileSync(file, 'catalog:\n  vitefu: ^1.1.1\n')
    const catalogs = workspaceCatalogs(workspaceRootOf(path.join(root, 'plugins', 'a')))
    expect(catalogs.file).toBe(file)
    expect(catalogs.rangesByCatalog.get('default')?.get('vitefu')).toBe('^1.1.1')
  })

  it('工作区里有读不懂的 package.json：直接抛，写明是哪个文件，不当它不在', () => {
    const root = workspaceWithPluginAndLib()
    fs.writeFileSync(path.join(root, 'packages', 'lib', 'package.json'), '{ 半截')
    expect(() => workspaceVersions(root)).toThrow(path.join(root, 'packages', 'lib', 'package.json'))
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

describe('files 白名单：只认字面路径', () => {
  it('否定式（!开头）与通配都挑出来：组装发布内容只按字面复制，这两种一律拒', () => {
    expect(unsupportedFileEntries(['dist', 'skills', '!py/**/__pycache__', 'lib/*.js', 'a?.txt'])).toEqual(['!py/**/__pycache__', 'lib/*.js', 'a?.txt'])
    expect(unsupportedFileEntries(['dist', 'src'])).toEqual([])
  })
})

describe('pnpm view 的结果：这个版本号在源上有没有', () => {
  it('退出码 0 就是有', () => {
    expect(publishedFromView({ ok: true, tail: '0.21.0' }, '@godcreator/x@0.21.0', 'http://r/')).toBe(true)
  })

  it('没有这个版本、没有这个包（404）：没有', () => {
    expect(publishedFromView({ ok: false, tail: 'Error: ERR_PNPM_PACKAGE_NOT_FOUND\n  × No matching version found for @godcreator/x@0.99.0' }, '@godcreator/x@0.99.0', 'http://r/')).toBe(false)
    expect(publishedFromView({ ok: false, tail: 'Error: ERR_PNPM_FETCH_404\n  × GET http://r/@godcreator/x: Not Found - 404' }, '@godcreator/x@0.1.0', 'http://r/')).toBe(false)
  })

  it('别的失败（源连不上、超时）：直接抛，不当成没发过', () => {
    expect(() => publishedFromView({ ok: false, tail: 'ERR_PNPM_META_FETCH_FAIL  GET http://r/: request to http://r/ failed, reason: connect ECONNREFUSED' }, '@godcreator/x@0.1.0', 'http://r/')).toThrow(/ECONNREFUSED/)
  })
})

describe('installRegistryFromConfig：pnpm config get <范围>:registry 的结果', () => {
  it('最后一行是地址就是那个源；是 undefined 就是没给这个范围配源', () => {
    expect(installRegistryFromConfig({ ok: true, tail: 'https://git.example.com/api/packages/team/npm/\n' }, '@team')).toBe('https://git.example.com/api/packages/team/npm/')
    expect(installRegistryFromConfig({ ok: true, tail: 'undefined' }, '@team')).toBeUndefined()
  })

  it('命令没成、什么都没输出、输出的不是 http(s) 地址：抛', () => {
    expect(() => installRegistryFromConfig({ ok: false, tail: 'boom' }, '@team')).toThrow(/没成/)
    expect(() => installRegistryFromConfig({ ok: true, tail: '' }, '@team')).toThrow(/没成/)
    expect(() => installRegistryFromConfig({ ok: true, tail: 'git.example.com' }, '@team')).toThrow(/不是 http\(s\) 地址/)
  })
})