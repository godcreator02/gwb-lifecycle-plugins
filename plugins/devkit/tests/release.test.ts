import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEAM_REGISTRY } from '../src/vocab.js'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'
import {
  dirtyLines,
  kernelPeerProblems,
  isPluginManifest,
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

describe('sameReleaseLine 与 isPluginManifest', () => {
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

  it('peer 写 cordis 官方插件：拒，它的 keywords 里没有 gwb-plugin', () => {
    const got = peerProblems(T({ '@cordisjs/plugin-timer': '^1.1.3', ...KERNEL_PEER }, '0.3.0', true), peerManifestOf)
    expect(got).toEqual([expect.stringContaining('peer 写了 @cordisjs/plugin-timer,它不是插件(keywords 里没有 gwb-plugin)')])
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

  it('publishTargetOf：没写 publishConfig 或没写 registry：拒，报错写清要写什么、给出团队源地址作例子', () => {
    for (const doc of [{}, { publishConfig: { access: 'public' } }]) {
      const got = publishTargetOf(doc)
      expect(got.ok, JSON.stringify(doc)).toBe(false)
      if (!got.ok) {
        expect(got.error).toContain('没写 publishConfig.registry')
        expect(got.error).toContain(`"publishConfig": { "registry": "${TEAM_REGISTRY}" }`)
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

  it('查别的包的 latest 不指定源（由 .npmrc 的范围行决定）；peer 里别的范围下的插件也查，不是插件的 peer（cordis 官方插件）不查', async () => {
    const nodeModules = (pkg: string, keywords: string[]) => ({
      [path.resolve(REPO, 'a/node_modules', ...pkg.split('/'), 'package.json')]: JSON.stringify({ name: pkg, keywords }),
    })
    const deps = fake({
      latest: { [SHELL]: '0.13.9', [OTHER_SCOPE_PLUGIN]: '0.5.0' },
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
    expect(asked).toEqual([`latest ${OTHER_SCOPE_PLUGIN}`, `latest ${SHELL}`].sort())
  })
})
