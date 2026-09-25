import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEAM_REGISTRY } from '../src/vocab.js'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'
import {
  caretCeiling,
  caretFloor,
  checkTicket,
  compareVersions,
  dirtyLines,
  inCaret,
  kernelPeerProblems,
  isPluginManifest,
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
const REACT = '@godcreator/gwb-shared-react'

/** 运行中的内核版本号 */
const KERNEL = '0.3.0'

/** 插件包 peer 里写对了的内核包 */
const KERNEL_PEER = { [KERNEL_PACKAGE]: '^0.3.0' }

const EXPORTS = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }

function manifestOf(name: string, version: string, files: string[] = ['dist']): string {
  return JSON.stringify({ name, version, files, exports: EXPORTS })
}

function full(name: string, version: string, peerDependencies: Record<string, string>, devDependencies: Record<string, string>): string {
  return JSON.stringify({ name, version, files: ['dist'], exports: EXPORTS, peerDependencies, devDependencies })
}

/** 插件包的清单：keywords 含 gwb-plugin；gwb、其余字段给了才写 */
function pluginManifestOf(name: string, version: string, gwb?: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, version, files: ['dist'], exports: EXPORTS, keywords: ['gwb', 'gwb-plugin'], ...(gwb === undefined ? {} : { gwb }), ...extra })
}

/** 别的范围下的插件：peer 里的插件不分范围，都和源上 latest 比 */
const OTHER_SCOPE_PLUGIN = '@someone/gwb-x'

/** peer 里哪些包的清单是插件（keywords 含 gwb-plugin）。cordis 官方插件不算 */
const PLUGIN_PEERS: ReadonlySet<string> = new Set([SHELL, B, A, OTHER_SCOPE_PLUGIN])
const NO_PLUGIN_PEERS: ReadonlySet<string> = new Set()

const T = (peers: Record<string, string>, devs: Record<string, string>, version = '0.3.0', plugin = false) => ({
  name: A,
  version,
  peers,
  devs,
  plugin,
})

describe('checkTicket：版本号与 dev 范围', () => {
  it('dev 钉＝latest、workspace:* 跳过——干净；peer 里的内核包不归它查', () => {
    const got = checkTicket(T({ [KERNEL_PACKAGE]: '^0.1.0' }, { [SHELL]: '0.9.0', [B]: 'workspace:*' }), { [SHELL]: '0.9.0' }, NO_PLUGIN_PEERS)
    expect(got).toEqual({ pkg: `${A}@0.3.0`, problems: [] })
  })

  it('dev 范围罩住 latest 即放行（精确钉与 ^ 皆可）；出范围才拒', () => {
    const exactInRange = checkTicket(T({}, { [SHELL]: '0.8.0' }), { [SHELL]: '0.8.3' }, NO_PLUGIN_PEERS)
    expect(exactInRange.problems).toEqual([])
    const caretDev = checkTicket(T({}, { [SHELL]: '^0.8.0' }), { [SHELL]: '0.8.3' }, NO_PLUGIN_PEERS)
    expect(caretDev.problems).toEqual([])
    const outRange = checkTicket(T({}, { [SHELL]: '0.8.0' }), { [SHELL]: '0.9.0' }, NO_PLUGIN_PEERS)
    expect(outRange.problems[0]).toContain('出范围')
    expect(outRange.problems[0]).toContain('先适配代码')
  })

  it('dev 比 latest 新、问不出 latest、dev 写法认不出：都拒', () => {
    const got = checkTicket(T({}, { [SHELL]: '0.9.1', [API]: '0.1.2', [REACT]: '~0.0.4' }), { [SHELL]: '0.9.0', [REACT]: '0.0.4' }, NO_PLUGIN_PEERS)
    expect(got.problems).toEqual([
      expect.stringContaining('没发的号'),
      expect.stringContaining('问不出'),
      expect.stringContaining('要写 ^<验过的号>'),
    ])
  })

  it('源上的 latest 不是版本号：写进 problems，不拿它比大小', () => {
    const got = checkTicket(T({}, { [SHELL]: '^0.9.0' }), { [SHELL]: 'garbage' }, NO_PLUGIN_PEERS)
    expect(got.problems).toEqual([expect.stringContaining('dist-tags.latest 是 "garbage",不是版本号')])
  })
})

describe('checkTicket：peer 里的插件和源上 latest 在同一条线', () => {
  const P = (peers: Record<string, string>) => T(peers, {}, '0.3.0', true)

  it('0.x 只看 x：同一个次版本号就放行，下限比 latest 高、低都不管', () => {
    expect(checkTicket(P({ [SHELL]: '^0.13.3' }), { [SHELL]: '0.13.9' }, PLUGIN_PEERS).problems).toEqual([])
    expect(checkTicket(P({ [SHELL]: '^0.13.9' }), { [SHELL]: '0.13.3' }, PLUGIN_PEERS).problems).toEqual([])
  })

  it('0.x 的 x 不同：拒，说先适配再抬到哪', () => {
    const got = checkTicket(P({ [SHELL]: '^0.13.3' }), { [SHELL]: '0.14.0' }, PLUGIN_PEERS)
    expect(got.problems).toEqual([expect.stringContaining('不在同一条线')])
    expect(got.problems[0]).toContain('"^0.14.0"')
  })

  it('≥1 只看主版本号', () => {
    expect(checkTicket(P({ [SHELL]: '^1.2.0' }), { [SHELL]: '1.9.0' }, PLUGIN_PEERS).problems).toEqual([])
    expect(checkTicket(P({ [SHELL]: '^1.2.0' }), { [SHELL]: '2.0.0' }, PLUGIN_PEERS).problems).toHaveLength(1)
  })

  it('别的范围下的插件同样比：不在同一条线就拒', () => {
    const got = checkTicket(P({ [OTHER_SCOPE_PLUGIN]: '^0.2.0' }), { [OTHER_SCOPE_PLUGIN]: '0.3.1' }, PLUGIN_PEERS)
    expect(got.problems).toEqual([expect.stringContaining(`peer ${OTHER_SCOPE_PLUGIN} 是 "^0.2.0",源上 latest 0.3.1(不在同一条线`)])
    expect(checkTicket(P({ [OTHER_SCOPE_PLUGIN]: '^0.3.0' }), { [OTHER_SCOPE_PLUGIN]: '0.3.1' }, PLUGIN_PEERS).problems).toEqual([])
  })

  it('不是 ^x.y.z、问不出 latest：拒；内核包、workspace:、不是 gwb 插件的 peer（cordis 官方插件）不在这里查', () => {
    const got = checkTicket(P({ [SHELL]: '>=0.13.0', [B]: '^0.2.0', [KERNEL_PACKAGE]: '^0.1.0', [A]: 'workspace:*', '@cordisjs/plugin-timer': '^1.1.3' }), {}, PLUGIN_PEERS)
    expect(got.problems).toEqual([expect.stringContaining('peer 只许写 ^x.y.z'), expect.stringContaining('问不出')])
  })

  it('不是插件包：peer 不查', () => {
    expect(checkTicket(T({ [SHELL]: '^0.13.3' }, {}), { [SHELL]: '0.14.0' }, PLUGIN_PEERS).problems).toEqual([])
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

  it('插件：keywords 含 gwb-plugin，或同时含 cordis 与 plugin（cordis 官方插件）', () => {
    expect(isPluginManifest({ keywords: ['gwb', 'gwb-plugin'] })).toBe(true)
    expect(isPluginManifest({ keywords: ['cordis', 'timer', 'service', 'plugin'] })).toBe(true)
    expect(isPluginManifest({ keywords: ['gwb'] })).toBe(false)
    expect(isPluginManifest({})).toBe(false)
  })
})

describe('compareVersions：逐段数字比', () => {
  it('0.10.0 大于 0.9.9——字符串比会翻车的那种', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.9.9', '0.10.0')).toBe(-1)
  })
  it('认不出的号直接抛错，不补零、不当 0', () => {
    expect(() => compareVersions('0.1', '0.1.0')).toThrow(/"0.1" 不是版本号/)
    expect(() => compareVersions('0.1.0', 'latest')).toThrow(/"latest" 不是版本号/)
  })
  it('构建段不参与比较', () => {
    expect(compareVersions('0.1.0+build.7', '0.1.0')).toBe(0)
  })
  it('同三段时带预发布段的小：0.2.1-dev.x < 0.2.1，但大于 0.2.0', () => {
    expect(compareVersions('0.2.1-dev.202609151533', '0.2.1')).toBe(-1)
    expect(compareVersions('0.2.1-dev.202609151533', '0.2.0')).toBe(1)
  })
  it('两个预发布号按数字段比', () => {
    expect(compareVersions('0.7.2-dev.202609171834', '0.7.2-dev.202609171837')).toBe(-1)
    expect(compareVersions('0.7.2-dev.10', '0.7.2-dev.9')).toBe(1)
  })
})

describe('caret 语义', () => {
  it('上限：第一个非零段进一', () => {
    expect(caretCeiling('1.2.3')).toBe('2.0.0')
    expect(caretCeiling('0.8.3')).toBe('0.9.0')
    expect(caretCeiling('0.0.4')).toBe('0.0.5')
  })
  it('范围内外；预发布号一概不算在内', () => {
    expect(inCaret('0.8.0', '0.8.9')).toBe(true)
    expect(inCaret('0.8.0', '0.9.0')).toBe(false)
    expect(inCaret('0.8.0', '0.7.9')).toBe(false)
    expect(inCaret('0.8.0', '0.8.1-dev.202609181200')).toBe(false)
  })
  it('只认 ^x.y.z', () => {
    expect(caretFloor('^0.9.0')).toBe('0.9.0')
    expect(caretFloor('>=0.9.0')).toBeUndefined()
    expect(caretFloor('^0.9')).toBeUndefined()
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
    expect(peerProblems(T({ cordis: '^4.0.0-rc.9', ...KERNEL_PEER }, {}, '0.3.0', true), peerManifestOf)).toEqual([])
  })

  it('peer 写别的插件（gwb 插件与 cordis 官方插件）：放行', () => {
    const got = peerProblems(T({ [SHELL]: '^0.13.7', '@cordisjs/plugin-timer': '^1.1.3', ...KERNEL_PEER }, {}, '0.3.0', true), peerManifestOf)
    expect(got).toEqual([])
  })

  it('peer 写了不是插件的包：拒，说库打包进产物写 dev；清单读不到：拒，说先 pnpm install', () => {
    const got = peerProblems(T({ [API]: '^0.2.7', react: '^19.0.0', ghost: '^1.0.0', ...KERNEL_PEER }, {}, '0.3.0', true), peerManifestOf)
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
  const P = (peers: Record<string, string>, plugin = true) => T(peers, {}, '0.3.0', plugin)

  it('写了 ^x.y.z 且包含运行中的内核：放行（0.x 次版本号相同，≥1 主版本号相同，都不低于下限）', () => {
    expect(kernelPeerProblems(P({ [KERNEL_PACKAGE]: '^0.3.0' }), '0.3.4')).toEqual([])
    expect(kernelPeerProblems(P({ [KERNEL_PACKAGE]: '^1.0.0' }), '1.9.4')).toEqual([])
    expect(kernelPeerProblems(P({ [KERNEL_PACKAGE]: '^0.3.0' }), '0.3.1-dev.202609241500')).toEqual([])
  })

  it('不是插件包：不查', () => {
    expect(kernelPeerProblems(P({}, false), KERNEL)).toEqual([])
  })

  it('没写：拒，说在哪儿写、写什么', () => {
    const got = kernelPeerProblems(P({ cordis: '^4.0.0-rc.9' }), KERNEL)
    expect(got).toEqual([expect.stringContaining(`peer 里没写内核包 ${KERNEL_PACKAGE}`)])
    expect(got[0]).toContain(`"${KERNEL_PACKAGE}": "^0.3.0"`)
  })

  it('运行中的是开发版内核：建议的范围只取 x.y.z 三段', () => {
    expect(kernelPeerProblems(P({}), '0.3.1-dev.202609241500')[0]).toContain(`"${KERNEL_PACKAGE}": "^0.3.1"`)
  })

  it('写法不是 ^x.y.z：拒（精确号、>=、~、少一段、带预发布段都算）', () => {
    for (const bad of ['0.3.0', '>=0.3.0', '~0.3.0', '^0.3', '^0.3.0-dev.1']) {
      const got = kernelPeerProblems(P({ [KERNEL_PACKAGE]: bad }), KERNEL)
      expect(got, bad).toEqual([expect.stringContaining('不是 ^x.y.z')])
      expect(got[0]).toContain('"^0.3.0"')
    }
  })

  it('不包含运行中的内核：拒，说在运行中的内核上验过之后改成什么', () => {
    const older = kernelPeerProblems(P({ [KERNEL_PACKAGE]: '^0.2.7' }), KERNEL)
    expect(older).toEqual([expect.stringContaining('不包含运行中的内核 0.3.0')])
    expect(older[0]).toContain('改成 "^0.3.0"')
    expect(kernelPeerProblems(P({ [KERNEL_PACKAGE]: '^0.3.2' }), KERNEL)).toHaveLength(1)
    expect(kernelPeerProblems(P({ [KERNEL_PACKAGE]: '^1.9.4' }), '2.0.0')).toHaveLength(1)
  })

  it('运行中的内核版本号不合法：直接抛错', () => {
    expect(() => kernelPeerProblems(P(KERNEL_PEER), 'dev')).toThrow(/内核版本号不是合法的版本号/)
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
  it('守卫在最前、构建次之、按给定顺序发、范围是 ^新号', async () => {
    const deps = fake()
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a', 'b'] }, deps)
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
        [path.resolve(REPO, 'a/package.json')]: full(A, '0.1.0', { [SHELL]: '^0.8.0' }, { [SHELL]: '0.8.0' }),
        [path.resolve(REPO, 'b/package.json')]: pluginManifestOf(B, '0.2.0', undefined, {
          peerDependencies: { [API]: '^0.1.1', ...KERNEL_PEER },
          devDependencies: { [API]: '0.1.1' },
        }),
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(true)
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(out.error).toContain('发版前检查没过')
    expect(out.error).toContain(`${A}@0.1.0`)
    expect(out.error).toContain(`${B}@0.2.0`)
    expect(out.error).toContain('出范围')
    expect(out.error).toContain(`peer 写了 ${API}`)
    // a 不是插件包：peer 不查；a 一条（dev 出范围），b 两条（dev 出范围、peer 的清单读不到）。
    // 清单读不到就认不出它是不是插件，不拿它和 latest 比
    expect(out.error).not.toContain(`peer ${API} 是 "^0.1.1",源上 latest`)
    expect(out.error).toContain('2 个包 3 条')
  })

  it('插件包的产物有不在名单上的包名 import、有空 import：拒', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: KERNEL_PEER }),
        [path.resolve(REPO, 'a/dist/index.js')]: "import YAML from 'yaml';\nimport {} from '@godcreator/gwb-shell';\n",
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain("import 了 'yaml'")
    expect(out.error).toContain("空 import：import {} from '@godcreator/gwb-shell'")
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('插件包 peer 里的内核包不对：构建之后、发之前拒，一个都不发，每个包的问题一次列全', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0'),
        [path.resolve(REPO, 'b/package.json')]: pluginManifestOf(B, '0.2.0', undefined, { peerDependencies: { [KERNEL_PACKAGE]: '^0.2.7' } }),
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(true)
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(out.error).toContain('2 个包 2 条')
    expect(out.error).toContain(`${A}@0.1.0:\n  - peer 里没写内核包 ${KERNEL_PACKAGE}`)
    expect(out.error).toContain(`${B}@0.2.0:\n  - peer 里内核包 ${KERNEL_PACKAGE} 写的是 "^0.2.7"`)
  })

  it('插件包 peer 里的插件和源上 latest 不在同一条线：构建之后、发之前拒，一个都不发；同一条线照常发，latest 从源上问', async () => {
    const shellManifest = { [path.resolve(REPO, 'a/node_modules/@godcreator/gwb-shell/package.json')]: JSON.stringify({ name: SHELL, keywords: ['gwb', 'gwb-plugin'] }) }
    const pluginA = pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: { ...KERNEL_PEER, [SHELL]: '^0.13.7' } })
    const wrong = fake({ latest: { [SHELL]: '0.14.0' }, files: { [path.resolve(REPO, 'a/package.json')]: pluginA, ...shellManifest } })
    const refused = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, wrong)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(wrong.calls).toContain(`latest ${SHELL}`)
    expect(wrong.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(refused.error).toContain(`${A}@0.1.0:\n  - peer ${SHELL} 是 "^0.13.7",源上 latest 0.14.0(不在同一条线`)

    const right = fake({ latest: { [SHELL]: '0.13.9' }, files: { [path.resolve(REPO, 'a/package.json')]: pluginA, ...shellManifest } })
    const shipped = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, right)
    expect(shipped.ok).toBe(true)
  })

  it('插件包 peer 里的内核包范围包含运行中的内核：照常发', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: KERNEL_PEER }) } })
    const out = await runRelease({ repoDir: REPO, runningKernel: '0.3.2', packages: ['a'] }, deps)
    expect(out.ok).toBe(true)
    expect(deps.calls).toContain(`publish 0.1.0 @${path.resolve(REPO, 'a')}`)
  })

  it('git 树不干净就拒，构建都不跑', async () => {
    const deps = fake({ dirty: [' M src/x.ts', '?? out/'] })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('M src/x.ts')
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(false)
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('问不出 git 状态也拒——正式版只从 git 仓里发', async () => {
    const deps = fake({ gitError: true })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('git')
  })

  it('仓根不是个能发的包时说清「包目录给的是相对仓根的路径」', async () => {
    const deps = fake()
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: [] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('相对仓根')
  })

  it('声明的号已经在源上就拒，话里带着「先抬号」', async () => {
    const deps = fake({ published: [`${A}@0.1.0`] })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('先抬')
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('产物不全都拦在发之前', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'a/package.json')]: manifestOf(A, '0.1.0', ['nope']) } })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    if (!out.ok) expect(out.error).toContain('nope')
  })

  it('构建没成就一个都不发', async () => {
    const deps = fake({ failRun: 'build' })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out).toMatchObject({ ok: false })
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
  })

  it('第二个包发失败：回执里带上已经发出去的那一个', async () => {
    const deps = fake({ failPublish: path.normalize('/b') })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a', 'b'] }, deps)
    expect(out).toMatchObject({ ok: false })
    expect(out.ok === false && out.data?.shipped).toHaveLength(1)
  })

  it('团队源的地址', () => {
    expect(TEAM_REGISTRY).toBe('https://git.tianshen02.online:28377/api/packages/godcreator/npm/')
  })
})

describe('发布目标（GWB-17）', () => {
  const LOCAL = 'http://localhost:9999/'

  it('publishTargetOf：写了 publishConfig.registry 就是它；没写 publishConfig 或没写 registry 是团队源', () => {
    expect(publishTargetOf({ publishConfig: { registry: LOCAL } })).toEqual({ ok: true, registry: LOCAL })
    expect(publishTargetOf({ publishConfig: { registry: 'https://npm.example.com/api/npm' } })).toEqual({ ok: true, registry: 'https://npm.example.com/api/npm' })
    expect(publishTargetOf({})).toEqual({ ok: true, registry: TEAM_REGISTRY })
    expect(publishTargetOf({ publishConfig: { access: 'public' } })).toEqual({ ok: true, registry: TEAM_REGISTRY })
  })

  it('publishTargetOf：publishConfig 不是对象、registry 不是 http(s) 地址：拒，不猜', () => {
    const rejected: unknown[] = [{ publishConfig: 'x' }, { publishConfig: [] }, { publishConfig: { registry: 1 } }, { publishConfig: { registry: '' } }, { publishConfig: { registry: 'localhost:9999' } }, { publishConfig: { registry: 'ftp://h/' } }]
    for (const doc of rejected) {
      const got = publishTargetOf(doc as Record<string, unknown>)
      expect(got.ok, JSON.stringify(doc)).toBe(false)
      if (!got.ok) expect(got.error).toContain('publishConfig')
    }
  })

  it('每个包发到自己的发布目标：写了 publishConfig.registry 的发到它，没写的发到团队源；查「同号已在源上」问的也是它', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: JSON.stringify({ name: A, version: '0.1.0', files: ['dist'], exports: EXPORTS, publishConfig: { registry: LOCAL } }),
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(true)
    expect(deps.calls).toContain(`已发过? ${A}@0.1.0 → ${LOCAL}`)
    expect(deps.calls).toContain(`已发过? ${B}@0.2.0 → ${TEAM_REGISTRY}`)
    expect(deps.calls).toContain(`publish 0.1.0 → ${LOCAL}`)
    expect(deps.calls).toContain(`publish 0.2.0 → ${TEAM_REGISTRY}`)
  })

  it('publishConfig.registry 写坏了：发之前拒，一个都不发，报错里点名是哪个包', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'b/package.json')]: JSON.stringify({ name: B, version: '0.2.0', files: ['dist'], exports: EXPORTS, publishConfig: { registry: 'localhost:9999' } }),
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain(B)
      expect(out.error).toContain('publishConfig.registry')
    }
    expect(deps.calls.some((one) => one.startsWith('publish '))).toBe(false)
  })

  it('查别的包的 latest 不指定源（由 .npmrc 的范围行决定）；peer 里别的范围下的插件也查，cordis 官方插件不查', async () => {
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
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain(`peer ${OTHER_SCOPE_PLUGIN} 是 "^0.4.0",源上 latest 0.5.0(不在同一条线`)
    const asked = deps.calls.filter((one) => one.startsWith('latest ')).sort()
    // 别的范围下的库（dev）不查 latest：外部开发者自己的库不强求
    expect(asked).toEqual([`latest ${OTHER_SCOPE_PLUGIN}`, `latest ${SHELL}`].sort())
  })
})
