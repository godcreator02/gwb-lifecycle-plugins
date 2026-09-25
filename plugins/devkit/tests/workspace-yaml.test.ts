import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { assertReadableYaml, topLevelScalars, workspacePackageGlobs } from '../src/workspace-yaml.js'

/**
 * 本包自己读 YAML 的那一小块。每个能读的例子都拿 yaml 库的结果对照——两边说法不一致，就是本包读错了。
 */

const FILE = 'D:\\repo\\pnpm-workspace.yaml'

/** yaml 库读出来的 packages；本包读出来的必须和它一样 */
function packagesByLibrary(text: string): unknown {
  const doc: unknown = YAML.parse(text)
  return typeof doc === 'object' && doc !== null && 'packages' in doc ? doc.packages : null
}

describe('workspacePackageGlobs：pnpm-workspace.yaml 的 packages', () => {
  const readable: Array<[string, string]> = [
    ['块列表、不带引号', 'packages:\n  - plugins/*\n  - packages/*\n'],
    ['块列表、单引号', "packages:\n  - 'plugins/*'\n  - 'packages/*'\n"],
    ['块列表、双引号', 'packages:\n  - "plugins/*"\n'],
    ['块列表的短横线与键同一缩进', 'packages:\n- plugins/*\n- docs-site\n'],
    ['流式列表、带引号', "packages: ['plugins/*', 'packages/*']\n"],
    ['流式列表、不带引号、两头有空格', 'packages: [ plugins/* , packages/* ]\n'],
    ['流式列表跨行、带尾逗号', "packages: [\n  'plugins/*',\n  \"packages/*\",\n]\n"],
    ['带注释、别的键有嵌套映射与带引号的键', "# 头注\npackages:\n  # 插件\n  - plugins/* # 行尾注释\n  - docs-site\n\nallowBuilds:\n  '@parcel/watcher': false\n  esbuild: true\n"],
    ['单引号里的两个单引号是一个单引号', "packages:\n  - 'it''s/*'\n"],
    ['双引号里的转义', 'packages:\n  - "a\\\\b/*"\n'],
    ['CRLF 换行', 'packages:\r\n  - plugins/*\r\n'],
    ['别的键是流式映射、跨行', 'overrides: {\n  a: 1,\n  b: 2\n}\npackages: [plugins/*]\n'],
    ['别的键是块标量', 'note: |\n  第一行\n  第二行\npackages:\n  - plugins/*\n'],
    ['开头有 --- 文档标记', '---\npackages:\n  - plugins/*\n'],
    ['没有 packages 这个键', 'allowBuilds:\n  esbuild: true\n'],
    ['空文件', ''],
  ]
  for (const [label, text] of readable) {
    it(`${label}：和 yaml 库读出来的一样`, () => {
      expect(workspacePackageGlobs(text, FILE)).toEqual(packagesByLibrary(text))
    })
  }

  it('读不懂的写法直接报错，说清是哪个文件第几行，不猜', () => {
    const unreadable: Array<[string, RegExp]> = [
      ['packages: plugins/*\n', /第 1 行.*packages 要是列表/],
      ['packages: {a: 1}\n', /第 1 行.*packages 要是列表/],
      ['packages:\n  - [plugins/*]\n', /第 2 行/],
      ['packages:\n  - a: b\n', /第 2 行/],
      ['packages:\n  -\n', /第 2 行/],
      ['packages:\n  foo: bar\n', /第 2 行/],
      ["packages: ['plugins/*'\n", /第 1 行.*没有收尾/],
      ["packages:\n  - 'plugins/*\n", /第 2 行.*引号/],
      ['packages:\n  - "\\x41"\n', /第 2 行.*转义/],
      ['packages:\n  - &a plugins/*\n', /第 2 行/],
      ['  packages:\n  - plugins/*\n', /第 1 行/],
      ['packages:\n    - plugins/*\n  - docs-site\n', /第 3 行.*缩进/],
    ]
    for (const [text, why] of unreadable) {
      expect(() => workspacePackageGlobs(text, FILE), JSON.stringify(text)).toThrow(why)
      expect(() => workspacePackageGlobs(text, FILE), JSON.stringify(text)).toThrow(FILE)
    }
  })
})

describe('topLevelScalars：只有一层标量的 YAML（插件页的 frontmatter）', () => {
  it('普通标量与双引号标量都读得出，和 yaml 库一样', () => {
    const text = 'title: "他说\\"你好\\" \\\\ {x} <b>"\ndescription: 插件 gwb-x（包 @godcreator/gwb-x）的功能\n'
    expect(topLevelScalars(text, 'x.mdx')).toEqual(YAML.parse(text))
  })

  it('值不是标量就报错', () => {
    expect(() => topLevelScalars('title:\n  - a\n', 'x.mdx')).toThrow(/title.*标量/)
  })

  it('普通标量里出现「: 」或以指示符开头，报错而不是猜它的意思', () => {
    expect(() => topLevelScalars('title: a: b\n', 'x.mdx')).toThrow(/第 1 行/)
    expect(() => topLevelScalars('title: {x}\n', 'x.mdx')).toThrow(/第 1 行/)
    expect(() => topLevelScalars('title: "a"b\n', 'x.mdx')).toThrow(/第 1 行/)
  })
})

describe('assertReadableYaml：生成的 YAML 落盘前读一遍', () => {
  it('读得懂的不抛', () => {
    expect(() => assertReadableYaml('packages:\n  - plugins/*\nallowBuilds:\n  esbuild: true\n', FILE)).not.toThrow()
  })

  it('顶层结构坏了就抛', () => {
    expect(() => assertReadableYaml("packages: ['plugins/*'\n", FILE)).toThrow(FILE)
  })
})
