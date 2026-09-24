import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_REGISTRY } from '../src/dev.js'
import { KERNEL_PACKAGE } from '../src/kernel-compat.js'
import {
  checkTicket,
  dirtyLines,
  kernelPeerProblems,
  peerProblems,
  requiresProblems,
  runRelease,
  ticketManifestOf,
  ticketRefusal,
  typecheckArgs,
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

const T = (peers: Record<string, string>, devs: Record<string, string>, version = '0.3.0', plugin = false) => ({
  name: A,
  version,
  peers,
  devs,
  plugin,
  requires: undefined,
  allDevs: devs,
})

describe('checkTicket：版本号与 dev 范围', () => {
  it('dev 钉＝latest、workspace:* 跳过——干净；peer 不归它查', () => {
    const got = checkTicket(T({ [SHELL]: '>=0.1.0' }, { [SHELL]: '0.9.0', [B]: 'workspace:*' }), { [SHELL]: '0.9.0' })
    expect(got).toEqual({ pkg: `${A}@0.3.0`, problems: [], reminders: [] })
  })

  it('自己在 0.0.x：拒，先抬到 0.1.0', () => {
    const got = checkTicket(T({}, {}, '0.0.7'), {})
    expect(got.problems).toHaveLength(1)
    expect(got.problems[0]).toContain('0.1.0')
  })

  it('dev 范围罩住 latest 即放行（精确钉与 ^ 皆可）；出范围才拒', () => {
    const exactInRange = checkTicket(T({}, { [SHELL]: '0.8.0' }), { [SHELL]: '0.8.3' })
    expect(exactInRange.problems).toEqual([])
    const caretDev = checkTicket(T({}, { [SHELL]: '^0.8.0' }), { [SHELL]: '0.8.3' })
    expect(caretDev.problems).toEqual([])
    const outRange = checkTicket(T({}, { [SHELL]: '0.8.0' }), { [SHELL]: '0.9.0' })
    expect(outRange.problems[0]).toContain('出范围')
    expect(outRange.problems[0]).toContain('先适配代码')
  })

  it('dev 比 latest 新、问不出 latest、dev 写法认不出：都拒', () => {
    const got = checkTicket(T({}, { [SHELL]: '0.9.1', [API]: '0.1.2', [REACT]: '~0.0.4' }), { [SHELL]: '0.9.0', [REACT]: '0.0.4' })
    expect(got.problems).toEqual([
      expect.stringContaining('没发的号'),
      expect.stringContaining('问不出'),
      expect.stringContaining('要写 ^<验过的号>'),
    ])
  })
})

describe('peerProblems：插件包的 peer 只写 cordis 与内核包', () => {
  it('peer 只有 cordis 与内核包、且产物 import 了 cordis：干净', () => {
    expect(peerProblems(T({ cordis: '^4.0.0-rc.9', ...KERNEL_PEER }, {}, '0.3.0', true), true)).toEqual({ problems: [], reminders: [] })
  })

  it('peer 只有内核包、产物没有 import cordis：干净', () => {
    expect(peerProblems(T(KERNEL_PEER, {}, '0.3.0', true), false)).toEqual({ problems: [], reminders: [] })
  })

  it('cordis 与内核包以外的 peer 一律拒，逐条说按「运行时谁提供」写 dev 还是 dependencies', () => {
    const got = peerProblems(T({ [SHELL]: '^0.13.3', [API]: '^0.2.7', react: '^19.0.0', ...KERNEL_PEER }, {}, '0.3.0', true), false)
    expect(got.problems).toEqual([
      expect.stringContaining(`peer 写了 ${SHELL}`),
      expect.stringContaining(`peer 写了 ${API}`),
      expect.stringContaining('peer 写了 react'),
    ])
    expect(got.problems[0]).toContain(KERNEL_PACKAGE)
    expect(got.problems[0]).toContain('devDependencies')
    expect(got.problems[0]).toContain('dependencies,并在清单里写明原因')
  })

  it('产物 import 了 cordis 而 peer 里没有：拒', () => {
    expect(peerProblems(T({}, {}, '0.3.0', true), true).problems).toEqual([expect.stringContaining('写 peer cordis')])
  })

  it('写了 peer cordis 而产物没有 import 它：只提醒', () => {
    const got = peerProblems(T({ cordis: '^4.0.0-rc.9' }, {}, '0.3.0', true), false)
    expect(got.problems).toEqual([])
    expect(got.reminders).toEqual([expect.stringContaining('只 import 类型时不写 peer')])
  })

  it('不是插件包：不查', () => {
    expect(peerProblems(T({ [SHELL]: '^0.13.3' }), true)).toEqual({ problems: [], reminders: [] })
  })
})

describe('ticketRefusal', () => {
  it('拒的回执按包分组、带总数', () => {
    const text = ticketRefusal([
      { pkg: `${A}@0.0.1`, problems: ['一', '二'], reminders: [] },
      { pkg: `${B}@0.2.0`, problems: [], reminders: [] },
    ])
    expect(text).toContain('1 个包 2 条')
    expect(text).toContain(`${A}@0.0.1:\n  - 一\n  - 二`)
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

describe('ticketManifestOf：gwb.requires 与全部 dev', () => {
  it('gwb.requires 原值读出，devDependencies 不分 scope 全部读出；没写 gwb.requires 时是 undefined', () => {
    const text = pluginManifestOf(A, '0.3.0', { requires: { [SHELL]: '0.5.0' } }, { devDependencies: { [SHELL]: '^0.5.0', react: '^19.0.0' } })
    expect(ticketManifestOf(text)).toMatchObject({ requires: { [SHELL]: '0.5.0' }, allDevs: { [SHELL]: '^0.5.0', react: '^19.0.0' }, devs: { [SHELL]: '^0.5.0' } })
    expect(ticketManifestOf(pluginManifestOf(A, '0.3.0'))).toMatchObject({ requires: undefined })
  })
})

describe('requiresProblems：插件包的 gwb.requires', () => {
  const R = (requires: unknown, allDevs: Record<string, string>, plugin = true) => ({
    name: A,
    version: '0.3.0',
    peers: {},
    devs: {},
    plugin,
    requires,
    allDevs,
  })

  it('每个包写在 dev 里、要求的版本不高于 dev 下限：放行（^ 与精确号都认）', () => {
    expect(requiresProblems(R({ [SHELL]: '0.5.0' }, { [SHELL]: '^0.5.0' }))).toEqual([])
    expect(requiresProblems(R({ [SHELL]: '0.4.2' }, { [SHELL]: '^0.5.0' }))).toEqual([])
    expect(requiresProblems(R({ [SHELL]: '0.5.0' }, { [SHELL]: '0.5.1' }))).toEqual([])
  })

  it('没写 gwb.requires、不是插件包：不查', () => {
    expect(requiresProblems(R(undefined, {}))).toEqual([])
    expect(requiresProblems(R({ [SHELL]: 'latest' }, {}, false))).toEqual([])
  })

  it('不是对象：拒，说要写成什么', () => {
    expect(requiresProblems(R([SHELL], {}))).toEqual([expect.stringContaining('要写成对象')])
    expect(requiresProblems(R('0.5.0', {}))).toHaveLength(1)
  })

  it('值不是合法的 x.y.z：拒（^、预发布段、少一段、不是字符串都算）', () => {
    for (const bad of ['^0.5.0', '0.5.0-rc.1', '0.5', 5]) {
      expect(requiresProblems(R({ [SHELL]: bad }, { [SHELL]: '^0.5.0' })), String(bad)).toEqual([expect.stringContaining('最低版本号要写成 x.y.z')])
    }
  })

  it('没写在 devDependencies 里：拒，说在 dev 里写上什么', () => {
    const got = requiresProblems(R({ [SHELL]: '0.5.0' }, {}))
    expect(got).toEqual([expect.stringContaining('devDependencies 里却没有')])
    expect(got[0]).toContain('"^0.5.0"')
  })

  it('要求的版本高于 dev 下限：拒，说把 dev 升到哪', () => {
    const got = requiresProblems(R({ [SHELL]: '0.5.1' }, { [SHELL]: '^0.5.0' }))
    expect(got).toEqual([expect.stringContaining('高于 devDependencies "^0.5.0" 的下限 0.5.0')])
    expect(got[0]).toContain('"^0.5.1"')
  })

  it('dev 写法认不出下限：拒；dev 写 workspace: 的不比下限', () => {
    expect(requiresProblems(R({ [SHELL]: '0.5.0' }, { [SHELL]: '>=0.5.0' }))).toEqual([expect.stringContaining('认不出下限')])
    expect(requiresProblems(R({ [SHELL]: '0.5.0' }, { [SHELL]: 'workspace:*' }))).toEqual([])
  })

  it('多条要求各查各的，问题一次列全', () => {
    expect(requiresProblems(R({ [SHELL]: '0.6.0', [API]: '0.2.0', [REACT]: 'x' }, { [SHELL]: '^0.5.0' }))).toHaveLength(3)
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
  /** 按哪份 tsconfig 做的类型检查没过：键是 -p 后面那份 tsconfig，值是输出 */
  typecheckFails?: Record<string, string>
}

/** 一条 run 是不是类型检查；是的话回它查的那份 tsconfig */
function typecheckedTsconfig(args: string[]): string | undefined {
  if (!args.includes('--skipLibCheck')) return undefined
  return args[args.indexOf('-p') + 1]
}

function fake(options: FakeOptions = {}): ReleaseDeps & { calls: string[]; ranges: Record<string, string>[] } {
  const calls: string[] = []
  const ranges: Record<string, string>[] = []
  const files: Record<string, string> = {
    [path.resolve(REPO, 'a/package.json')]: manifestOf(A, '0.1.0'),
    [path.resolve(REPO, 'b/package.json')]: manifestOf(B, '0.2.0'),
    [path.resolve(REPO, 'a/tsconfig.json')]: '{}',
    [path.resolve(REPO, 'b/tsconfig.json')]: '{}',
    [path.resolve(REPO, 'a/dist/index.js')]: "import path from 'node:path';\n",
    [path.resolve(REPO, 'b/dist/index.js')]: "import path from 'node:path';\n",
    ...options.files,
  }
  return {
    calls,
    ranges,
    platform: 'win32',
    readText: (file) => files[path.resolve(file)],
    exists: (target) => path.resolve(target) in files || target.endsWith('dist'),
    async gitStatus(repoDir) {
      calls.push(`git status @${repoDir}`)
      if (options.gitError === true) return { ok: false, error: 'fatal: not a git repository' }
      return { ok: true, dirty: options.dirty ?? [] }
    },
    async run(plan, _timeoutMs) {
      calls.push(`run ${plan.args.join(' ')} @${plan.cwd}`)
      const tsconfig = typecheckedTsconfig(plan.args)
      const typecheckOutput = tsconfig === undefined ? undefined : options.typecheckFails?.[tsconfig]
      if (typecheckOutput !== undefined) return { ok: false, tail: typecheckOutput }
      const ok = options.failRun === undefined || !plan.args.join(' ').includes(options.failRun)
      return { ok, tail: ok ? '' : '假的失败' }
    },
    async publish(input) {
      calls.push(`publish ${input.version} @${input.pkgDir}`)
      ranges.push(input.ranges)
      if (options.failPublish !== undefined && input.pkgDir.endsWith(options.failPublish)) {
        return { ok: false, tail: '假的失败' }
      }
      return { ok: true, tail: '' }
    },
    async published(spec) {
      return (options.published ?? []).includes(spec)
    },
    async latest(pkg) {
      calls.push(`latest ${pkg}`)
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
    expect(out.data.note).toContain('plugin-manager.update-all')
    expect(out.data.reminders).toEqual([])
  })

  it('发版前检查没过：构建之后、发之前拒，一个都不发，所有包的问题一次列全', async () => {
    const deps = fake({
      latest: { [SHELL]: '0.9.0', [API]: '0.2.0' },
      files: {
        [path.resolve(REPO, 'a/package.json')]: full(A, '0.0.3', { [SHELL]: '^0.8.0' }, { [SHELL]: '0.8.0' }),
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
    expect(out.error).toContain(`${A}@0.0.3`)
    expect(out.error).toContain(`${B}@0.2.0`)
    expect(out.error).toContain('抬到 0.1.0')
    expect(out.error).toContain('出范围')
    expect(out.error).toContain(`peer 写了 ${API}`)
    // a 不是插件包：peer 不查；a 两条（0.0.x、出范围），b 两条（出范围、peer）
    expect(out.error).toContain('2 个包 4 条')
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

  /** 一个包做过的类型检查，按先后列出查的那份 tsconfig */
  function typechecksOf(calls: string[], pkgDir: string): string[] {
    return calls
      .filter((one) => one.endsWith(` @${pkgDir}`) && one.includes('--skipLibCheck false'))
      .map((one) => typecheckedTsconfig(one.split(' ')) ?? '')
  }

  it('没有 tsconfig.build.json：在包目录里用 pnpm exec tsc、关掉 skipLibCheck 按 tsconfig.json 查；没过就拒，带上查的是哪份与输出尾巴', async () => {
    const deps = fake({ typecheckFails: { 'tsconfig.json': "index.d.ts(52,32): error TS2304: Cannot find name 'HTMLElement'." } })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(deps.calls).toContain(`run /c pnpm ${typecheckArgs('tsconfig.json').join(' ')} @${path.resolve(REPO, 'a')}`)
    expect(typechecksOf(deps.calls, path.resolve(REPO, 'a'))).toEqual(['tsconfig.json'])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('按 tsconfig.json 做的类型检查没过')
    expect(out.error).toContain('HTMLElement')
  })

  it('有 tsconfig.build.json：node 侧只按它查，不查带着测试与构建脚本的 tsconfig.json', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'a/tsconfig.build.json')]: '{}' } })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out.ok).toBe(true)
    expect(typechecksOf(deps.calls, path.resolve(REPO, 'a'))).toEqual(['tsconfig.build.json'])
  })

  it('有 src/client/tsconfig.json：浏览器侧再查一次，没过的那份写进回执', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/tsconfig.build.json')]: '{}',
        [path.resolve(REPO, 'a/src/client/tsconfig.json')]: '{}',
      },
      typecheckFails: { 'src/client/tsconfig.json': "index.tsx(3,1): error TS2307: Cannot find module 'react'." },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(typechecksOf(deps.calls, path.resolve(REPO, 'a'))).toEqual(['tsconfig.build.json', 'src/client/tsconfig.json'])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('1 个包 1 条')
    expect(out.error).toContain('按 src/client/tsconfig.json 做的类型检查没过')
  })

  it('包目录下 tsconfig.build.json 与 tsconfig.json 都没有：拒，不跑类型检查', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'c/package.json')]: manifestOf('@godcreator/gwb-fake-c', '0.1.0'),
        [path.resolve(REPO, 'c/dist/index.js')]: '',
        [path.resolve(REPO, 'c/src/client/tsconfig.json')]: '{}',
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['c'] }, deps)
    expect(typechecksOf(deps.calls, path.resolve(REPO, 'c'))).toEqual([])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('tsconfig.build.json 与 tsconfig.json 都没有')
  })

  it('检查过了：写了 peer cordis 而产物没 import 它，只提醒不拒，提醒带进回执', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', undefined, { peerDependencies: { cordis: '^4.0.0-rc.9', ...KERNEL_PEER } }),
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data.reminders).toEqual([expect.stringContaining(`${A}@0.1.0:写了 peer cordis`)])
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

  it('插件包的 gwb.requires 不对：构建之后、发之前拒，一个都不发；写对了照常发', async () => {
    const wrong = fake({
      latest: { [SHELL]: '0.5.0' },
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', { requires: { [SHELL]: '0.5.1' } }, { peerDependencies: KERNEL_PEER, devDependencies: { [SHELL]: '^0.5.0' } }),
      },
    })
    const refused = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, wrong)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(wrong.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(refused.error).toContain(`${A}@0.1.0:\n  - gwb.requires 要求 ${SHELL} ≥ 0.5.1`)

    const right = fake({
      latest: { [SHELL]: '0.5.0' },
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', { requires: { [SHELL]: '0.5.0' } }, { peerDependencies: KERNEL_PEER, devDependencies: { [SHELL]: '^0.5.0' } }),
      },
    })
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

  it('源是团队源', () => {
    expect(DEFAULT_REGISTRY).toContain('tianshen02')
  })
})
