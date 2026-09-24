import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_REGISTRY } from '../src/dev.js'
import {
  checkTicket,
  dirtyLines,
  peerProblems,
  requiresProblems,
  runRelease,
  testedKernelProblems,
  ticketManifestOf,
  ticketRefusal,
  typecheckArgs,
  type ReleaseDeps,
} from '../src/release.js'

/**
 * 发正式版这条链比开发版多一道「git 树干净」的守卫、少一整个 home 那半——测的就是这些
 * 差出来的部分:守卫的次序(全在发第一个包之前)、范围怎么写(>= 而不是钉准确号)、
 * 同号拒发时那句话有没有把「去仓里抬号」说清。全是边角上现形的判断,假件里跑得完。
 */

const REPO = 'D:/fake-repo'
const A = '@godcreator/gwb-fake-a'
const B = '@godcreator/gwb-fake-b'

const SHELL = '@godcreator/gwb-shell'
const API = '@godcreator/gwb-plugin-api'
const REACT = '@godcreator/gwb-shared-react'

const KERNEL = '0.2.7'

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
  testedKernel: undefined,
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

describe('peerProblems：插件包的 peer 只写 cordis', () => {
  it('只有 peer cordis 且产物 import 了 cordis：干净', () => {
    expect(peerProblems(T({ cordis: '^4.0.0-rc.9' }, {}, '0.3.0', true), true)).toEqual({ problems: [], reminders: [] })
  })

  it('cordis 以外的 peer 一律拒，逐条说按「运行时谁提供」写 dev 还是 dependencies', () => {
    const got = peerProblems(T({ [SHELL]: '^0.13.3', [API]: '^0.2.7', react: '^19.0.0' }, {}, '0.3.0', true), false)
    expect(got.problems).toEqual([
      expect.stringContaining(`peer 写了 ${SHELL}`),
      expect.stringContaining(`peer 写了 ${API}`),
      expect.stringContaining('peer 写了 react'),
    ])
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

describe('ticketManifestOf：是不是插件、测过的内核版本', () => {
  it('keywords 含 gwb-plugin 的是插件，gwb.testedKernel 原样读出', () => {
    expect(ticketManifestOf(pluginManifestOf(A, '0.3.0', { testedKernel: '0.2.7' }))).toMatchObject({ plugin: true, testedKernel: '0.2.7' })
  })

  it('没有 gwb-plugin 的不是插件；gwb.testedKernel 没写或不是字符串时是 undefined', () => {
    expect(ticketManifestOf(manifestOf(A, '0.3.0'))).toMatchObject({ plugin: false, testedKernel: undefined })
    expect(ticketManifestOf(pluginManifestOf(A, '0.3.0', { testedKernel: 27 }))).toMatchObject({ plugin: true, testedKernel: undefined })
  })
})

describe('testedKernelProblems：插件包的 gwb.testedKernel', () => {
  const P = (testedKernel: string | undefined, plugin = true) => ({ name: A, version: '0.3.0', peers: {}, devs: {}, plugin, testedKernel, requires: undefined, allDevs: {} })

  it('和运行中的内核在同一条版本线上：放行（0.x 比前两位，≥1 只比主版本号）', () => {
    expect(testedKernelProblems(P('0.2.1'), '0.2.7')).toEqual([])
    expect(testedKernelProblems(P('1.0.0'), '1.9.4')).toEqual([])
  })

  it('不是插件包：不查', () => {
    expect(testedKernelProblems(P(undefined, false), '0.2.7')).toEqual([])
  })

  it('没写：拒，说在哪儿写、写什么', () => {
    expect(testedKernelProblems(P(undefined), '0.2.7')).toEqual([expect.stringContaining('没写 gwb.testedKernel')])
    expect(testedKernelProblems(P(undefined), '0.2.7')[0]).toContain('"testedKernel": "0.2.7"')
  })

  it('不是合法版本号：拒', () => {
    expect(testedKernelProblems(P('^0.2.0'), '0.2.7')).toEqual([expect.stringContaining('不是合法的版本号')])
  })

  it('版本线不同：拒，说改成运行中的内核版本', () => {
    const got = testedKernelProblems(P('0.1.9'), '0.2.7')
    expect(got).toEqual([expect.stringContaining('不在同一条版本线上')])
    expect(got[0]).toContain('"0.2.7"')
    expect(testedKernelProblems(P('1.9.4'), '2.0.0')).toHaveLength(1)
  })

  it('运行中的内核版本号不合法：直接抛错', () => {
    expect(() => testedKernelProblems(P('0.2.7'), 'dev')).toThrow(/运行中的内核版本号/)
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
    testedKernel: KERNEL,
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
        [path.resolve(REPO, 'b/package.json')]: pluginManifestOf(B, '0.2.0', { testedKernel: KERNEL }, {
          peerDependencies: { [API]: '^0.1.1' },
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
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', { testedKernel: KERNEL }),
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
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', { testedKernel: KERNEL }, { peerDependencies: { cordis: '^4.0.0-rc.9' } }),
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data.reminders).toEqual([expect.stringContaining(`${A}@0.1.0:写了 peer cordis`)])
  })

  it('插件包的 gwb.testedKernel 不对：构建之后、发之前拒，一个都不发，每个包的问题一次列全', async () => {
    const deps = fake({
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0'),
        [path.resolve(REPO, 'b/package.json')]: pluginManifestOf(B, '0.2.0', { testedKernel: '0.1.4' }),
      },
    })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(true)
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(out.error).toContain('2 个包 2 条')
    expect(out.error).toContain(`${A}@0.1.0:\n  - 没写 gwb.testedKernel`)
    expect(out.error).toContain(`${B}@0.2.0:\n  - gwb.testedKernel 是 0.1.4`)
  })

  it('插件包的 gwb.requires 不对：构建之后、发之前拒，一个都不发；写对了照常发', async () => {
    const wrong = fake({
      latest: { [SHELL]: '0.5.0' },
      files: {
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', { testedKernel: KERNEL, requires: { [SHELL]: '0.5.1' } }, { devDependencies: { [SHELL]: '^0.5.0' } }),
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
        [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', { testedKernel: KERNEL, requires: { [SHELL]: '0.5.0' } }, { devDependencies: { [SHELL]: '^0.5.0' } }),
      },
    })
    const shipped = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, right)
    expect(shipped.ok).toBe(true)
  })

  it('插件包的 gwb.testedKernel 和运行中的内核同线：照常发', async () => {
    const deps = fake({ files: { [path.resolve(REPO, 'a/package.json')]: pluginManifestOf(A, '0.1.0', { testedKernel: '0.2.3' }) } })
    const out = await runRelease({ repoDir: REPO, runningKernel: KERNEL, packages: ['a'] }, deps)
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
