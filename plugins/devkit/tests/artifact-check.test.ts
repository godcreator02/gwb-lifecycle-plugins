import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedOnNodeSide, artifactProblems, exportTarget, importmapNamesOf, importsOf, packageNameOf } from '../src/artifact-check.js'
import { KERNEL_PACKAGE } from '@godcreator/gwb-plugin-manager'

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

  it('node 侧：内置模块（带不带 node: 都算）、electron、peer 里写了的包（含子路径）放行，别的拒', () => {
    const peers = new Set(['cordis', '@godcreator/gwb-plugin-manager'])
    for (const spec of ['node:fs', 'fs', 'fs/promises', 'electron', 'cordis', '@godcreator/gwb-plugin-manager', '@godcreator/gwb-plugin-manager/sub']) {
      expect(allowedOnNodeSide(spec, peers)).toBe(true)
    }
    for (const spec of ['@godcreator/gwb-shell', 'yaml', 'react']) expect(allowedOnNodeSide(spec, peers)).toBe(false)
    expect(allowedOnNodeSide('cordis', new Set())).toBe(false)
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

/** 内核包页面入口里那段写死的 importmap，形状照内核 0.6 的 index.html */
const KERNEL_INDEX_HTML = [
  '<!doctype html>',
  '<html>',
  '  <head>',
  '    <script type="importmap">',
  '      {',
  '        "imports": {',
  '          "react": "./react/react.js",',
  '          "react/jsx-runtime": "./react/react-jsx-runtime.js",',
  '          "react-dom/client": "./react/react-dom-client.js"',
  '        }',
  '      }',
  '    </script>',
  '    <script type="module" src="./page.js"></script>',
  '  </head>',
  '</html>',
].join('\n')

describe('importmapNamesOf：页面入口 html 里那段 importmap 的名字', () => {
  it('取 imports 的键', () => {
    expect(importmapNamesOf(KERNEL_INDEX_HTML)).toEqual(['react', 'react/jsx-runtime', 'react-dom/client'])
  })
  it('没有 importmap 回 undefined；JSON 不合法抛错', () => {
    expect(importmapNamesOf('<html></html>')).toBeUndefined()
    expect(() => importmapNamesOf('<script type="importmap">{ nope</script>')).toThrow()
  })
})

describe('artifactProblems', () => {
  it('node 侧顺着相对 import 走：peer 里写了的 cordis 放行，别的包名拒；走不到的文件不查', () => {
    const got = artifactProblems(
      PKG,
      plugin({ peerDependencies: { cordis: '4.0.0-rc.10' } }),
      true,
      io({
        'dist/index.js': "import { Service } from 'cordis';\nimport { helper } from './helper.js';\n",
        'dist/helper.js': "import path from 'node:path';\nimport YAML from 'yaml';\n",
        'dist/orphan.js': "import nope from 'nope';\n",
      }),
    )
    expect(got).toEqual([expect.stringContaining("node 侧产物 dist/helper.js import 了 'yaml'")])
  })

  it('node 侧 import 了 cordis 而 peer 里没写：拒', () => {
    const got = artifactProblems(PKG, plugin(), true, io({ 'dist/index.js': "import { Service } from 'cordis';\n" }))
    expect(got).toEqual([expect.stringContaining("import 了 'cordis'")])
  })

  it('相对 import 指向的文件不在：拒', () => {
    const got = artifactProblems(PKG, plugin(), true, io({ 'dist/index.js': "import './store';\n" }))
    expect(got).toEqual([expect.stringContaining("import 的 './store' 不在")])
  })

  it('空 import：插件与库都拒（插件里它同时是一条不在名单上的包名 import）', () => {
    const files = io({ 'dist/index.js': "import {} from '@godcreator/gwb-shell';\n" })
    expect(artifactProblems(PKG, plugin(), true, files)).toEqual([
      expect.stringContaining("import {} from '@godcreator/gwb-shell'"),
      expect.stringContaining("node 侧产物 dist/index.js import 了 '@godcreator/gwb-shell'"),
    ])
    expect(artifactProblems(PKG, { ...plugin(), keywords: ['gwb'] }, false, files)).toEqual([expect.stringContaining('空 import')])
  })

  it('库不查包名 import 的名单', () => {
    const got = artifactProblems(PKG, { name: '@godcreator/lib', exports: EXPORTS }, false, io({ 'dist/index.js': "import YAML from 'yaml';\n" }))
    expect(got).toEqual([])
  })

  it('找不到 node 侧入口：拒', () => {
    const got = artifactProblems(PKG, { name: 'x', keywords: ['gwb-plugin'] }, true, io({}))
    expect(got).toEqual([expect.stringContaining('找不到 node 侧入口')])
  })

  it('浏览器侧 dist/client.js：名字只取内核包页面入口里的 importmap（从本包 node_modules 现读），别的依赖写了也不算', () => {
    const got = artifactProblems(
      PKG,
      plugin({ devDependencies: { '@godcreator/gwb-shell': '0.14.0', esbuild: '^0.27.0' } }),
      true,
      io({
        'dist/index.js': "import path from 'node:path';\n",
        'dist/client.js':
          "import { jsx } from 'react/jsx-runtime';\nimport { createRoot } from 'react-dom/client';\nimport dayjs from 'dayjs';\nimport x from 'shell-shared';\n",
        [`node_modules/${KERNEL_PACKAGE}/dist/index.html`]: KERNEL_INDEX_HTML,
        'node_modules/@godcreator/gwb-shell/package.json': JSON.stringify({ name: '@godcreator/gwb-shell', gwb: { shared: { 'shell-shared': './x' } } }),
      }),
    )
    expect(got).toEqual([
      expect.stringContaining("浏览器侧产物 dist/client.js import 了 'dayjs'"),
      expect.stringContaining("浏览器侧产物 dist/client.js import 了 'shell-shared'"),
    ])
    expect(got[0]).toContain('react、react/jsx-runtime、react-dom/client')
  })

  it('浏览器侧：内核包的页面入口读不到就报，不猜', () => {
    const got = artifactProblems(PKG, plugin(), true, io({ 'dist/index.js': '', 'dist/client.js': "import React from 'react';\n" }))
    expect(got).toEqual([expect.stringContaining('内核包的页面入口读不到'), expect.stringContaining("import 了 'react'")])
  })

  it('没有浏览器侧（没有 dist/client.js）：不读内核包', () => {
    const got = artifactProblems(PKG, plugin({ devDependencies: { absent: '1.0.0' } }), true, io({ 'dist/index.js': "import os from 'node:os';\n" }))
    expect(got).toEqual([])
  })
})
