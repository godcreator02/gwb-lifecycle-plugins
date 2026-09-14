import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_REGISTRY } from '../src/dev.js'
import { dirtyLines, runRelease, type ReleaseDeps } from '../src/release.js'

/**
 * 发正式版这条链比开发版多一道「git 树干净」的守卫、少一整个 home 那半——测的就是这些
 * 差出来的部分:守卫的次序(全在发第一个包之前)、范围怎么写(>= 而不是钉准确号)、
 * 同号拒发时那句话有没有把「去仓里抬号」说清。全是边角上现形的判断,假件里跑得完。
 */

const REPO = 'D:/fake-repo'
const A = '@team/gwb-fake-a'
const B = '@team/gwb-fake-b'

function manifestOf(name: string, version: string, files: string[] = ['dist']): string {
  return JSON.stringify({ name, version, files })
}

interface FakeOptions {
  files?: Record<string, string>
  published?: string[]
  dirty?: string[]
  gitError?: boolean
  failRun?: string
  failPublish?: string
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
  }
}

describe('porcelain 认脏', () => {
  it('两列状态加路径才是脏；stderr 里的噪音不算', () => {
    const out = dirtyLines(' M src/x.ts\n?? out/\nwarning: unable to access\nR  old.ts -> new.ts\n')
    expect(out).toEqual([' M src/x.ts', '?? out/', 'R  old.ts -> new.ts'])
  })
})

describe('发正式版', () => {
  it('守卫在最前、构建次之、按给定顺序发、范围是 >= 新号', async () => {
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
    expect(deps.ranges).toEqual([{ [A]: '>=0.1.0', [B]: '>=0.2.0' }, { [A]: '>=0.1.0', [B]: '>=0.2.0' }])
    expect(out.data.note).toContain('plugin-manager.update-all')
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
