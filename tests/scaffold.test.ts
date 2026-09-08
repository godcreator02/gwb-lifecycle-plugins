import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NAME_RE,
  SCOPE,
  listTemplateFiles,
  packageRoot,
  planScaffold,
  render,
  renderTemplate,
  targetRel,
  writeRepo,
} from '../src/scaffold.js'

/**
 * 建仓的纯机。**落盘那几条真写临时目录**——`writeRepo` 的活就是往盘上放文件，
 * 拿替身测等于没测。
 */

const TEMPLATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template')

const sandboxes: string[] = []
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-devkit-scaffold-'))
  sandboxes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('短名校验', () => {
  it('kebab-case 过，别的都拒——段间一个连字符、结尾不留', () => {
    for (const good of ['hello', 'hello-world', 'a1', 'a1-b2']) expect(NAME_RE.test(good)).toBe(true)
    for (const bad of ['', 'Hello', 'hello_world', '1x', 'x--', 'x-', '-x', 'gwb plugin']) {
      expect(NAME_RE.test(bad), String(bad)).toBe(false)
    }
  })
})

describe('planScaffold：校验与派生', () => {
  it('短名派生出包名与插件名，title 缺省用短名', () => {
    const plan = planScaffold({ name: 'hello-world', dir: 'D:\\tmp\\x' })
    expect(plan.name).toBe('hello-world')
    expect(plan.pkg).toBe(`${SCOPE}/gwb-hello-world`)
    expect(plan.pluginName).toBe('gwb-hello-world')
    expect(plan.title).toBe('hello-world')
  })

  it('title 给了就用给的，两头空白削掉；空白串等于没给', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', title: '  打招呼  ' }).title).toBe('打招呼')
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', title: '   ' }).title).toBe('x')
  })

  it('dir 绝对化：相对路径按当前工作目录算，那不是调用方心里那个「相对谁」', () => {
    expect(path.isAbsolute(planScaffold({ name: 'x', dir: 'tmp/x' }).dir)).toBe(true)
  })

  it('短名不合规就拒，报错里带上规则；dir 空着也拒', () => {
    for (const bad of ['', 'Hello', 'hello_world']) {
      expect(() => planScaffold({ name: bad, dir: 'D:\\tmp\\x' })).toThrow(/kebab-case/)
    }
    expect(() => planScaffold({ name: 'x', dir: '   ' })).toThrow(/dir/)
  })
})

describe('render：占位符', () => {
  const values = { name: 'hello', title: '打招呼', pkg: '@godcreator02/gwb-hello', pkgName: 'gwb-hello' }

  it('认得的键替换掉', () => {
    expect(render('{{name}} / {{title}} / {{name}}', values)).toBe('hello / 打招呼 / hello')
  })

  it('认不出的占位符当场抛——留着它会一路活到别人的 package.json 里', () => {
    expect(() => render('{{typo}}', values)).toThrow(/typo/)
  })
})

describe('targetRel：脱掉 .tpl', () => {
  it('带后缀的脱掉，不带的原样', () => {
    expect(targetRel('package.json.tpl')).toBe('package.json')
    expect(targetRel('src/index.ts.tpl')).toBe('src/index.ts')
    // npm pack 不打 .gitignore，模板里那份必须带后缀存着
    expect(targetRel('.gitignore.tpl')).toBe('.gitignore')
    expect(targetRel('README.md')).toBe('README.md')
  })
})

describe('包内 template/', () => {
  it('每个文件都带 .tpl 后缀', () => {
    const files = listTemplateFiles(TEMPLATE_ROOT)
    expect(files.length).toBeGreaterThanOrEqual(4)
    expect(files.filter((f) => !f.endsWith('.tpl'))).toEqual([])
  })

  it('真渲染一套：占位符一个不剩，包名与插件名都对', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', title: '打招呼' }))
    expect(files.map((f) => f.rel).sort()).toEqual(['.gitignore', 'package.json', 'src/index.ts', 'tsconfig.json'])
    const pkg = JSON.parse(files.find((f) => f.rel === 'package.json')?.text ?? '') as { name: string }
    expect(pkg.name).toBe('@godcreator02/gwb-hello')
    const entry = files.find((f) => f.rel === 'src/index.ts')?.text ?? ''
    expect(entry).toContain("export const name = 'gwb-hello'")
    for (const file of files) expect(file.text).not.toContain('{{')
  })
})

describe('writeRepo：真写临时目录', () => {
  it('落下去的文件与正文都对', () => {
    // 目标目录本身必须还不存在——建仓是一次性动作，所以往沙盒里的一个新子目录落
    const dir = path.join(sandbox(), 'repo')
    writeRepo(dir, [
      { rel: 'package.json', text: '{}\n' },
      { rel: 'src/index.ts', text: 'export {}\n' },
    ])
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe('{}\n')
    expect(fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8')).toBe('export {}\n')
  })

  it('目标目录已经存在就拒，不覆盖任何东西', () => {
    const dir = sandbox()
    fs.writeFileSync(path.join(dir, 'keep.txt'), '原有', 'utf8')
    expect(() => writeRepo(dir, [{ rel: 'x', text: 'y' }])).toThrow(/已经存在/)
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('原有')
  })
})

describe('packageRoot：向上找', () => {
  it('从仓里任意一层往上，找到的是仓根', () => {
    expect(packageRoot(path.dirname(fileURLToPath(import.meta.url)))).toBe(path.resolve(TEMPLATE_ROOT, '..'))
  })

  it('一层不落也能找到包根（dist/ 态的样子）', () => {
    const dir = sandbox()
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n', 'utf8')
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    expect(packageRoot(path.join(dir, 'dist'))).toBe(dir)
  })
})
