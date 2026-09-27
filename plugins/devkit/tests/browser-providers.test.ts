import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectBrowserImports } from '../src/browser-providers.js'

describe('浏览器模块代码出口', () => {
  it('只读取自身和直接 peer 的代码出口，检查目标存在，不扫描无关包', async () => {
    const root = path.resolve('/consumer')
    const provider = path.join(root, 'node_modules', '@demo', 'provider')
    const target = path.join(provider, 'dist/runtime.js')
    const files = new Map([
      [path.join(provider, 'package.json'), JSON.stringify({ name: '@demo/provider', version: '0.1.0', files: ['dist'], exports: { './browser-imports': './dist/browser-imports.js' } })],
      [path.join(provider, 'dist/browser-imports.js'), 'export function browserImports() {}'],
      [target, 'export const value = 42'],
    ])
    const seen: string[] = []
    const got = await collectBrowserImports(root, { peerDependencies: { '@demo/provider': '^0.1.0' } }, {
      readText: file => files.get(file),
      importModule: async url => { seen.push(url); return { browserImports: () => ({ '@demo/runtime': pathToFileURL(target).href }) } },
    })
    expect(got).toEqual({ declared: true, imports: { '@demo/runtime': pathToFileURL(target).href }, problems: [] })
    expect(seen).toHaveLength(1)
    files.delete(target)
    expect((await collectBrowserImports(root, { peerDependencies: { '@demo/provider': '^0.1.0' } }, {
      readText: file => files.get(file), importModule: async () => ({ browserImports: () => ({ '@demo/runtime': pathToFileURL(target).href }) }),
    })).problems.join(' ')).toContain('目标文件不在')
  })

  it('声明为空也不回退旧内核，异步函数、包外目标和未发布文件都拒绝', async () => {
    const root = path.resolve('/provider')
    const manifest = { files: ['dist'], exports: { './browser-imports': './dist/browser-imports.js' } }
    const collect = (mapping: unknown) => collectBrowserImports(root, manifest, {
      readText: () => '', importModule: async () => ({ browserImports: () => mapping }),
    })
    expect(await collect({})).toEqual({ declared: true, imports: {}, problems: [] })
    expect((await collect(Promise.resolve({}))).problems.join()).toContain('同步')
    expect((await collect({ runtime: pathToFileURL(path.resolve('/elsewhere/runtime.js')).href })).problems.join()).toContain('不在提供方包内')
    expect((await collect({ runtime: pathToFileURL(path.join(root, 'src/runtime.js')).href })).problems.join()).toContain('files 白名单')
    expect((await collect({ constructor: pathToFileURL(path.join(root, 'dist/runtime.js')).href })).problems).toEqual([])
  })

  it('两个提供方提供同一名字的不同地址会阻止发版', async () => {
    const root = path.resolve('/provider')
    const peer = path.join(root, 'node_modules/peer')
    const manifest = { name: 'provider', version: '0.1.0', files: ['dist'], exports: { './browser-imports': './dist/browser-imports.js' }, peerDependencies: { peer: '^0.1.0' } }
    const got = await collectBrowserImports(root, manifest, {
      readText: file => file === path.join(peer, 'package.json') ? JSON.stringify({ ...manifest, name: 'peer' }) : '',
      importModule: async url => ({ browserImports: () => ({ runtime: new URL('./runtime.js', url).href }) }),
    })
    expect(got.problems.join()).toContain('提供方冲突')
  })
})
