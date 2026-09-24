import { describe, expect, it } from 'vitest'
import { importFacesOf } from '../src/capabilities.js'

/** 假的已装包表：包名 → package.json */
function manifestsOf(table: Record<string, unknown>): (pkg: string) => unknown {
  return (pkg) => table[pkg]
}

describe('importFacesOf：import 面聚合', () => {
  it('件：exports 入口、provides 按说明符键 join、dts 从 types 拼', async () => {
    const table = {
      '@godcreator/gwb-settings': {
        version: '0.2.4',
        keywords: ['gwb', 'gwb-plugin'],
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './package.json': './package.json' },
        gwb: { provides: { '@godcreator/gwb-settings': { summary: '设置面', usage: 'define …' } } },
      },
    }
    const out = await importFacesOf(['@godcreator/gwb-settings'], manifestsOf(table))
    expect(out).toEqual([
      {
        pkg: '@godcreator/gwb-settings',
        version: '0.2.4',
        kind: '件',
        entries: [
          {
            specifier: '@godcreator/gwb-settings',
            dts: 'node_modules/@godcreator/gwb-settings/dist/index.d.ts',
            provides: { summary: '设置面', usage: 'define …' },
          },
        ],
      },
    ])
  })

  it('子路径入口：说明符是 包名/子路径，./package.json 不列', async () => {
    const table = {
      '@godcreator/gwb-paper-fetch': {
        keywords: ['gwb', 'gwb-plugin'],
        exports: { '.': { types: './dist/index.d.ts' }, './library': { types: './dist/library.d.ts' }, './package.json': './package.json' },
      },
    }
    const out = await importFacesOf(['@godcreator/gwb-paper-fetch'], manifestsOf(table))
    expect(out[0]?.entries.map((e) => e.specifier)).toEqual(['@godcreator/gwb-paper-fetch', '@godcreator/gwb-paper-fetch/library'])
    expect(out[0]?.entries[1]?.dts).toBe('node_modules/@godcreator/gwb-paper-fetch/dist/library.d.ts')
  })

  it('库：只带 gwb 的 keywords、gwb.shared 报出来、没声明的入口照样列', async () => {
    const table = {
      '@godcreator/gwb-shared-react': {
        keywords: ['gwb'],
        exports: '.',
        gwb: { shared: { react: './react', 'react-dom': './react-dom' } },
      },
    }
    const out = await importFacesOf(['@godcreator/gwb-shared-react'], manifestsOf(table))
    expect(out[0]?.kind).toBe('库')
    expect(out[0]?.shared).toEqual(['react', 'react-dom'])
    expect(out[0]?.entries).toEqual([{ specifier: '@godcreator/gwb-shared-react' }])
  })

  it('gwb.shared 按内核的读法：只认「外置名 → 子路径」对象，子路径不是非空字符串的那项不报，数组写法不报', async () => {
    const table = {
      'with-bad-entries': { keywords: ['gwb'], gwb: { shared: { react: './react', 'react-dom': '', empty: 3 } } },
      'array-form': { keywords: ['gwb'], gwb: { shared: ['react'] } },
    }
    const out = await importFacesOf(['with-bad-entries', 'array-form'], manifestsOf(table))
    expect(out.find((f) => f.pkg === 'with-bad-entries')?.shared).toEqual(['react'])
    expect(out.find((f) => f.pkg === 'array-form')?.shared).toBeUndefined()
  })

  it('第三方（无 gwb keyword）与老式包（main/types 无 exports）', async () => {
    const table = { cordis: { version: '4.0.0-rc.9', main: 'lib/index.js', types: 'lib/index.d.ts' } }
    const out = await importFacesOf(['cordis'], manifestsOf(table))
    expect(out).toEqual([
      { pkg: 'cordis', version: '4.0.0-rc.9', kind: '第三方', entries: [{ specifier: 'cordis', dts: 'node_modules/cordis/lib/index.d.ts' }] },
    ])
  })

  it('manifest 读不到的包静默跳过；provides 只有半边（summary 有 usage 空）不带', async () => {
    const table = {
      'pkg-bad': undefined,
      'pkg-half': { keywords: ['gwb'], exports: { '.': { types: './d.d.ts' } }, gwb: { provides: { 'pkg-half': { summary: '只有一半', usage: '' } } } },
    }
    const out = await importFacesOf(['pkg-bad', 'pkg-half'], manifestsOf(table))
    expect(out.map((f) => f.pkg)).toEqual(['pkg-half'])
    expect(out[0]?.entries[0]?.provides).toBeUndefined()
  })

  it('排序：kind 相同按包名，kind 不同按身份字', async () => {
    const table = {
      'b-pkg': { keywords: ['gwb', 'gwb-plugin'], exports: { '.': { types: './d.d.ts' } } },
      'a-lib': { keywords: ['gwb'], exports: { '.': { types: './d.d.ts' } } },
      'z-third': { exports: { '.': { types: './d.d.ts' } } },
    }
    const out = await importFacesOf(['z-third', 'b-pkg', 'a-lib'], manifestsOf(table))
    expect(out.map((f) => [f.kind, f.pkg])).toEqual([
      ['件', 'b-pkg'],
      ['库', 'a-lib'],
      ['第三方', 'z-third'],
    ])
  })
})
