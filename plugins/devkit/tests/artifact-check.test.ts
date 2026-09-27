import path from 'node:path'
import { pathToFileURL } from 'node:url'
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

describe('importsOf：产物里的 import 分包名与相对两种', () => {
  it('import / export from、副作用 import、带字面量的 import()：包名、相对各归各', () => {
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
      '/**',
      " * 注释里的 import('not-real') 不算",
      ' */',
      "// import('also-not')",
      "const text = 'import x from \"in-a-string\"';",
      "const url = new URL('./client.js', import.meta.url);",
      "import data from 'file:///abs.js';",
      'export {};',
    ].join('\n')
    const got = importsOf(code)
    expect(got.bare.sort()).toEqual(['@godcreator/gwb-commands', '@godcreator/gwb-shell/sub', 'cordis', 'lazy-lib', 'node:fs', 'type-only'].sort())
    expect(got.relative.sort()).toEqual(['./re.js', './side.js'])
  })

  it('压成一行：真实 import 照样分两种，代码生成器字符串里的 import("…") 不算', () => {
    const code =
      'import{jsx as e}from"react/jsx-runtime";import"./side.js";import{}from"@godcreator/gwb-commands";' +
      'function g(t,n){t.write("import("),t.write(JSON.stringify(n)),t.write(")")}const l=await import("lazy-lib");'
    const got = importsOf(code)
    expect(got.bare.sort()).toEqual(['@godcreator/gwb-commands', 'lazy-lib', 'react/jsx-runtime'])
    expect(got.relative).toEqual(['./side.js'])
  })

  it('压成一行的各种写法：静态 import、副作用 import、import * as、export from、export *、export * as、动态 import 都找到', () => {
    const code =
      'import{jsx as e}from"react/jsx-runtime";import"./side.js";import*as n from"node:path";' +
      'export{a as b}from"@godcreator/x/sub";export*from"./re.js";export*as ns from"y";' +
      'var s=1;const t=await import("lazy");export{s};'
    const got = importsOf(code)
    expect(got.bare.sort()).toEqual(['@godcreator/x/sub', 'lazy', 'node:path', 'react/jsx-runtime', 'y'])
    expect(got.relative.sort()).toEqual(['./re.js', './side.js'])
  })

  it('打包进来的代码生成器：字符串里的 import( 与 ) 连成一段像 import("…") 的文字，不算', () => {
    const code = 'function g(e,n){e.write("import("),e.write(JSON.stringify(n)),e.write(")")}' + "function h(e){e.write('import('),e.write('\")'),e.write(')')}"
    expect(importsOf(code)).toEqual({ bare: [], relative: [] })
  })

  it('模板字面量的文字段不算，插值里的真实动态 import 算', () => {
    const code = 'const a=`import("fake") ${x+`import("nested")`} tail`;const b=`${await import("real")}`;'
    expect(importsOf(code).bare).toEqual(['real'])
  })

  it('正则字面量里的不算，正则里的引号也不会让后面的代码错位', () => {
    const code = 'const r=/import\\("x"\\)/g;if(/["\'`]/.test(s))await import("after-regex");const c=/[/]import("in-class")/;'
    expect(importsOf(code).bare).toEqual(['after-regex'])
  })

  it('除号不当成正则：a/b 之后的动态 import 照样找到', () => {
    const code = 'x=a/b;await import("after-division");y=c/d;z=(e)/f/g;w=h[0]/i;v=j++/k;await import("after-increment")/1'
    expect(importsOf(code).bare.sort()).toEqual(['after-division', 'after-increment'])
  })

  it('右括号之后：if(…) 之后是正则，普通表达式的 ) 之后是除号', () => {
    // 第二句里 (d)/import("x")/e 是两个除号，中间那个 import("x") 是真的动态 import
    expect(importsOf('if(a)/import("in-regex")/.test(b);c=(d)/import("x")/e;').bare).toEqual(['x'])
  })

  it('注释里的不算：块注释、行注释、压成一行里的块注释', () => {
    const code = ['/**', " * 示例：import('not-real')", " * import x from 'also-not'", ' */', "// import('line-comment')", 'a();/* import("inline") */b();'].join('\n')
    expect(importsOf(code)).toEqual({ bare: [], relative: [] })
  })

  it('参数不是单个字符串字面量的 import() 不记（import(x)、拼接、模板字面量）；import.meta、属性名 import、对象键 import 都不是 import', () => {
    const code = 'import(x);import("a"+b);import(`t`);const u=import.meta.url;obj.import("no");o?.import("no2");const m={import:"no3",export:"no4"};class K{import(){return 1}}'
    expect(importsOf(code)).toEqual({ bare: [], relative: [] })
  })

  it('动态 import 带第二个参数（import attributes）照样算', () => {
    expect(importsOf('const j=await import("./data.json",{with:{type:"json"}});').relative).toEqual(['./data.json'])
  })

  it('import {} from / export {} from 照常算包名 import，export {} 不是 import', () => {
    const code = "import{}from\"@godcreator/gwb-commands\";import {\n} from 'a';export {} from 'type-only';export {};import {x} from 'b'"
    expect(importsOf(code).bare.sort()).toEqual(['@godcreator/gwb-commands', 'a', 'b', 'type-only'])
  })

  it('import 的名字是字符串（export { "a-b" as c } from）：取 from 后面那个', () => {
    expect(importsOf('export{"a-b"as c}from"m";import{"x y"as z}from"n";').bare.sort()).toEqual(['m', 'n'])
  })

  it('开头的 #! 行跳过', () => {
    expect(importsOf('#!/usr/bin/env node\nimport fs from "node:fs";').bare).toEqual(['node:fs'])
  })

  it('读不下去就抛错并写明行列号：字符串、模板、正则没闭合，多出来的 }', () => {
    expect(() => importsOf('const a="abc')).toThrow('第 1 行第 13 列')
    expect(() => importsOf('const a=`abc')).toThrow('第 1 行第 13 列')
    expect(() => importsOf('const a=/abc')).toThrow('第 1 行第 13 列')
    expect(() => importsOf('a();\nb();}')).toThrow('第 2 行第 5 列')
  })

  it('块注释没闭合不算读不下去：注释一直延到文件尾，里面的 import 不记', () => {
    expect(importsOf('import "./before.js";/* import("inside")')).toEqual({ bare: [], relative: ['./before.js'] })
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
  it('提供方发布的模块也沿相对 import 检查，即使它没有窗格', () => {
    const files = io({ 'dist/index.js': '', 'dist/runtime.js': "import './missing.js'; import 'unknown';" })
    const got = artifactProblems(PKG, plugin(), true, { ...files, browserImports: { runtime: pathToFileURL(path.join(PKG, 'dist/runtime.js')).href } })
    expect(got).toEqual([expect.stringContaining("'./missing.js'"), expect.stringContaining("import 了 'unknown'")])
  })
  it('代码提供方的名单取代旧页面名单，没声明的包名仍拒绝', () => {
    const files = io({ 'dist/index.js': '', 'dist/client.js': "import 'custom/runtime'; import 'other';" })
    expect(artifactProblems(PKG, plugin(), true, { ...files, browserImports: { 'custom/runtime': pathToFileURL(path.resolve('/provider/runtime.js')).href } }))
      .toEqual([expect.stringContaining("import 了 'other'")])
  })
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
    expect(got).toEqual(["dist/index.js 里 import 的 './store' 指向的文件不在"])
  })

  it('空 import（import {} from）：插件按包名 import 查名单，peer 里写了就放行；库不查', () => {
    const files = io({ 'dist/index.js': "import {} from '@godcreator/gwb-shell';\n" })
    expect(artifactProblems(PKG, plugin(), true, files)).toEqual([expect.stringContaining("node 侧产物 dist/index.js import 了 '@godcreator/gwb-shell'")])
    expect(artifactProblems(PKG, plugin({ peerDependencies: { '@godcreator/gwb-shell': '^0.14.0' } }), true, files)).toEqual([])
    expect(artifactProblems(PKG, { ...plugin(), keywords: ['gwb'] }, false, files)).toEqual([])
  })

  it('库不查包名 import 的名单', () => {
    const got = artifactProblems(PKG, { name: '@godcreator/lib', exports: EXPORTS }, false, io({ 'dist/index.js': "import YAML from 'yaml';\n" }))
    expect(got).toEqual([])
  })

  it('找不到 node 侧入口：拒', () => {
    const got = artifactProblems(PKG, { name: 'x', keywords: ['gwb-plugin'] }, true, io({}))
    expect(got).toEqual([expect.stringContaining('找不到 node 侧入口')])
  })

  it('插件只有子路径导出、没有 exports["."]：照旧拒', () => {
    const got = artifactProblems(PKG, { name: 'x', keywords: ['gwb-plugin'], exports: { './vite': './dist/vite.js' } }, true, io({ 'dist/vite.js': '' }))
    expect(got).toEqual([expect.stringContaining('找不到 node 侧入口')])
  })

  it('库只有子路径导出：从每个 js 入口与 bin 走起查相对 import，样式等非 js 目标与通配子路径不算，包名 import 不查', () => {
    const manifest = {
      name: '@x/lib',
      exports: {
        './vite': { types: './dist/vite/index.d.ts', default: './dist/vite/index.js' },
        './model': { types: './dist/model/index.d.ts', default: './dist/model/index.js' },
        './styles.css': './styles.css',
        './parts/*': './dist/parts/*.js',
      },
      bin: { 'x-validate': './dist/cli/validate.js' },
    }
    const files = {
      'dist/vite/index.js': "import vite from 'vite'\nimport { shared } from '../shared.js'",
      'dist/shared.js': '',
      'dist/model/index.js': "import { gone } from './gone.js'",
      'dist/cli/validate.js': "import { shared } from '../shared.js'",
    }
    expect(artifactProblems(PKG, manifest, false, io(files))).toEqual([expect.stringContaining("'./gone.js'")])
    expect(artifactProblems(PKG, manifest, false, io({ ...files, 'dist/model/index.js': '' }))).toEqual([])
  })

  it('库的 exports、main、bin 里没有一个 js 入口：拒', () => {
    const got = artifactProblems(PKG, { name: '@x/css-only', exports: { './styles.css': './styles.css' } }, false, io({}))
    expect(got).toEqual([expect.stringContaining('没有一个指向 js 文件的入口')])
  })

  it('浏览器侧 dist/client.js：名字只取内核包页面入口里的 importmap（从本包 node_modules 现读），别的依赖写了也不算', () => {
    const got = artifactProblems(
      PKG,
      plugin({ devDependencies: { '@godcreator/gwb-shell': '0.14.0', esbuild: '^0.27.0' } }),
      true,
      io({
        'dist/index.js': "import path from 'node:path';\n",
        'dist/client.js':
          "import { jsx } from 'react/jsx-runtime';\nimport { createRoot } from 'react-dom/client';\nimport dayjs from 'dayjs';\n",
        [`node_modules/${KERNEL_PACKAGE}/dist/index.html`]: KERNEL_INDEX_HTML,
      }),
    )
    expect(got).toEqual([expect.stringContaining("浏览器侧产物 dist/client.js import 了 'dayjs'")])
    expect(got[0]).toContain('react、react/jsx-runtime、react-dom/client')
  })

  it('浏览器侧：内核包的页面入口读不到就报，不猜', () => {
    const got = artifactProblems(PKG, plugin(), true, io({ 'dist/index.js': '', 'dist/client.js': "import React from 'react';\n" }))
    expect(got).toEqual([expect.stringContaining('内核包的页面入口读不到'), expect.stringContaining("import 了 'react'")])
  })

  it('两侧压成一行的产物：字符串、模板、正则、注释里的伪 import 不拒，真实的动态 import 照样查', () => {
    const fakeImports = 'const s="import(\\"not-a-package\\")",t=`import("nor-this")`,r=/import\\("nor-regex"\\)/;/* import("nor-comment") */'
    const got = artifactProblems(
      PKG,
      plugin({ peerDependencies: { cordis: '4.0.0-rc.10' } }),
      true,
      io({
        'dist/index.js': `import{Service as S}from"cordis";${fakeImports}const y=await import("yaml");`,
        'dist/client.js': `import{jsx as e}from"react/jsx-runtime";${fakeImports}const d=await import("dayjs");`,
        [`node_modules/${KERNEL_PACKAGE}/dist/index.html`]: KERNEL_INDEX_HTML,
      }),
    )
    expect(got).toEqual([
      expect.stringContaining("node 侧产物 dist/index.js import 了 'yaml'"),
      expect.stringContaining("浏览器侧产物 dist/client.js import 了 'dayjs'"),
    ])
  })

  it('产物按语法读不下去：拒，写明哪个文件、第几行第几列', () => {
    const got = artifactProblems(PKG, plugin(), true, io({ 'dist/index.js': 'const a="abc\n' }))
    expect(got).toEqual([expect.stringMatching(/dist\/index\.js 按 JS 语法读不下去.*第 1 行第 13 列/)])
  })

  it('没有浏览器侧（没有 dist/client.js）：不读内核包', () => {
    const got = artifactProblems(PKG, plugin({ devDependencies: { absent: '1.0.0' } }), true, io({ 'dist/index.js': "import os from 'node:os';\n" }))
    expect(got).toEqual([])
  })
})
