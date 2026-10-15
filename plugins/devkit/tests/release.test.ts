import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCordisPluginManifest, TEAM_REGISTRY } from '../src/vocab.js'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'
import {
  alsoPublishToArgOf,
  dirtyLines,
  githubRepoOf,
  isNpmjsRegistry,
  kernelPeerProblems,
  releaseTagOf,
  isPluginManifest,
  peerCycleProblems,
  peerLineProblems,
  peerProblems,
  publishTargetOf,
  runRelease,
  sameReleaseLine,
  ticketManifestOf,
  ticketRefusal,
  type ReleaseDeps,
} from '../src/release.js'

/**
 * 发正式版比发开发版多一道「git 工作区干净」的检查，少了装进 home 的那部分。这里测多出来的部分：检查的次序
 * （全在发第一个包之前）、同一次发的包之间的范围写成 `^新版本号`、同号拒发时有没有说清「先在仓里升版本号」。
 * 都是只在边界情况里出现的判断，用假的依赖就能跑完。
 */

const REPO = 'D:/fake-repo'
const A = '@godcreator/gwb-fake-a'
const B = '@godcreator/gwb-fake-b'

const SHELL = '@godcreator/gwb-shell'
const API = '@godcreator/gwb-plugin-api'

/** 插件包 peer 里写对了的内核包 */
const KERNEL_PEER = { [KERNEL_PACKAGE]: '^0.3.0' }

const EXPORTS = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }

/** 发布目标：每个要发的包都得写 */
const PUBLISH_CONFIG = { registry: TEAM_REGISTRY }

function manifestOf(name: string, version: string, files: string[] = ['dist']): string {
  return JSON.stringify({ name, version, files, exports: EXPORTS, publishConfig: PUBLISH_CONFIG })
}

/** 插件包的清单：keywords 含 gwb-plugin；gwb、其余字段给了才写 */
function pluginManifestOf(name: string, version: string, gwb?: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, version, files: ['dist'], exports: EXPORTS, publishConfig: PUBLISH_CONFIG, keywords: ['gwb', 'gwb-plugin'], ...(gwb === undefined ? {} : { gwb }), ...extra })
}

/** 别的范围下的插件：peer 里的插件不分范围，都和源上 latest 比 */
const OTHER_SCOPE_PLUGIN = '@someone/gwb-x'

/** peer 里哪些包的清单是插件（keywords 含 gwb-plugin） */
const PLUGIN_PEERS: ReadonlySet<string> = new Set([SHELL, B, A, OTHER_SCOPE_PLUGIN])

const T = (peers: Record<string, string>, version = '0.3.0', plugin = false) => ({
  name: A,
  version,
  peers,
  plugin,
})

describe('peerLineProblems：peer 里的插件和源上 latest 在同一条线', () => {
  const P = (peers: Record<string, string>) => T(peers, '0.3.0', true)

  it('0.x 只看 x：同一个次版本号就放行，下限比 latest 高、低都不管', () => {
    expect(peerLineProblems(P({ [SHELL]: '^0.13.3' }), { [SHELL]: '0.13.9' }, PLUGIN_PEERS)).toEqual([])
    expect(peerLineProblems(P({ [SHELL]: '^0.13.9' }), { [SHELL]: '0.13.3' }, PLUGIN_PEERS)).toEqual([])
  })

  it('0.x 的 x 不同：拒，说先适配再改到哪', () => {
    const got = peerLineProblems(P({ [SHELL]: '^0.13.3' }), { [SHELL]: '0.14.0' }, PLUGIN_PEERS)
    expect(got).toEqual([expect.stringContaining('不在同一条线')])
    expect(got[0]).toContain('"^0.14.0"')
  })

  it('≥1 只看主版本号', () => {
    expect(peerLineProblems(P({ [SHELL]: '^1.2.0' }), { [SHELL]: '1.9.0' }, PLUGIN_PEERS)).toEqual([])
    expect(peerLineProblems(P({ [SHELL]: '^1.2.0' }), { [SHELL]: '2.0.0' }, PLUGIN_PEERS)).toHaveLength(1)
  })

  it('别的范围下的插件同样比：不在同一条线就拒', () => {
    const got = peerLineProblems(P({ [OTHER_SCOPE_PLUGIN]: '^0.2.0' }), { [OTHER_SCOPE_PLUGIN]: '0.3.1' }, PLUGIN_PEERS)
    expect(got).toEqual([expect.stringContaining(`peer ${OTHER_SCOPE_PLUGIN} 是 "^0.2.0",源上 latest 0.3.1(不在同一条线`)])
    expect(peerLineProblems(P({ [OTHER_SCOPE_PLUGIN]: '^0.3.0' }), { [OTHER_SCOPE_PLUGIN]: '0.3.1' }, PLUGIN_PEERS)).toEqual([])
  })

  it('不是 ^x.y.z、问不出 latest：拒；内核包、workspace:、不是插件的 peer 不在这里查', () => {
    const got = peerLineProblems(P({ [SHELL]: '>=0.13.0', [B]: '^0.2.0', [KERNEL_PACKAGE]: '^0.1.0', [A]: 'workspace:*', '@cordisjs/plugin-timer': '^1.1.3' }), {}, PLUGIN_PEERS)
    expect(got).toEqual([expect.stringContaining('peer 只许写 ^x.y.z'), expect.stringContaining('问不出')])
  })

  it('不是插件包：peer 不查', () => {
    expect(peerLineProblems(T({ [SHELL]: '^0.13.3' }), { [SHELL]: '0.14.0' }, PLUGIN_PEERS)).toEqual([])
  })
})

describe('sameReleaseLine、isPluginManifest 与 isCordisPluginManifest', () => {
  it('0.x 比次版本号，≥1 比主版本号，认不出的算不在同一条线', () => {
    expect(sameReleaseLine('0.5.0', '0.5.9')).toBe(true)
    expect(sameReleaseLine('0.5.0', '0.6.0')).toBe(false)
    expect(sameReleaseLine('0.5.0', '1.5.0')).toBe(false)
    expect(sameReleaseLine('1.0.0', '1.9.9')).toBe(true)
    expect(sameReleaseLine('x', '1.0.0')).toBe(false)
  })

  it('插件只认 keywords 含 gwb-plugin；cordis 官方插件（keywords 含 cordis 与 plugin）不算', () => {
    expect(isPluginManifest({ keywords: ['gwb', 'gwb-plugin'] })).toBe(true)
    expect(isPluginManifest({ keywords: ['cordis', 'timer', 'service', 'plugin'] })).toBe(false)
    expect(isPluginManifest({ keywords: ['gwb'] })).toBe(false)
    expect(isPluginManifest({})).toBe(false)
  })

  it('第三方 cordis 插件要 keywords 同时含 cordis 与 plugin', () => {
    expect(isCordisPluginManifest({ keywords: ['cordis', 'timer', 'service', 'plugin'] })).toBe(true)
    expect(isCordisPluginManifest({ keywords: ['cordis'] })).toBe(false)
    expect(isCordisPluginManifest({ keywords: ['plugin'] })).toBe(false)
    expect(isCordisPluginManifest({ keywords: ['gwb', 'gwb-plugin'] })).toBe(false)
    expect(isCordisPluginManifest({})).toBe(false)
  })
})

describe('peerProblems：插件包的 peer 只写 cordis、内核包与别的插件', () => {
  const manifests: Record<string, unknown> = {
    [SHELL]: { keywords: ['gwb', 'gwb-plugin'] },
    '@cordisjs/plugin-timer': { keywords: ['cordis', 'timer', 'service', 'plugin'] },
    [API]: { keywords: ['gwb'] },
    react: { keywords: ['react'] },
  }
  const peerManifestOf = (pkg: string): unknown => manifests[pkg]

  it('peer 只有 cordis 与内核包：干净', () => {
    expect(peerProblems(T({ cordis: '^4.0.0-rc.9', ...KERNEL_PEER }, '0.3.0', true), peerManifestOf)).toEqual([])
  })

  it('peer 写别的插件（keywords 含 gwb-plugin）：放行', () => {
    const got = peerProblems(T({ [SHELL]: '^0.13.7', ...KERNEL_PEER }, '0.3.0', true), peerManifestOf)
    expect(got).toEqual([])
  })

  it('peer 写 cordis 官方插件（keywords 含 cordis 与 plugin）：放行，它和 gwb 插件一样从 home 里得到', () => {
    const got = peerProblems(T({ '@cordisjs/plugin-timer': '^1.1.3', ...KERNEL_PEER }, '0.3.0', true), peerManifestOf)
    expect(got).toEqual([])
  })

  it('peer 写了不是插件的包：拒，说库打包进产物写 dev；清单读不到：拒，说先 pnpm install', () => {
    const got = peerProblems(T({ [API]: '^0.2.7', react: '^19.0.0', ghost: '^1.0.0', ...KERNEL_PEER }, '0.3.0', true), peerManifestOf)
    expect(got).toEqual([
      expect.stringContaining(`peer 写了 ${API},它不是插件`),
      expect.stringContaining('peer 写了 react,它不是插件'),
      expect.stringContaining('peer 写了 ghost,包目录的 node_modules 里读不到它的清单'),
    ])
    expect(got[0]).toContain('devDependencies')
    expect(got[0]).toContain('dependencies,并在清单里写明原因')
  })

  it('不是插件包：不查', () => {
    expect(peerProblems(T({ react: '^19.0.0' }), peerManifestOf)).toEqual([])
  })
})

describe('peerCycleProblems：顺着 peer 里的 gwb 插件的已装清单走回本包就拒', () => {
  const C = '@godcreator/gwb-fake-c'
  const PKG_DIR = path.resolve(REPO, 'a')
  const STORE = path.resolve('D:/store')
  const plugin = (name: string, peers: Record<string, string> = {}, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ name, version: '0.1.0', keywords: ['gwb', 'gwb-plugin'], peerDependencies: peers, ...extra })
  const installedAt = (dir: string, pkg: string): string => path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json')

  /** 假文件表加一张目录链接表：pnpm 把包链到虚拟存储里的真实目录，包 peer 里的包放在真实目录旁边 */
  function graphIo(files: Record<string, string>, links: Record<string, string> = {}) {
    const table = new Map(Object.entries(files).map(([file, text]) => [path.resolve(file), text]))
    return {
      readText: (file: string) => table.get(path.resolve(file)),
      realpath: (target: string) => links[path.resolve(target)] ?? path.resolve(target),
    }
  }
  const A_PEERS_B = T({ [B]: '^0.1.0', cordis: '^4.0.0-rc.10', ...KERNEL_PEER }, '0.1.0', true)

  it('两个包互相写 peer：拒，列出环 A → B → A，说反方向改用局部注入', () => {
    const io = graphIo({ [installedAt(PKG_DIR, B)]: plugin(B, { [A]: '^0.1.0' }) })
    const got = peerCycleProblems(A_PEERS_B, PKG_DIR, new Map(), io)
    expect(got).toEqual([expect.stringContaining(`peer 成环:${A} → ${B} → ${A}`)])
    expect(got[0]).toContain('<上下文>.inject([...], fn)、不写 peer')
  })

  it('环要走好几步：在包的真实目录旁边找它 peer 里的包，A → B → C → A', () => {
    const bReal = path.join(STORE, 'b@0.1.0', 'node_modules', ...B.split('/'))
    const io = graphIo(
      {
        [installedAt(PKG_DIR, B)]: plugin(B, { [C]: '^0.1.0' }),
        [installedAt(path.join(STORE, 'b@0.1.0'), C)]: plugin(C, { [A]: '^0.1.0' }),
      },
      { [path.join(PKG_DIR, 'node_modules', ...B.split('/'))]: bReal },
    )
    expect(peerCycleProblems(A_PEERS_B, PKG_DIR, new Map(), io)).toEqual([expect.stringContaining(`peer 成环:${A} → ${B} → ${C} → ${A}`)])
  })

  it('不成环：放行；peer 里不是 gwb 插件的包、读不到清单的包不往下走', () => {
    const io = graphIo({
      [installedAt(PKG_DIR, B)]: plugin(B, { [C]: '^0.1.0' }),
      [installedAt(PKG_DIR, C)]: JSON.stringify({ name: C, version: '0.1.0', peerDependencies: { [A]: '^0.1.0' } }),
    })
    expect(peerCycleProblems(A_PEERS_B, PKG_DIR, new Map(), io)).toEqual([])
    expect(peerCycleProblems(A_PEERS_B, PKG_DIR, new Map(), graphIo({}))).toEqual([])
  })

  it('反方向用局部注入（B 的 dev 写了 A，peer 没写）：不算环', () => {
    const io = graphIo({ [installedAt(PKG_DIR, B)]: plugin(B, {}, { devDependencies: { [A]: 'workspace:*' } }) })
    expect(peerCycleProblems(A_PEERS_B, PKG_DIR, new Map(), io)).toEqual([])
  })

  it('同一次发的包按工作区里的清单算：装着的旧版没写 peer，工作区里这一版写了，照样拒', () => {
    const io = graphIo({ [installedAt(PKG_DIR, B)]: plugin(B) })
    const siblings = new Map([[B, { pkgDir: path.resolve(REPO, 'b'), peers: [A], plugin: true }]])
    const got = peerCycleProblems(T({ [B]: 'workspace:*', ...KERNEL_PEER }, '0.1.0', true), PKG_DIR, siblings, io)
    expect(got).toEqual([expect.stringContaining(`peer 成环:${A} → ${B} → ${A}`)])
  })

  it('不是插件包：不查', () => {
    const io = graphIo({ [installedAt(PKG_DIR, B)]: plugin(B, { [A]: '^0.1.0' }) })
    expect(peerCycleProblems(T({ [B]: '^0.1.0' }), PKG_DIR, new Map(), io)).toEqual([])
  })
})

describe('ticketRefusal', () => {
  it('拒的回执按包分组、带总数', () => {
    const text = ticketRefusal([
      { pkg: `${A}@0.1.0`, problems: ['一', '二'] },
      { pkg: `${B}@0.2.0`, problems: [] },
    ])
    expect(text).toContain('1 个包 2 条')
    expect(text).toContain(`${A}@0.1.0:\n  - 一\n  - 二`)
    expect(text).not.toContain(B)
  })
})

describe('ticketManifestOf：是不是插件、全部 peer', () => {
  it('keywords 含 gwb-plugin 的是插件，peer 不分 scope 全部读出（内核包也在里面）', () => {
    const text = pluginManifestOf(A, '0.3.0', undefined, { peerDependencies: { cordis: '^4.0.0-rc.9', ...KERNEL_PEER } })
    expect(ticketManifestOf(text)).toMatchObject({ plugin: true, peers: { cordis: '^4.0.0-rc.9', ...KERNEL_PEER } })
  })

  it('没有 gwb-plugin 的不是插件', () => {
    expect(ticketManifestOf(manifestOf(A, '0.3.0'))).toMatchObject({ plugin: false, peers: {} })
  })
})

describe('kernelPeerProblems：插件包 peer 里的内核包', () => {
  const P = (peers: Record<string, string>, plugin = true) => T(peers, '0.3.0', plugin)

  it('写了 ^x.y.z 就放行：不对照调用 devkit.release 的那个 home 里的内核', () => {
    for (const range of ['^0.3.0', '^0.2.7', '^1.9.4']) expect(kernelPeerProblems(P({ [KERNEL_PACKAGE]: range })), range).toEqual([])
  })

  it('不是插件包：不查', () => {
    expect(kernelPeerProblems(P({}, false))).toEqual([])
  })

  it('没写：拒，说在哪儿写、写什么', () => {
    const got = kernelPeerProblems(P({ cordis: '^4.0.0-rc.9' }))
    expect(got).toEqual([expect.stringContaining(`peer 里没写内核包 ${KERNEL_PACKAGE}`)])
    expect(got[0]).toContain(`"${KERNEL_PACKAGE}": "^<验证时那个内核的版本号>"`)
  })

  it('写法不是 ^x.y.z：拒（精确号、>=、~、少一段、带预发布段都算）', () => {
    for (const bad of ['0.3.0', '>=0.3.0', '~0.3.0', '^0.3', '^0.3.0-dev.1']) {
      const got = kernelPeerProblems(P({ [KERNEL_PACKAGE]: bad }))
      expect(got, bad).toEqual([expect.stringContaining('不是 ^x.y.z')])
      expect(got[0]).toContain('"^<验证时那个内核的版本号>"')
    }
  })
})

interface FakeOptions {
  files?: Record<string, string>
  published?: string[]
  dirty?: string[]
  gitError?: boolean
  failRun?: string
  failPublish?: string
  latest?: Record<string, string>
  /** HEAD 不在 GitHub 上 */
  commitMissing?: boolean
  /** publish.yml 那次运行的结局；不给是成功 */
  run?: { finished: true; success: boolean; url: string } | { finished: false; url?: string }
}

const NPMJS = 'https://registry.npmjs.org/'
const WORKFLOW_FILE = path.resolve(REPO, '.github/workflows/publish.yml')
const GITHUB_REPOSITORY = { type: 'git', url: 'https://github.com/godcreator02/fake-repo.git' }

/** 发到 npmjs 的包：publishConfig 指 npmjs、repository 指 GitHub */
function npmjsManifestOf(name: string, version: string, repository: unknown = GITHUB_REPOSITORY): string {
  return JSON.stringify({ name, version, files: ['dist'], exports: EXPORTS, publishConfig: { registry: NPMJS, access: 'public' }, repository })
}

const PNPM = 'C:\\Users\\u\\AppData\\Local\\pnpm\\bin\\pnpm.exe'

function fake(options: FakeOptions = {}): ReleaseDeps & { calls: string[]; ranges: Record<string, string>[] } {
  const calls: string[] = []
  const ranges: Record<string, string>[] = []
  const files: Record<string, string> = {
    [path.resolve(REPO, 'a/package.json')]: manifestOf(A, '0.1.0'),
    [path.resolve(REPO, 'b/package.json')]: manifestOf(B, '0.2.0'),
    [path.resolve(REPO, 'a/dist/index.js')]: "import path from 'node:path';\n",
    [path.resolve(REPO, 'b/dist/index.js')]: "import path from 'node:path';\n",
    ...options.files,
  }
  return {
    calls,
    ranges,
    pnpm: PNPM,
    readText: (file) => files[path.resolve(file)],
    exists: (target) => path.resolve(target) in files || target.endsWith('dist'),
    filesUnder: (dir) => Object.keys(files).filter((file) => file.startsWith(path.resolve(dir) + path.sep)),
    workspacePackageDirs: () => [],
    realpath: (target) => path.resolve(target),
    async tailwindOf(pkgDir) {
      calls.push(`tailwind @${pkgDir}`)
      // 假编译器：带前缀的 flex 编得出规则，别的都编不出
      return { ok: true, compile: async (css) => ({ build: (candidates) => (css.includes('prefix(') && candidates.some((one) => one.endsWith(':flex')) ? 'rule' : '') }) }
    },
    async gitStatus(repoDir) {
      calls.push(`git status @${repoDir}`)
      if (options.gitError === true) return { ok: false, error: 'fatal: not a git repository' }
      return { ok: true, dirty: options.dirty ?? [] }
    },
    async run(plan, _timeoutMs) {
      calls.push(`run ${plan.command === PNPM ? 'pnpm' : plan.command} ${plan.args.join(' ')} @${plan.cwd}`)
      const ok = options.failRun === undefined || !plan.args.join(' ').includes(options.failRun)
      return { ok, tail: ok ? '' : '假的失败' }
    },
    async publish(input) {
      calls.push(`publish ${input.version} @${input.pkgDir}`)
      calls.push(`publish ${input.version} → ${input.registry}`)
      ranges.push(input.ranges)
      if (options.failPublish !== undefined && input.pkgDir.endsWith(options.failPublish)) {
        return { ok: false, tail: '假的失败' }
      }
      return { ok: true, tail: '' }
    },
    async published(spec, registry) {
      calls.push(`已发过? ${spec} → ${registry}`)
      return (options.published ?? []).includes(spec)
    },
    async latest(...args: unknown[]) {
      const [pkg] = args as [string]
      calls.push(args.length === 1 ? `latest ${pkg}` : `latest ${pkg} 带了 ${String(args.length - 1)} 个多余参数`)
      return options.latest?.[pkg]
    },
    async packRelease(input) {
      calls.push(`pack ${input.version} → ${input.registry}`)
      ranges.push(input.ranges)
      return { ok: true, file: path.join(input.destination, `${path.basename(input.pkgDir)}-${input.version}.tgz`) }
    },
    async headCommit() {
      return { ok: true, sha: 'a'.repeat(40) }
    },
    github: {
      async hasCommit(repo, sha) {
        calls.push(`有提交? ${repo.owner}/${repo.repo} ${sha.slice(0, 7)}`)
        return options.commitMissing !== true
      },
      async createRelease(input) {
        calls.push(`release ${input.tag} @${input.sha.slice(0, 7)}: ${input.assets.map((one) => one.name).join(' ')}`)
        return { url: 'https://github.com/godcreator02/fake-repo/releases/tag/x' }
      },
      async waitPublishRun() {
        calls.push('等 publish.yml')
        return options.run ?? { finished: true, success: true, url: 'https://github.com/godcreator02/fake-repo/actions/runs/1' }
      },
    },
    tempDir: () => path.normalize('/tmp/release'),
    removeDir: (dir) => {
      calls.push(`删 ${dir}`)
    },
    now: () => Date.UTC(2026, 9, 15, 7, 8, 9),
  }
}

describe('porcelain 认脏', () => {
  it('两列状态加路径才是脏；stderr 里的噪音不算', () => {
    const out = dirtyLines(' M src/x.ts\n?? out/\nwarning: unable to access\nR  old.ts -> new.ts\n')
    expect(out).toEqual([' M src/x.ts', '?? out/', 'R  old.ts -> new.ts'])
  })
})

describe('发正式版', () => {
  it('提供方声明不合法时一个包都不发', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: KERNEL_PEER }) } })
    deps.browserProviders = async () => ({ declared: true, imports: {}, problems: ['runtime 的提供方冲突'] })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('runtime 的提供方冲突')
    expect(deps.calls.some(one => one.startsWith('publish'))).toBe(false)
  })
  it('守卫在最前、构建次之、按给定顺序发、范围是 ^新号', async () => {
    const deps = fake()
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(deps.calls[0]).toContain('git status')
    expect(deps.calls[1]).toContain('pnpm build')
    const first = deps.calls.indexOf(`publish 0.1.0 @${path.resolve(REPO, 'a')}`)
    const second = deps.calls.indexOf(`publish 0.2.0 @${path.resolve(REPO, 'b')}`)
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    // 两个包看到的范围表是同一份、一次备齐的——发第一个的时候就得知道第二个的号
    expect(deps.ranges).toEqual([{ [A]: '^0.1.0', [B]: '^0.2.0' }, { [A]: '^0.1.0', [B]: '^0.2.0' }])
    expect(out.data.note).toContain('plugin-manager.update {"all":true}')
  })

  it('发版前检查没过：构建之后、发之前拒，一个都不发，所有包的问题一次列全', async () => {
    const deps = fake({
      latest: { [SHELL]: '0.9.0', [API]: '0.2.0' },
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { devDependencies: { [SHELL]: '0.8.0' } }),
        [path.resolve(REPO, 'b/package.json')]: pluginManifestOf(B, '0.2.0', undefined, {
          peerDependencies: { [API]: '^0.1.1', ...KERNEL_PEER },
          devDependencies: { [API]: '0.1.1' },
        }),
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(true)
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(out.error).toContain('发版前检查没过')
    expect(out.error).toContain(`${A}@0.1.0`)
    expect(out.error).toContain(`${B}@0.2.0`)
    expect(out.error).toContain(`peer 里没写内核包 ${KERNEL_PACKAGE}`)
    expect(out.error).toContain(`peer 写了 ${API}`)
    // a 一条（peer 里没写内核包），b 一条（peer 的清单读不到）；dev 落后于源上 latest 不算问题。
    // 清单读不到就认不出它是不是插件，不拿它和 latest 比
    expect(out.error).not.toContain(`peer ${API} 是 "^0.1.1",源上 latest`)
    expect(out.error).not.toContain(`dev ${SHELL}`)
    expect(out.error).toContain('2 个包 2 条')
  })

  it('dev 依赖不查：落后于源上 latest、出了范围、写法不是 ^ 都照常发，也不去源上问它的 latest', async () => {
    const deps = fake({
      latest: { [SHELL]: '0.9.0' },
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, {
          peerDependencies: KERNEL_PEER,
          devDependencies: { [SHELL]: '0.8.0', [API]: '~0.0.4', [B]: '^9.0.0' },
        }),
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out.ok).toBe(true)
    expect(deps.calls.some((one) => one.startsWith('latest '))).toBe(false)
  })

  it('插件包的产物有不在名单上的包名 import：拒', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: KERNEL_PEER }),
        [path.resolve(REPO, 'a/dist/index.js')]: "import YAML from 'yaml';\n",
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain("import 了 'yaml'")
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('插件包构建后有 dist/style.css：样式检查的问题并进发版前检查，一个都不发；没有 style.css 不查、不找 Tailwind', async () => {
    const styled = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: KERNEL_PEER }),
        [path.resolve(REPO, 'a/dist/style.css')]: '.fa\\:flex{display:flex}.stray{color:red}',
        [path.resolve(REPO, 'a/src/client/styles.css')]: "@import 'tailwindcss/theme.css' theme(reference) prefix(fa);",
        [path.resolve(REPO, 'a/src/client/App.tsx')]: 'export const A = () => <div className="fa:flex" />',
        [path.resolve(REPO, 'a/node_modules/@godcreator/gwb-shell/package.json')]: JSON.stringify({ name: SHELL, exports: { './theme.reference.css': './dist/theme.reference.css' } }),
        [path.resolve(REPO, 'a/node_modules/@godcreator/gwb-shell/dist/theme.reference.css')]: '@theme inline { --color-primary: var(--primary); }',
      },
    })
    const refused = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, styled)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toContain(`${A}@0.1.0:\n  - dist/style.css 里有 1 个类选择器不带 fa: 前缀：.stray`)
    expect(refused.error).toContain('1 个包 1 条')
    expect(styled.calls).toContain(`tailwind @${path.resolve(REPO, 'a')}`)
    expect(styled.calls.some((one) => one.startsWith('publish'))).toBe(false)

    const plain = fake({ files: { [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: KERNEL_PEER }) } })
    expect((await runRelease({ repoDir: REPO, packages: ['a'] }, plain)).ok).toBe(true)
    expect(plain.calls.some((one) => one.startsWith('tailwind'))).toBe(false)
  })

  it('插件包 peer 里的内核包不对：构建之后、发之前拒，一个都不发，每个包的问题一次列全', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0'),
        [path.resolve(REPO, 'b/package.json')]: pluginManifestOf(B, '0.2.0', undefined, { peerDependencies: { [KERNEL_PACKAGE]: '>=0.2.7' } }),
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(true)
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(out.error).toContain('2 个包 2 条')
    expect(out.error).toContain(`${A}@0.1.0:\n  - peer 里没写内核包 ${KERNEL_PACKAGE}`)
    expect(out.error).toContain(`${B}@0.2.0:\n  - peer 里内核包 ${KERNEL_PACKAGE} 写的是 ">=0.2.7"`)
  })

  it('插件包 peer 里的插件和源上 latest 不在同一条线：构建之后、发之前拒，一个都不发；同一条线照常发，latest 从源上问', async () => {
    const shellManifest = { [path.resolve(REPO, 'a/node_modules/@godcreator/gwb-shell/package.json')]: JSON.stringify({ name: SHELL, keywords: ['gwb', 'gwb-plugin'] }) }
    const pluginA = pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: { ...KERNEL_PEER, [SHELL]: '^0.13.7' } })
    const wrong = fake({ latest: { [SHELL]: '0.14.0' }, files: { [path.resolve(REPO, 'a/package.json')]: pluginA, ...shellManifest } })
    const refused = await runRelease({ repoDir: REPO, packages: ['a'] }, wrong)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(wrong.calls).toContain(`latest ${SHELL}`)
    expect(wrong.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(refused.error).toContain(`${A}@0.1.0:\n  - peer ${SHELL} 是 "^0.13.7",源上 latest 0.14.0(不在同一条线`)

    const right = fake({ latest: { [SHELL]: '0.13.9' }, files: { [path.resolve(REPO, 'a/package.json')]: pluginA, ...shellManifest } })
    const shipped = await runRelease({ repoDir: REPO, packages: ['a'] }, right)
    expect(shipped.ok).toBe(true)
  })

  it('插件包注入的服务提供方没写 peer：构建之后、发之前拒；仓里没有文档站不拦；库不查', async () => {
    const commandsDir = 'a/node_modules/@godcreator/gwb-commands'
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: KERNEL_PEER, devDependencies: { '@godcreator/gwb-commands': '^0.5.0' } }),
        [path.resolve(REPO, 'a/src/index.ts')]: "export const inject = ['gwbCommands']\n",
        [path.resolve(REPO, commandsDir, 'package.json')]: JSON.stringify({ name: '@godcreator/gwb-commands', keywords: ['gwb-plugin'], exports: EXPORTS }),
        [path.resolve(REPO, commandsDir, 'dist/index.d.ts')]: "declare module 'cordis' {\n  interface Context {\n    gwbCommands?: GwbCommands\n  }\n}\n",
        [path.resolve(REPO, 'b/src/index.ts')]: "export const inject = ['gwbCommands']\n",
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('1 个包 1 条')
    expect(out.error).toContain('gwbCommands（src/index.ts:1，必需注入） 由 @godcreator/gwb-commands 提供，它不在 peerDependencies 里')
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('插件包 peer 里的内核包写成 ^x.y.z 就照常发：范围不对照调用它的那个 home 里的内核', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: { [KERNEL_PACKAGE]: '^0.1.0' } }) } })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out.ok).toBe(true)
    expect(deps.calls).toContain(`publish 0.1.0 @${path.resolve(REPO, 'a')}`)
  })

  it('git 树不干净就拒，构建都不跑', async () => {
    const deps = fake({ dirty: [' M src/x.ts', '?? out/'] })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('M src/x.ts')
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(false)
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('问不出 git 状态也拒——正式版只从 git 仓里发', async () => {
    const deps = fake({ gitError: true })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('git')
  })

  it('包目录下没有能读的 package.json 时说清「包目录给的是相对仓根的路径」', async () => {
    const deps = fake()
    const out = await runRelease({ repoDir: REPO, packages: ['nope'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('相对仓根')
  })

  it('声明的号已经在源上就拒，话里带着「先抬号」', async () => {
    const deps = fake({ published: [`${A}@0.1.0`] })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('先抬')
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('产物不全都拦在发之前', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'a/package.json')]: manifestOf(A, '0.1.0', ['nope']) } })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('nope')
  })

  it('构建没成就一个都不发', async () => {
    const deps = fake({ failRun: 'build' })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('第二个包发失败：回执里带上已经发出去的那一个', async () => {
    const deps = fake({ failPublish: path.normalize('/b') })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out).toMatchObject({ ok: false })
    expect(out.ok === false && out.data?.shipped).toHaveLength(1)
  })

  it('团队源的地址', () => {
    expect(TEAM_REGISTRY).toBe('https://git.tianshen02.online:28377/api/packages/godcreator/npm/')
  })
})

describe('发布目标（GWB-17）', () => {
  const LOCAL = 'http://localhost:9999/'

  it('publishTargetOf：发布目标就是 publishConfig.registry', () => {
    expect(publishTargetOf({ publishConfig: { registry: LOCAL } })).toEqual({ ok: true, registry: LOCAL })
    expect(publishTargetOf({ publishConfig: { registry: 'https://npm.example.com/api/npm' } })).toEqual({ ok: true, registry: 'https://npm.example.com/api/npm' })
  })

  it('publishTargetOf：没写 publishConfig 或没写 registry：拒，报错写清要写什么、给出 npmjs 的写法作例子', () => {
    for (const doc of [{}, { publishConfig: { access: 'public' } }]) {
      const got = publishTargetOf(doc)
      expect(got.ok, JSON.stringify(doc)).toBe(false)
      if (!got.ok) {
        expect(got.error).toContain('没写 publishConfig.registry')
        expect(got.error).toContain(`"publishConfig": { "registry": "https://registry.npmjs.org/", "access": "public" }`)
      }
    }
  })

  it('publishTargetOf：publishConfig 不是对象、registry 不是 http(s) 地址：拒，不猜', () => {
    const rejected: unknown[] = [{ publishConfig: 'x' }, { publishConfig: [] }, { publishConfig: { registry: 1 } }, { publishConfig: { registry: '' } }, { publishConfig: { registry: 'localhost:9999' } }, { publishConfig: { registry: 'ftp://h/' } }]
    for (const doc of rejected) {
      const got = publishTargetOf(doc as Record<string, unknown>)
      expect(got.ok, JSON.stringify(doc)).toBe(false)
      if (!got.ok) expect(got.error).toContain('publishConfig')
    }
  })

  it('每个包发到自己的发布目标；查「同号已在源上」问的也是它', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: JSON.stringify({ name: A, version: '0.1.0', files: ['dist'], exports: EXPORTS, publishConfig: { registry: LOCAL } }),
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(true)
    expect(deps.calls).toContain(`已发过? ${A}@0.1.0 → ${LOCAL}`)
    expect(deps.calls).toContain(`已发过? ${B}@0.2.0 → ${TEAM_REGISTRY}`)
    expect(deps.calls).toContain(`publish 0.1.0 → ${LOCAL}`)
    expect(deps.calls).toContain(`publish 0.2.0 → ${TEAM_REGISTRY}`)
  })

  it('有一个包没写 publishConfig.registry：发之前拒，一个都不发，报错里点名是哪个包', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'b/package.json')]: JSON.stringify({ name: B, version: '0.2.0', files: ['dist'], exports: EXPORTS }),
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain(B)
      expect(out.error).toContain('没写 publishConfig.registry')
    }
    expect(deps.calls.some((one) => one.startsWith('publish '))).toBe(false)
  })

  it('publishConfig.registry 写坏了：发之前拒，一个都不发，报错里点名是哪个包', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'b/package.json')]: JSON.stringify({ name: B, version: '0.2.0', files: ['dist'], exports: EXPORTS, publishConfig: { registry: 'localhost:9999' } }),
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain(B)
      expect(out.error).toContain('publishConfig.registry')
    }
    expect(deps.calls.some((one) => one.startsWith('publish '))).toBe(false)
  })

  it('alsoPublishTo：每个包先发到自己的发布目标、再发到额外的源，发完一个包再发下一个；回执每个源一条', async () => {
    const deps = fake()
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'], alsoPublishTo: [LOCAL] }, deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const publishes = deps.calls.filter((one) => one.startsWith('publish ') && one.includes('→'))
    expect(publishes).toEqual([`publish 0.1.0 → ${TEAM_REGISTRY}`, `publish 0.1.0 → ${LOCAL}`, `publish 0.2.0 → ${TEAM_REGISTRY}`, `publish 0.2.0 → ${LOCAL}`])
    expect(out.data.shipped.map((one) => `${one.pkg} → ${one.registry}`)).toEqual([`${A} → ${TEAM_REGISTRY}`, `${A} → ${LOCAL}`, `${B} → ${TEAM_REGISTRY}`, `${B} → ${LOCAL}`])
  })

  it('alsoPublishTo：同号已在额外的源上也拒，一个都不发', async () => {
    const deps = fake()
    deps.published = async (spec, registry) => {
      deps.calls.push(`已发过? ${spec} → ${registry}`)
      return spec === `${B}@0.2.0` && registry === LOCAL
    }
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'], alsoPublishTo: [LOCAL] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain(`${B}@0.2.0 已经在源 ${LOCAL} 上了`)
    expect(deps.calls.some((one) => one.startsWith('publish '))).toBe(false)
  })

  it('alsoPublishTo 里写了包自己的发布目标：拒，一个都不发', async () => {
    const deps = fake()
    const out = await runRelease({ repoDir: REPO, packages: ['a'], alsoPublishTo: [TEAM_REGISTRY] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('同一个源只发一次')
    expect(deps.calls.some((one) => one.startsWith('publish '))).toBe(false)
  })

  it('alsoPublishTo 一个源发失败：停下，回执里是已经发出去的', async () => {
    const deps = fake()
    deps.publish = async (input) => {
      deps.calls.push(`publish ${input.version} → ${input.registry}`)
      return input.registry === LOCAL ? { ok: false, tail: '假的失败' } : { ok: true, tail: '' }
    }
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'], alsoPublishTo: [LOCAL] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain(`发到 ${LOCAL} 没成`)
    expect(out.data?.shipped.map((one) => one.registry)).toEqual([TEAM_REGISTRY])
  })

  it('发 npmjs 交给 Actions：本机先发别的源，再按顺序打包挂到 release 上、等 publish.yml 跑完；回执里 npmjs 一条在后', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'a/package.json')]: npmjsManifestOf(A, '0.1.0'), [path.resolve(REPO, 'b/package.json')]: npmjsManifestOf(B, '0.2.0'), [WORKFLOW_FILE]: 'name: publish' } })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'], alsoPublishTo: [LOCAL] }, deps)
    expect(out.ok, out.ok ? '' : out.error).toBe(true)
    if (!out.ok) return
    const steps = deps.calls.filter((one) => /^(publish \S+ →|pack|release|等|删|有提交)/.test(one))
    expect(steps).toEqual([
      '有提交? godcreator02/fake-repo aaaaaaa',
      `publish 0.1.0 → ${LOCAL}`,
      `publish 0.2.0 → ${LOCAL}`,
      `pack 0.1.0 → ${NPMJS}`,
      `pack 0.2.0 → ${NPMJS}`,
      'release release-20261015-070809 @aaaaaaa: 01-a-0.1.0.tgz 02-b-0.2.0.tgz',
      '等 publish.yml',
      `删 ${path.normalize('/tmp/release')}`,
    ])
    expect(deps.ranges.at(-1)).toEqual({ [A]: '^0.1.0', [B]: '^0.2.0' })
    expect(out.data.shipped.map((one) => `${one.pkg} → ${one.registry}`)).toEqual([`${A} → ${LOCAL}`, `${B} → ${LOCAL}`, `${A} → ${NPMJS}`, `${B} → ${NPMJS}`])
    expect(out.data.actions?.run).toBe('https://github.com/godcreator02/fake-repo/actions/runs/1')
  })

  it('发 npmjs：仓里没有 publish.yml、repository 不是 GitHub、HEAD 没推上去，都拒，一个都不发', async () => {
    const cases: [FakeOptions, string][] = [
      [{ files: { [path.resolve(REPO, 'a/package.json')]: npmjsManifestOf(A, '0.1.0') } }, '.github/workflows/publish.yml'],
      [{ files: { [path.resolve(REPO, 'a/package.json')]: npmjsManifestOf(A, '0.1.0', 'https://git.example.com/x/y.git'), [WORKFLOW_FILE]: '' } }, 'repository 要写 GitHub 上的仓'],
      [{ files: { [path.resolve(REPO, 'a/package.json')]: npmjsManifestOf(A, '0.1.0'), [WORKFLOW_FILE]: '' }, commitMissing: true }, '先 git push'],
    ]
    for (const [options, expected] of cases) {
      const deps = fake(options)
      const out = await runRelease({ repoDir: REPO, packages: ['a'], alsoPublishTo: [LOCAL] }, deps)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toContain(expected)
      expect(deps.calls.some((one) => one.startsWith('publish ') || one.startsWith('pack ') || one.startsWith('release '))).toBe(false)
    }
  })

  it('发 npmjs：Actions 没成或没跑完，回执说清本机已发的与去哪看，临时目录照样删', async () => {
    const files = { [path.resolve(REPO, 'a/package.json')]: npmjsManifestOf(A, '0.1.0'), [WORKFLOW_FILE]: '' }
    const failed = fake({ files, run: { finished: true, success: false, url: 'https://run/2' } })
    const failedOut = await runRelease({ repoDir: REPO, packages: ['a'], alsoPublishTo: [LOCAL] }, failed)
    expect(failedOut.ok).toBe(false)
    if (!failedOut.ok) {
      expect(failedOut.error).toContain('https://run/2')
      expect(failedOut.error).toContain(`本机发的已经发完:${A}@0.1.0 → ${LOCAL}`)
      expect(failedOut.data?.shipped.map((one) => one.registry)).toEqual([LOCAL])
    }
    expect(failed.calls.some((one) => one.startsWith('删 '))).toBe(true)

    const slow = fake({ files, run: { finished: false, url: 'https://run/3' } })
    const slowOut = await runRelease({ repoDir: REPO, packages: ['a'] }, slow)
    expect(slowOut.ok).toBe(false)
    if (!slowOut.ok) expect(slowOut.error).toContain('分钟内没跑完:到 https://run/3 看结果')
  })

  it('githubRepoOf、isNpmjsRegistry、releaseTagOf', () => {
    expect(githubRepoOf({ repository: { url: 'git+https://github.com/o/r.git' } })).toEqual({ ok: true, repo: { owner: 'o', repo: 'r' } })
    expect(githubRepoOf({ repository: 'https://github.com/o/r' })).toEqual({ ok: true, repo: { owner: 'o', repo: 'r' } })
    expect(githubRepoOf({ repository: { url: 'https://gitea.example/o/r.git' } }).ok).toBe(false)
    expect(githubRepoOf({}).ok).toBe(false)
    expect(isNpmjsRegistry('https://registry.npmjs.org/')).toBe(true)
    expect(isNpmjsRegistry('https://registry.npmjs.org')).toBe(true)
    expect(isNpmjsRegistry(TEAM_REGISTRY)).toBe(false)
    expect(releaseTagOf(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('release-20260102-030405')
  })

  it('alsoPublishToArgOf：不给是空表；不是 http(s) 地址的字符串数组、有重复：拒', () => {
    expect(alsoPublishToArgOf(undefined)).toEqual({ ok: true, registries: [] })
    expect(alsoPublishToArgOf([LOCAL, 'https://registry.npmjs.org/'])).toEqual({ ok: true, registries: [LOCAL, 'https://registry.npmjs.org/'] })
    for (const raw of ['https://registry.npmjs.org/', [1], ['registry.npmjs.org'], ['ftp://h/']]) {
      expect(alsoPublishToArgOf(raw).ok, JSON.stringify(raw)).toBe(false)
    }
    const repeated = alsoPublishToArgOf([LOCAL, LOCAL])
    expect(repeated.ok).toBe(false)
    if (!repeated.ok) expect(repeated.error).toContain('不止一次')
  })

  it('查别的包的 latest 不指定源（由 .npmrc 的范围行决定）；peer 里别的范围下的插件、第三方 cordis 插件也查', async () => {
    const nodeModules = (pkg: string, keywords: string[]) => ({
      [path.resolve(REPO, 'a/node_modules', ...pkg.split('/'), 'package.json')]: JSON.stringify({ name: pkg, keywords }),
    })
    const deps = fake({
      latest: { [SHELL]: '0.13.9', [OTHER_SCOPE_PLUGIN]: '0.5.0', '@cordisjs/plugin-timer': '1.1.3' },
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, {
          peerDependencies: { ...KERNEL_PEER, [SHELL]: '^0.13.7', [OTHER_SCOPE_PLUGIN]: '^0.4.0', '@cordisjs/plugin-timer': '^1.1.3' },
          devDependencies: { '@someone/lib': '^1.0.0' },
        }),
        ...nodeModules(SHELL, ['gwb', 'gwb-plugin']),
        ...nodeModules(OTHER_SCOPE_PLUGIN, ['gwb', 'gwb-plugin']),
        ...nodeModules('@cordisjs/plugin-timer', ['cordis', 'plugin']),
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain(`peer ${OTHER_SCOPE_PLUGIN} 是 "^0.4.0",源上 latest 0.5.0(不在同一条线`)
    const asked = deps.calls.filter((one) => one.startsWith('latest ')).sort()
    // dev 一律不查 latest：只要装得上，落后于源上 latest 不影响运行
    expect(asked).toEqual([`latest ${OTHER_SCOPE_PLUGIN}`, `latest ${SHELL}`, 'latest @cordisjs/plugin-timer'].sort())
  })
})
