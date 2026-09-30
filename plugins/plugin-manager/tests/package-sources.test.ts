import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchPlugins, type PackageSourcesDeps } from '../src/package-sources.js'

/**
 * `search` 的逻辑：市场名单与 pnpm 的配置、凭据都用假的给，registry 的检索接口用假实现。
 * 真的 pnpm 与 registry 只能实机验证
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const body = (names: string[]): string =>
  JSON.stringify({ objects: names.map((name) => ({ package: { name, version: '1.0.0', keywords: ['gwb-plugin'] } })), total: names.length, time: 0 })

function depsWith(markets: unknown, config: Record<string, unknown>, tokens: Record<string, string> = {}): PackageSourcesDeps {
  return {
    markets,
    readPnpmConfig: () => Promise.resolve({ ok: true, data: config }),
    readPnpmConfigValue: (key) => Promise.resolve(tokens[key]),
  }
}

type Seen = { url: string; auth?: string }

function stubFetch(respond: (url: string) => Promise<Response>): Seen[] {
  const seen: Seen[] = []
  vi.stubGlobal('fetch', (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, ...(init?.headers === undefined ? {} : { auth: init.headers['Authorization'] }) })
    return respond(url)
  })
  return seen
}

describe('search', () => {
  it('只查名单里的市场，顺序照名单；带上这条源的凭据；一个失败只进 note 与它的状态', async () => {
    const config = {
      '@godcreator:registry': 'https://god.example/npm/',
      '@j:registry': 'https://j.example/npm/',
      '@dead:registry': 'https://dead.example/npm/',
      '@company:registry': 'https://company.example/npm/',
      registry: 'https://registry.npmjs.org/',
    }
    const seen = stubFetch((url) => {
      if (url.startsWith('https://dead.example/')) return Promise.reject(new Error('连不上'))
      return Promise.resolve(new Response(body([url.startsWith('https://god.example/') ? '@godcreator/gwb-shell' : '@j/gwb-planner'])))
    })

    const got = await searchPlugins(depsWith(['@godcreator', '@j', '@dead'], config, { '//j.example/npm/:_authToken': 't-j' }))
    const data = got.ok ? got.data : undefined
    expect(data?.packages).toEqual([
      { pkg: '@godcreator/gwb-shell', version: '1.0.0' },
      { pkg: '@j/gwb-planner', version: '1.0.0' },
    ])
    expect(data?.markets).toEqual([
      { scope: '@godcreator', registry: 'https://god.example/npm/', ok: true, count: 1 },
      { scope: '@j', registry: 'https://j.example/npm/', ok: true, count: 1 },
      { scope: '@dead', registry: 'https://dead.example/npm/', ok: false, error: expect.stringContaining('连不上') as unknown },
    ])
    expect(data?.note).toContain('@dead')
    expect(seen.find((one) => one.url.startsWith('https://j.example/'))?.auth).toBe('Bearer t-j')
    expect(seen.find((one) => one.url.startsWith('https://god.example/'))?.auth).toBeUndefined()
    expect(seen.some((one) => one.url.startsWith('https://company.example/'))).toBe(false)
  })

  it('名单里的市场在 pnpm 里没配源：这个市场报没配源，不去全局源查', async () => {
    const seen = stubFetch(() => Promise.resolve(new Response(body([]))))
    const got = await searchPlugins(depsWith(['@godcreator', '@j'], { '@godcreator:registry': 'https://god.example/npm/', registry: 'https://registry.npmjs.org/' }))
    expect(got.ok ? got.data.markets[1] : undefined).toEqual({ scope: '@j', ok: false, error: expect.stringContaining('pnpm 里没配这个市场的源') as unknown })
    expect(seen.map((one) => one.url)).toEqual([expect.stringMatching(/^https:\/\/god\.example\//) as unknown])
  })

  it('一个市场都没查成才 ok:false，原因逐个写明', async () => {
    stubFetch(() => Promise.resolve(new Response('nope', { status: 500 })))
    const got = await searchPlugins(depsWith(['@godcreator', '@j'], { '@godcreator:registry': 'https://god.example/npm/', registry: 'https://registry.npmjs.org/' }))
    expect(got).toEqual({ ok: false, error: expect.stringContaining('一个市场都没查成') as unknown })
    expect(got.ok ? '' : got.error).toContain('@j：pnpm 里没配这个市场的源')
  })

  it('名单是空的、pnpm 配置没取到：ok:false 说清原因，不查任何源', async () => {
    const seen = stubFetch(() => Promise.resolve(new Response(body([]))))
    expect(await searchPlugins(depsWith([], {}))).toEqual({ ok: false, error: expect.stringContaining('市场名单是空的') as unknown })
    const noConfig: PackageSourcesDeps = { ...depsWith(['@godcreator'], {}), readPnpmConfig: () => Promise.resolve({ ok: false, error: '退出码 1' }) }
    expect(await searchPlugins(noConfig)).toEqual({ ok: false, error: '问 pnpm 要配置没成：退出码 1' })
    expect(seen).toEqual([])
  })

  it('名单不是字符串数组：直接抛错', async () => {
    await expect(searchPlugins(depsWith('@godcreator', {}))).rejects.toThrow('要是字符串数组')
  })
})
