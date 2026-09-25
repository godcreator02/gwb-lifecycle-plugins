import { describe, expect, it } from 'vitest'
import { scanModuleImports } from '../src/import-scan.js'

/** 只看说明符与种类，按出现顺序 */
function specs(code: string): string[] {
  return scanModuleImports(code).map((found) => `${found.dynamic ? 'dynamic' : 'static'}${found.empty ? '(empty)' : ''} ${found.specifier}`)
}

describe('scanModuleImports：按语法找 import，不按行', () => {
  it('压成一行的产物：静态 import、副作用 import、export from、export *、动态 import 都找到', () => {
    const code =
      'import{jsx as e}from"react/jsx-runtime";import"./side.js";import*as n from"node:path";' +
      'export{a as b}from"@godcreator/x/sub";export*from"./re.js";export*as ns from"y";' +
      'var s=1;const t=await import("lazy");export{s};'
    expect(specs(code)).toEqual([
      'static react/jsx-runtime',
      'static ./side.js',
      'static node:path',
      'static @godcreator/x/sub',
      'static ./re.js',
      'static y',
      'dynamic lazy',
    ])
  })

  it('打包进来的代码生成器：字符串里的 import( 与 ) 连成一段像 import("…") 的文字，不算', () => {
    const code = 'function g(e,n){e.write("import("),e.write(JSON.stringify(n)),e.write(")")}' + "function h(e){e.write('import('),e.write('\")'),e.write(')')}"
    expect(specs(code)).toEqual([])
  })

  it('模板字面量的文字段不算，插值里的真实动态 import 算', () => {
    const code = 'const a=`import("fake") ${x+`import("nested")`} tail`;const b=`${await import("real")}`;'
    expect(specs(code)).toEqual(['dynamic real'])
  })

  it('正则字面量里的不算，正则里的引号也不会让后面的代码错位', () => {
    const code = 'const r=/import\\("x"\\)/g;if(/["\'`]/.test(s))await import("after-regex");const c=/[/]import("in-class")/;'
    expect(specs(code)).toEqual(['dynamic after-regex'])
  })

  it('除号不当成正则：a/b 之后的动态 import 照样找到', () => {
    const code = 'x=a/b;await import("after-division");y=c/d;z=(e)/f/g;w=h[0]/i;v=j++/k;await import("after-increment")/1'
    expect(specs(code)).toEqual(['dynamic after-division', 'dynamic after-increment'])
  })

  it('右括号之后：if(…) 之后是正则，普通表达式的 ) 之后是除号', () => {
    const code = 'if(a)/import("in-regex")/.test(b);c=(d)/import("x")/e;'
    // 第二句里 (d)/import("x")/e 是两个除号，中间那个 import("x") 是真的动态 import
    expect(specs(code)).toEqual(['dynamic x'])
  })

  it('注释里的不算：块注释、行注释、压成一行里的块注释', () => {
    const code = [
      '/**',
      " * 示例：import('not-real')",
      " * import x from 'also-not'",
      ' */',
      "// import('line-comment')",
      'a();/* import("inline") */b();',
    ].join('\n')
    expect(specs(code)).toEqual([])
  })

  it('非字面量的 import(x) 不记；import.meta、属性名 import、对象键 import 都不是 import', () => {
    const code = 'import(x);import("a"+b);import(`t`);const u=import.meta.url;obj.import("no");o?.import("no2");const m={import:"no3",export:"no4"};class K{import(){return 1}}'
    expect(specs(code)).toEqual([])
  })

  it('动态 import 带第二个参数（import attributes）照样算', () => {
    expect(specs('const j=await import("./data.json",{with:{type:"json"}});')).toEqual(['dynamic ./data.json'])
  })

  it('空 import：import {} from / export {} from 标 empty，export {} 不是 import', () => {
    const code = "import{}from\"@godcreator/gwb-commands\";import {\n} from 'a';export {} from 'type-only';export {};import {x} from 'b'"
    expect(specs(code)).toEqual(['static(empty) @godcreator/gwb-commands', 'static(empty) a', 'static(empty) type-only', 'static b'])
  })

  it('import 的名字是字符串（export { "a-b" as c } from）：取 from 后面那个', () => {
    expect(specs('export{"a-b"as c}from"m";import{"x y"as z}from"n";')).toEqual(['static m', 'static n'])
  })

  it('开头的 #! 行跳过', () => {
    expect(specs('#!/usr/bin/env node\nimport fs from "node:fs";')).toEqual(['static node:fs'])
  })

  it('读不下去就抛错并写明位置：字符串、模板、正则、块注释没闭合', () => {
    expect(() => scanModuleImports('const a="abc')).toThrow(/字符串没有闭合/)
    expect(() => scanModuleImports('const a=`abc')).toThrow(/模板字面量没有闭合/)
    expect(() => scanModuleImports('const a=/abc')).toThrow(/正则字面量没有闭合/)
    expect(() => scanModuleImports('a();/* abc')).toThrow(/块注释没有闭合/)
    expect(() => scanModuleImports('a();\nb();}')).toThrow(/第 2 行第 5 列.*多出来的 }/)
  })
})
