import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import { ownEntryId, treeOf, type EntryTreeLike } from '../src/tree'
import { readEntries } from '../src/inventory'
import { remountEntry } from '../src/remount'

/**
 * plugin-manager 依赖 loader 没有写进文档的内部结构：从 `ctx.fiber.entry.parent.tree` 取条目树，
 * 用它的 create / update / remove / resolve 改 `cordis.yml`，从 `store` 读条目。这组测试搭一个和内核相同的环境
 * （根上下文指向 home、include 读 cordis.yml），把这些用法都跑一遍。loader、include、cordis 用的是 devDependencies
 * 里写死的精确版本，也就是 package.json 里 `gwb.testedKernel` 那个内核版本用的三个版本；内核换了其中任何一个，
 * 这三个 devDependencies 要跟着改成内核的版本，再跑这组测试。
 */

interface Captured {
  tree: EntryTreeLike
  entryId: string
}

let homeDir = ''
let loaderFiber: Fiber | undefined

afterEach(async () => {
  if (loaderFiber !== undefined) {
    await loaderFiber.dispose()
    await loaderFiber.await()
    loaderFiber = undefined
    // 卸载时 include 还会把 cordis.yml 写回一次（推迟到下一个宏任务），等它写完再删目录
    await flushWrite()
  }
  if (homeDir !== '') fs.rmSync(homeDir, { recursive: true, force: true })
  homeDir = ''
})

/** 照内核 main.ts 的顺序搭环境：根上下文指向 home → 注册 loader → 替它解析包名 → include 读 cordis.yml */
async function boot(yml: string, modules: Record<string, unknown>): Promise<Context> {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-loader-'))
  fs.writeFileSync(path.join(homeDir, 'cordis.yml'), yml)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(homeDir + path.sep).href
  loaderFiber = await ctx.plugin(Loader, {})
  const loader = (ctx as unknown as { loader: Record<string, unknown> & { builtins: Record<string, unknown> } }).loader
  loader['internal'] = {
    import: async (name: string) => {
      const found = modules[name]
      if (found === undefined) throw new Error(`测试里没有包 ${name}`)
      return found
    },
  }
  loader.builtins['include'] = Include
  const root = loader['root'] as { update(entries: unknown[]): Promise<void> }
  await root.update([{ id: 'home', name: 'cordis:include', config: { path: 'cordis.yml' } }])
  await (loader['await'] as () => Promise<void>).call(loader)
  return ctx
}

/** include 把写回 cordis.yml 推迟到下一个宏任务，读文件之前先等一下 */
const flushWrite = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))
const readYml = (): string => fs.readFileSync(path.join(homeDir, 'cordis.yml'), 'utf8')

describe('真实的 loader 条目树', () => {
  it('从插件自己的上下文取到条目树与自己的 entryId', async () => {
    let captured: Captured | undefined
    const probe = { name: 'probe', apply: (ctx: never) => { captured = { tree: treeOf(ctx), entryId: ownEntryId(ctx) } } }
    await boot('- id: probe\n  name: probe\n', { probe })
    expect(captured).toBeDefined()
    expect(captured!.entryId).toBe('home:probe')
    expect(Object.keys(captured!.tree.store)).toContain('probe')
  })

  it('create、update、remove 改的是内存里的条目，也写回 cordis.yml', async () => {
    let captured: Captured | undefined
    const probe = { name: 'probe', apply: (ctx: never) => { captured = { tree: treeOf(ctx), entryId: ownEntryId(ctx) } } }
    const other = { name: 'other', apply: () => undefined }
    await boot('- id: probe\n  name: probe\n', { probe, other })
    const tree = captured!.tree

    const id = await tree.create({ id: 'other', name: 'other' }, null)
    expect(id).toContain('other')
    const entries = readEntries(tree.store)
    expect(entries.map((entry) => entry.pkg)).toContain('other')
    await flushWrite()
    expect(readYml()).toMatch(/name: other/)

    await tree.update('other', { disabled: true })
    await flushWrite()
    expect(readYml()).toMatch(/disabled: true/)

    tree.remove('other')
    await flushWrite()
    expect(readYml()).not.toMatch(/name: other/)
    expect(Object.keys(tree.store)).not.toContain('other')
  })

  it('停用再启用会重新加载，最后是 ACTIVE', async () => {
    let captured: Captured | undefined
    let applied = 0
    const probe = { name: 'probe', apply: (ctx: never) => { captured = { tree: treeOf(ctx), entryId: ownEntryId(ctx) } } }
    const other = { name: 'other', apply: () => { applied += 1 } }
    await boot('- id: probe\n  name: probe\n- id: other\n  name: other\n', { probe, other })
    expect(applied).toBe(1)

    const state = await remountEntry(captured!.tree, 'other', 2000)
    expect(state).toBe('ACTIVE')
    expect(applied).toBe(2)
  })
})
