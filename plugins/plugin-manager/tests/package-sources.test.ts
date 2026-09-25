import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { searchPlugins, type PackageSourcesDeps } from '../src/package-sources.js'

/**
 * `search` 的逻辑：两份 npmrc 放在临时目录里真读，registry 的检索接口用假实现。真实 registry 只能实机验证。
 */

let dir: string
let deps: PackageSourcesDeps

function writeFile(file: string, text: string): void {
  fs.writeFileSync(file, text, 'utf8')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-sources-test-'))
  deps = {
    userNpmrc: path.join(dir, 'user.npmrc'),
    homeNpmrc: path.join(dir, 'home.npmrc'),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('search', () => {
  const body = (names: string[]): string =>
    JSON.stringify({ objects: names.map((name) => ({ package: { name, version: '1.0.0', keywords: ['gwb-plugin'] } })), total: names.length, time: 0 })

  it('查全部配好的源：@godcreator 在前，一条失败只进 note；带上这条源的 token；每行只有 pkg / version / description', async () => {
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
    const data = got.ok ? got.data : undefined
    expect(data?.packages).toEqual([
      { pkg: '@godcreator/gwb-shell', version: '1.0.0' },
      { pkg: '@j/gwb-planner', version: '1.0.0' },
    ])
    expect(data?.note).toContain('@dead')
    expect(seen.find((one) => one.url.startsWith('https://j.example/'))?.auth).toBe('Bearer t-j')
    expect(seen.find((one) => one.url.startsWith('https://god.example/'))?.auth).toBeUndefined()
  })

  it('home 级 npmrc 里的 scope 也查，同名 scope 用 home 级那条的源与 token', async () => {
    writeFile(deps.userNpmrc, '@j:registry=https://user.example/npm/\n')
    writeFile(deps.homeNpmrc, '@j:registry=https://home.example/npm/\n//home.example/npm/:_authToken=t-home\n@k:registry=https://k.example/npm/\n')
    const seen: { url: string; auth?: string }[] = []
    vi.stubGlobal('fetch', (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, ...(init?.headers === undefined ? {} : { auth: init.headers['Authorization'] }) })
      return Promise.resolve(new Response(body([])))
    })

    expect(await searchPlugins(deps)).toEqual({ ok: true, data: { packages: [] } })
    expect(seen.some((one) => one.url.startsWith('https://user.example/'))).toBe(false)
    expect(seen.find((one) => one.url.startsWith('https://home.example/'))?.auth).toBe('Bearer t-home')
    expect(seen.some((one) => one.url.startsWith('https://k.example/'))).toBe(true)
  })

  it('全部源都没查成才 ok:false', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 500 })))
    expect(await searchPlugins(deps)).toEqual({ ok: false, error: expect.stringContaining('一条源都没查成') as unknown })
  })
})
