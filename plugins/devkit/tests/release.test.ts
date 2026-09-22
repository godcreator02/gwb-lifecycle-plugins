import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_REGISTRY } from '../src/dev.js'
import { checkTicket, dirtyLines, runRelease, ticketRefusal, type ReleaseDeps } from '../src/release.js'

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

function manifestOf(name: string, version: string, files: string[] = ['dist']): string {
  return JSON.stringify({ name, version, files })
}

function full(name: string, version: string, peerDependencies: Record<string, string>, devDependencies: Record<string, string>): string {
  return JSON.stringify({ name, version, files: ['dist'], peerDependencies, devDependencies })
}

const T = (peers: Record<string, string>, devs: Record<string, string>, version = '0.3.0') => ({ name: A, version, peers, devs })

describe('checkTicket：上车检票', () => {
  it('全按规矩：^<dev 钉>、dev 钉＝latest、workspace:* 跳过——干净', () => {
    const got = checkTicket(T({ [SHELL]: '^0.9.0', [B]: '^0.2.0' }, { [SHELL]: '0.9.0', [B]: 'workspace:*' }), { [SHELL]: '0.9.0' }, { [B]: '0.2.0' })
    expect(got).toEqual({ pkg: `${A}@0.3.0`, problems: [], reminders: [] })
  })

  it('自己在 0.0.x：拒，先抬到 0.1.0', () => {
    const got = checkTicket(T({}, {}, '0.0.7'), {}, {})
    expect(got.problems).toHaveLength(1)
    expect(got.problems[0]).toContain('0.1.0')
  })

  it('peer 不是 ^x.y.z 一律拒，逐条说改成什么', () => {
    const got = checkTicket(
      T({ [SHELL]: '>=0.9.0', [API]: '0.1.2', [REACT]: 'workspace:*' }, { [SHELL]: '0.9.0', [API]: '0.1.2', [REACT]: 'workspace:*' }),
      { [SHELL]: '0.9.0', [API]: '0.1.2' },
      { [REACT]: '0.1.0' },
    )
    expect(got.problems).toEqual([
      expect.stringContaining(`peer ${SHELL} 写的是 ">=0.9.0"`),
      expect.stringContaining(`peer ${API} 写的是 "0.1.2"`),
      expect.stringContaining(`peer ${REACT} 写的是 "workspace:*"`),
    ])
    expect(got.problems[0]).toContain('"^0.9.0"')
    expect(got.problems[2]).toContain('"^0.1.0"')
  })

  it('dev 范围罩住 latest 即放行（精确钉与 ^ 皆可）；出范围才拒', () => {
    const exactInRange = checkTicket(T({ [SHELL]: '^0.8.0' }, { [SHELL]: '0.8.0' }), { [SHELL]: '0.8.3' }, {})
    expect(exactInRange.problems).toEqual([])
    const caretDev = checkTicket(T({ [SHELL]: '^0.8.0' }, { [SHELL]: '^0.8.0' }), { [SHELL]: '0.8.3' }, {})
    expect(caretDev.problems).toEqual([])
    const outRange = checkTicket(T({ [SHELL]: '^0.8.0' }, { [SHELL]: '0.8.0' }), { [SHELL]: '0.9.0' }, {})
    expect(outRange.problems[0]).toContain('出范围')
    expect(outRange.problems[0]).toContain('先适配代码')
  })

  it('dev 比 latest 新、问不出 latest、dev 写法认不出：都拒', () => {
    const got = checkTicket(T({}, { [SHELL]: '0.9.1', [API]: '0.1.2', [REACT]: '~0.0.4' }), { [SHELL]: '0.9.0', [REACT]: '0.0.4' }, {})
    expect(got.problems).toEqual([
      expect.stringContaining('没发的号'),
      expect.stringContaining('问不出'),
      expect.stringContaining('要写 ^<验过的号>'),
    ])
  })

  it('peer 下限 ≠ dev 下限：拒（dev 下限已是 latest 也拒）', () => {
    const got = checkTicket(T({ [SHELL]: '^0.9.0' }, { [SHELL]: '0.9.2' }), { [SHELL]: '0.9.2' }, {})
    expect(got.problems).toEqual([expect.stringContaining('下限 0.9.0 ≠ dev 下限 0.9.2')])
  })

  it('peer 指向的上游自己还在 0.0.x：不拒，只提醒', () => {
    const got = checkTicket(T({ [REACT]: '^0.0.4' }, { [REACT]: '0.0.4' }), { [REACT]: '0.0.4' }, {})
    expect(got.problems).toEqual([])
    expect(got.reminders).toEqual([expect.stringContaining('0.1.0')])
  })

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

interface FakeOptions {
  files?: Record<string, string>
  published?: string[]
  dirty?: string[]
  gitError?: boolean
  failRun?: string
  failPublish?: string
  latest?: Record<string, string>
}

function fake(options: FakeOptions = {}): ReleaseDeps & { calls: string[]; ranges: Record<string, string>[] } {
  const calls: string[] = []
  const ranges: Record<string, string>[] = []
  const files: Record<string, string> = {
    [path.resolve(REPO, 'a/package.json')]: manifestOf(A, '0.1.0'),
    [path.resolve(REPO, 'b/package.json')]: manifestOf(B, '0.2.0'),
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
    workspaceVersions: () => ({ [A]: '0.1.0', [B]: '0.2.0' }),
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
    expect(out.data.note).toContain('plugin-manager.update-all')
    expect(out.data.reminders).toEqual([])
  })

  it('检票没过：构建之后、发之前拒，一个都不发，所有包的问题一次列全', async () => {
    const deps = fake({
      latest: { [SHELL]: '0.9.0', [API]: '0.2.0' },
      files: {
        [path.resolve(REPO, 'a/package.json')]: full(A, '0.0.3', { [SHELL]: '>=0.8.0' }, { [SHELL]: '0.8.0' }),
        [path.resolve(REPO, 'b/package.json')]: full(B, '0.2.0', { [API]: '^0.1.1' }, { [API]: '0.1.1' }),
      },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a', 'b'] }, deps)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(deps.calls.some((one) => one.includes('pnpm build'))).toBe(true)
    expect(deps.calls.some((one) => one.startsWith('publish'))).toBe(false)
    expect(out.error).toContain(`${A}@0.0.3`)
    expect(out.error).toContain(`${B}@0.2.0`)
    expect(out.error).toContain('抬到 0.1.0')
    expect(out.error).toContain('"^0.9.0"')
    expect(out.error).toContain('出范围')
    expect(out.error).toContain('2 个包 4 条')
  })

  it('检票过了：上游还在 0.0.x 的 peer 只提醒不拒，提醒带进回执', async () => {
    const deps = fake({
      latest: { [REACT]: '0.0.4' },
      files: { [path.resolve(REPO, 'a/package.json')]: full(A, '0.1.0', { [REACT]: '^0.0.4' }, { [REACT]: '0.0.4' }) },
    })
    const out = await runRelease({ repoDir: REPO, packages: ['a'] }, deps)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data.reminders.join('\n')).toContain('0.0.4')
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

  it('仓根不是个能发的包时说清「包目录给的是相对仓根的路径」', async () => {
    const deps = fake()
    const out = await runRelease({ repoDir: REPO, packages: [] }, deps)
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

  it('源是团队源', () => {
    expect(DEFAULT_REGISTRY).toContain('tianshen02')
  })
})
