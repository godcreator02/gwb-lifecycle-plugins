import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedOnNodeSide, artifactFindings, exportTarget, importsOf, packageNameOf, sharedDeclarations } from '../src/artifact-check.js'

const PKG = path.resolve('/fake-pkg')

/** 假文件表：键是相对包目录的路径 */
function io(files: Record<string, string>): { readText(file: string): string | undefined } {
  const table = new Map(Object.entries(files).map(([rel, text]) => [path.resolve(PKG, rel), text]))
  return { readText: (file) => table.get(path.resolve(file)) }
}

const EXPORTS = { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './package.json': './package.json' }

function plugin(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: '@godcreator/gwb-fake', version: '0.1.0', exports: EXPORTS, keywords: ['gwb', 'gwb-plugin'], ...extra }
}

describe('importsOf：产物里的 import 分三种', () => {
  it('行首的 import / export from、副作用 import、非注释行的 import()：包名、相对、空 import 各归各', () => {
    const code = [
      "import fs from 'node:fs';",
      'import {',
      '  a,',
      '  b as c,',
      "} from 'cordis';",
      "import './side.js';",
      "export * from './re.js';",
      "export { x } from '@godcreator/gwb-shell/sub';",
      "import {} from '@godcreator/gwb-commands';",
      "export {} from 'type-only';",
      "const lazy = await import('lazy-lib');",
      " * 注释里的 import('not-real') 不算",
      "// import('also-not')",
      "const text = 'import x from \"in-a-string\"';",
      "const url = new URL('./client.js', import.meta.url);",
      "import data from 'file:///abs.js';",
      'export {};',
    ].join('\n')
    const got = importsOf(code)
    expect(got.bare.sort()).toEqual(['@godcreator/gwb-commands', '@godcreator/gwb-shell/sub', 'cordis', 'lazy-lib', 'node:fs', 'type-only'].sort())
    expect(got.relative.sort()).toEqual(['./re.js', './side.js'])
    expect(got.empty.sort()).toEqual(['@godcreator/gwb-commands', 'type-only'])
  })
})

describe('名单判定', () => {
  it('包名取作用域加名字', () => {
    expect(packageNameOf('@a/b/c')).toBe('@a/b')
    expect(packageNameOf('react/jsx-runtime')).toBe('react')
  })

  it('node 侧：内置模块（带不带 node: 都算）、electron、cordis 放行，别的拒', () => {
    for (const spec of ['node:fs', 'fs', 'fs/promises', 'electron', 'cordis']) expect(allowedOnNodeSide(spec)).toBe(true)
    for (const spec of ['@godcreator/gwb-plugin-api', 'yaml', 'react']) expect(allowedOnNodeSide(spec)).toBe(false)
  })
})

describe('exportTarget：入口按 node 的解析规则取', () => {
  it('条件对象按键的顺序取第一个运行时条件，types 不算', () => {
    expect(exportTarget({ exports: EXPORTS }, '.')).toBe('./dist/index.js')
    expect(exportTarget({ exports: { '.': { import: './a.mjs', require: './a.cjs' } } }, '.')).toBe('./a.mjs')
  })
  it('exports 是字符串或只有条件；没有 exports 时取 main', () => {
    expect(exportTarget({ exports: './x.js' }, '.')).toBe('./x.js')
    expect(exportTarget({ exports: { default: './y.js' } }, '.')).toBe('./y.js')
    expect(exportTarget({ main: 'dist/index.js' }, '.')).toBe('dist/index.js')
    expect(exportTarget({ exports: EXPORTS, main: 'other.js' }, './nope')).toBeUndefined()
  })
})

describe('sharedDeclarations：形状照内核计算 importmap 那段', () => {
  it('键是名字、值是非空子路径；空键、非字符串值不算', () => {
    expect(sharedDeclarations({ gwb: { shared: { react: './react', '': './x', bad: 1, empty: '' } } })).toEqual({ react: './react' })
    expect(sharedDeclarations({ gwb: {} })).toEqual({})
  })
})

describe('artifactFindings', () => {
  it('node 侧顺着相对 import 走：import cordis 放行并记下，别的包名拒；走不到的文件不查', () => {
    const got = artifactFindings(
      PKG,
      plugin(),
      true,
      io({
        'dist/index.js': "import { Service } from 'cordis';\nimport { helper } from './helper.js';\n",
        'dist/helper.js': "import path from 'node:path';\nimport YAML from 'yaml';\n",
        'dist/orphan.js': "import nope from 'nope';\n",
      }),
    )
    expect(got.nodeImportsCordis).toBe(true)
    expect(got.problems).toEqual([expect.stringContaining("node 侧产物 dist/helper.js import 了 'yaml'")])
  })

  it('相对 import 指向的文件不在：拒', () => {
    const got = artifactFindings(PKG, plugin(), true, io({ 'dist/index.js': "import './store';\n" }))
    expect(got.problems).toEqual([expect.stringContaining("import 的 './store' 不在")])
  })

  it('空 import：插件与库都拒（插件里它同时是一条不在名单上的包名 import）', () => {
    const files = io({ 'dist/index.js': "import {} from '@godcreator/gwb-shell';\n" })
    expect(artifactFindings(PKG, plugin(), true, files).problems).toEqual([
      expect.stringContaining("import {} from '@godcreator/gwb-shell'"),
      expect.stringContaining("node 侧产物 dist/index.js import 了 '@godcreator/gwb-shell'"),
    ])
    expect(artifactFindings(PKG, { ...plugin(), keywords: ['gwb'] }, false, files).problems).toEqual([expect.stringContaining('空 import')])
  })

  it('库不查包名 import 的名单', () => {
    const got = artifactFindings(PKG, { name: '@godcreator/lib', exports: EXPORTS }, false, io({ 'dist/index.js': "import YAML from 'yaml';\n" }))
    expect(got.problems).toEqual([])
  })

  it('找不到 node 侧入口：拒', () => {
    const got = artifactFindings(PKG, { name: 'x', keywords: ['gwb-plugin'] }, true, io({}))
    expect(got.problems).toEqual([expect.stringContaining('找不到 node 侧入口')])
  })

  it('浏览器侧 dist/client.js：名字要在依赖到的包声明的 gwb.shared 里（从本包 node_modules 现读）', () => {
    const got = artifactFindings(
      PKG,
      plugin({ devDependencies: { '@godcreator/gwb-shell': '0.14.0', esbuild: '^0.27.0' } }),
      true,
      io({
        'dist/index.js': "import path from 'node:path';\n",
        'dist/client.js': "import { jsx } from 'react/jsx-runtime';\nimport { createRoot } from 'react-dom/client';\nimport dayjs from 'dayjs';\n",
        'node_modules/@godcreator/gwb-shell/package.json': JSON.stringify({
          name: '@godcreator/gwb-shell',
          gwb: { shared: { react: './react', 'react/jsx-runtime': './react-jsx-runtime', 'react-dom/client': './react-dom-client' } },
        }),
        'node_modules/esbuild/package.json': JSON.stringify({ name: 'esbuild' }),
      }),
    )
    expect(got.problems).toEqual([expect.stringContaining("浏览器侧产物 dist/client.js import 了 'dayjs'")])
    expect(got.problems[0]).toContain('react、react/jsx-runtime、react-dom/client')
  })

  it('浏览器侧：依赖的清单读不到就报，不猜', () => {
    const got = artifactFindings(
      PKG,
      plugin({ devDependencies: { '@godcreator/gwb-shell': '0.14.0' } }),
      true,
      io({ 'dist/index.js': '', 'dist/client.js': "import React from 'react';\n" }),
    )
    expect(got.problems).toEqual([expect.stringContaining('pnpm install'), expect.stringContaining("import 了 'react'")])
  })

  it('本包自己声明的 gwb.shared：指到的文件算浏览器侧，名字本包也能用', () => {
    const got = artifactFindings(
      PKG,
      plugin({
        exports: { ...EXPORTS, './react': './dist/react.js', './react-dom': './dist/react-dom.js' },
        gwb: { shared: { react: './react', 'react-dom': './react-dom', missing: './missing' } },
      }),
      true,
      io({
        'dist/index.js': '',
        'dist/client.js': "import React from 'react';\n",
        'dist/react.js': 'export default {};\n',
        'dist/react-dom.js': "import * as r from 'react';\nimport fs from 'node:fs';\n",
      }),
    )
    expect(got.problems).toEqual([expect.stringContaining('gwb.shared 的 missing'), expect.stringContaining("dist/react-dom.js import 了 'node:fs'")])
  })

  it('没有浏览器侧（没有 dist/client.js、没有 gwb.shared）：不读依赖的清单', () => {
    const got = artifactFindings(PKG, plugin({ devDependencies: { absent: '1.0.0' } }), true, io({ 'dist/index.js': "import os from 'node:os';\n" }))
    expect(got).toEqual({ problems: [], nodeImportsCordis: false })
  })
})
