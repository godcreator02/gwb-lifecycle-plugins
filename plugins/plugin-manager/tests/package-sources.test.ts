import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GwbResult } from '@godcreator/gwb-kernel-desktop'
import { addSource, listSources, removeSource, searchPlugins, type PackageSourcesDeps } from '../src/package-sources.js'

/**
 * 找插件与配包源的命令逻辑：两份 npmrc 放在临时目录里真读真写，`settings.get` 与 registry 的检索接口用假实现。
 * 真实 registry 与真实的设置插件只能实机验证。
 */

const GITEA = 'https://git.tianshen02.online:28377'

let dir: string
let settings: Record<string, string>
let deps: PackageSourcesDeps

function writeFile(file: string, text: string): void {
  fs.writeFileSync(file, text, 'utf8')
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-sources-test-'))
  settings = {}
  deps = {
    userNpmrc: path.join(dir, 'user.npmrc'),
    homeNpmrc: path.join(dir, 'home.npmrc'),
    runCommand: (name: string, args: unknown): Promise<GwbResult> => {
      expect(name).toBe('settings.get')
      const key = (args as { section: string; key: string }).key
      const value = settings[key]
      return Promise.resolve(value === undefined ? { ok: false, error: '没存' } : { ok: true, data: value })
    },
    log: { info: () => undefined, warn: () => undefined },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('source.add', () => {
  it('owner 写法：地址按设置里的 base-url 拼，token 取设置，回执里 token 已遮掉', async () => {
    settings['base-url'] = 'https://gitea.example'
    settings['token'] = 't-secret'
    const got = await addSource(deps, '@j', { owner: 'J' })
    expect(got).toEqual({
      ok: true,
      scope: '@j',
      registry: 'https://gitea.example/api/packages/J/npm/',
      tokenWritten: true,
      replaced: false,
      lines: ['@j:registry=https://gitea.example/api/packages/J/npm/', '//gitea.example/api/packages/J/npm/:_authToken=***'],
    })
    expect(read(deps.userNpmrc)).toContain('//gitea.example/api/packages/J/npm/:_authToken=t-secret')
    expect(JSON.stringify(got)).not.toContain('t-secret')
  })

  it('设置里没有 base-url：按默认 gitea 实例拼，note 里说明', async () => {
    settings['token'] = 't'
    const got = await addSource(deps, '@j', { owner: 'J' })
    expect(got.registry).toBe(`${GITEA}/api/packages/J/npm/`)
    expect(got.note).toContain('gitea.base-url')
  })

  it('owner 写法取不到 token：ok:false，机器级 npmrc 不动', async () => {
    const got = await addSource(deps, '@j', { owner: 'J' })
    expect(got.ok).toBe(false)
    expect(got.error).toContain('gitea.token')
    expect(fs.existsSync(deps.userNpmrc)).toBe(false)
  })

  it('home 级有同名 scope 指向别处：写成了，note 提醒 pnpm 用的是 home 级那条', async () => {
    writeFile(deps.homeNpmrc, '@j:registry=https://other.example/npm/\n')
    const got = await addSource(deps, '@j', { registry: 'https://j.example/npm' })
    expect(got.ok).toBe(true)
    expect(got.registry).toBe('https://j.example/npm/')
    expect(got.note).toContain('pnpm 会用那一条')
    expect(read(deps.homeNpmrc)).toBe('@j:registry=https://other.example/npm/\n')
  })

  it('调用方写错直接抛：@godcreator、registry 与 owner 同给或都不给、scope 形状不对', async () => {
    await expect(addSource(deps, '@godcreator', { registry: 'https://x.example/' })).rejects.toThrow('不改它')
    await expect(addSource(deps, '@j', { registry: 'https://x.example/', owner: 'J' })).rejects.toThrow('只给一个')
    await expect(addSource(deps, '@j', {})).rejects.toThrow('必须给一个')
    await expect(addSource(deps, 'j', { registry: 'https://x.example/' })).rejects.toThrow('@xxx')
  })
})

describe('source.list', () => {
  it('两层合起来、带出处，token 只报有没有', async () => {
    writeFile(deps.userNpmrc, '@j:registry=https://j.example/npm/\n//j.example/npm/:_authToken=t\n')
    writeFile(deps.homeNpmrc, '@k:registry=https://k.example/npm/\n')
    expect(await listSources(deps)).toEqual({
      user: deps.userNpmrc,
      home: deps.homeNpmrc,
      sources: [
        { scope: '@j', registry: 'https://j.example/npm/', file: 'user', token: true },
        { scope: '@k', registry: 'https://k.example/npm/', file: 'home', token: false },
      ],
    })
  })
})

describe('source.remove', () => {
  it('删掉机器级的路由与没人指向的 token 行', async () => {
    writeFile(deps.userNpmrc, '@j:registry=https://j.example/npm/\n//j.example/npm/:_authToken=t\n')
    expect(await removeSource(deps, '@j')).toEqual({ ok: true, scope: '@j', registry: 'https://j.example/npm/' })
    expect(read(deps.userNpmrc)).toBe('')
  })

  it('只在 home 级有：ok:false，说明要手工删', async () => {
    writeFile(deps.homeNpmrc, '@j:registry=https://j.example/npm/\n')
    const got = await removeSource(deps, '@j')
    expect(got.ok).toBe(false)
    expect(got.error).toContain('手工删')
  })

  it('@godcreator 不许删', async () => {
    await expect(removeSource(deps, '@godcreator')).rejects.toThrow('不删它')
  })
})

describe('search', () => {
  const body = (names: string[]): string =>
    JSON.stringify({ objects: names.map((name) => ({ package: { name, version: '1.0.0', keywords: ['gwb-plugin'] } })), total: names.length, time: 0 })

  it('不给 scope 查全部配好的源：@godcreator 在前，一条失败只进 note；带上这条源的 token', async () => {
    writeFile(deps.userNpmrc, [
      '@godcreator:registry=https://god.example/npm/',
      '@j:registry=https://j.example/npm/',
      '//j.example/npm/:_authToken=t-j',
      '@dead:registry=https://dead.example/npm/',
      '',
    ].join('\n'))
    const seen: { url: string; auth?: string }[] = []
    vi.stubGlobal('fetch', (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, ...(init?.headers === undefined ? {} : { auth: init.headers['Authorization'] }) })
      if (url.startsWith('https://dead.example/')) return Promise.reject(new Error('连不上'))
      const name = url.startsWith('https://god.example/') ? '@godcreator/gwb-shell' : '@j/gwb-planner'
      return Promise.resolve(new Response(body([name])))
    })

    const got = await searchPlugins(deps)
    expect(got.ok).toBe(true)
    expect(got.packages?.map((row) => row.pkg)).toEqual(['@godcreator/gwb-shell', '@j/gwb-planner'])
    expect(got.note).toContain('@dead')
    expect(seen.find((one) => one.url.startsWith('https://j.example/'))?.auth).toBe('Bearer t-j')
    expect(seen.find((one) => one.url.startsWith('https://god.example/'))?.auth).toBeUndefined()
  })

  it('全部源都没查成才 ok:false', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 500 })))
    const got = await searchPlugins(deps)
    expect(got.ok).toBe(false)
    expect(got.error).toContain('一条源都没查成')
  })

  it('给了形状不对的 scope：ok:false 带说明，不发请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const got = await searchPlugins(deps, 'j')
    expect(got.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
