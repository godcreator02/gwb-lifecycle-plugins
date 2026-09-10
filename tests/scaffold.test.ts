import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NAME_RE,
  SCOPE,
  listTemplateFiles,
  nextSteps,
  packageRoot,
  placeholders,
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

  it('docs 缺省是建：人记得事后补第二条命令的概率，跟那一堆仓至今没有站是同一个概率', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x' }).docs).toBe(true)
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false }).docs).toBe(false)
  })

  it('port 不给就是 undefined（本包不猜一个写进 README）；给了要在 1024–65535', () => {
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x' }).port).toBeUndefined()
    expect(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: 4321 }).port).toBe(4321)
    for (const bad of [80, 70000, 4321.5]) {
      expect(() => planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: bad })).toThrow(/port/)
    }
  })
})

describe('docsBlock：README 里讲站的那一段', () => {
  it('建了站就讲怎么跑；端口给了才敢写死，没给只说去哪儿看', () => {
    const withPort = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', port: 4321 })).docsBlock ?? ''
    expect(withPort).toContain('cd docs-site')
    expect(withPort).toContain('http://localhost:4321')

    const noPort = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x' })).docsBlock ?? ''
    expect(noPort).toContain('cd docs-site')
    // 猜一个端口写进 README，读者照着敲的那条 pnpm dev 就是错的
    expect(noPort).not.toMatch(/localhost:\d/)
    expect(noPort).toContain('docs-site/package.json')
  })

  it('没建站就讲怎么补一个——两步，而且点名那两个件的命令', () => {
    const block = placeholders(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false })).docsBlock ?? ''
    expect(block).not.toContain('cd docs-site')
    expect(block).toContain('docs-site.create')
    expect(block).toContain('live-doc.attach')
    // 旧线的包与命令一个都不许再出现在生成的 README 里
    expect(block).not.toContain('devkit.livedoc')
    expect(block).not.toContain('live-doc-cli')
  })
})

describe('nextSteps：按站真建到哪一步分三支', () => {
  const plan = planScaffold({ name: 'x', dir: 'D:\\tmp\\x' })

  it('骨架铺了、六区也装了，才给 docs-site 那几步，端口有就报出来', () => {
    const steps = nextSteps(plan, { built: true, attached: true, port: 4321 }).join('\n')
    expect(steps).toContain('docs-site')
    expect(steps).toContain('4321')
    expect(steps).toContain('doc:confirm')
  })

  it('骨架铺了但六区没装：给 attach 那条，不给 pnpm doc——那几条脚本还不存在', () => {
    const steps = nextSteps(plan, { built: true, attached: false }).join('\n')
    expect(steps).toContain('live-doc.attach')
    expect(steps).not.toContain('doc:confirm')
  })

  it('骨架都没铺就给两步补建——回执里给一条不存在的 cd docs-site 比不给还坏', () => {
    const steps = nextSteps(plan, { built: false, attached: false }).join('\n')
    expect(steps).not.toContain('cd D:\\tmp\\x\\docs-site')
    expect(steps).toContain('docs-site.create')
    expect(steps).toContain('live-doc.attach')
  })

  it('不给 site 就照计划里的意思说', () => {
    expect(nextSteps(planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false })).join('\n')).toContain(
      'docs-site.create',
    )
    // 计划里要建站 = 两步都走，走到底那一支
    expect(nextSteps(plan).join('\n')).toContain('doc:confirm')
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
    expect(files.length).toBe(10)
    expect(files.filter((f) => !f.endsWith('.tpl'))).toEqual([])
  })

  it('真渲染一套：占位符一个不剩，包名与插件名都对', () => {
    const files = renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'hello', dir: 'D:\\tmp\\x', title: '打招呼' }))
    // 一个**能直接开工**的件仓：门禁（oxlint / vitest / 两份 tsconfig）、起手测试、README 都在
    expect(files.map((f) => f.rel).sort()).toEqual([
      '.gitignore',
      '.npmrc',
      '.oxlintrc.json',
      'README.md',
      'package.json',
      'src/index.ts',
      'tests/plugin.test.ts',
      'tsconfig.build.json',
      'tsconfig.json',
      'vitest.config.ts',
    ])
    const pkg = JSON.parse(files.find((f) => f.rel === 'package.json')?.text ?? '') as {
      name: string
      scripts: Record<string, string>
    }
    expect(pkg.name).toBe('@godcreator02/gwb-hello')
    // 红线六：漏了 prepublishOnly，publish 会把上一版的 dist 原样发出去而且一声不吭
    expect(pkg.scripts.prepublishOnly).toBeDefined()
    expect(pkg.scripts.check).toBeDefined()
    const entry = files.find((f) => f.rel === 'src/index.ts')?.text ?? ''
    expect(entry).toContain("export const name = 'gwb-hello'")
    for (const file of files) expect(file.text).not.toContain('{{')
  })

  it('模板里的占位符全在 placeholders 的表上——认不出的当场抛，那正是这条要钉的', () => {
    // docsBlock 是后加的一格：模板加了新占位符而这边没加，renderTemplate 会抛
    expect(() => renderTemplate(TEMPLATE_ROOT, planScaffold({ name: 'x', dir: 'D:\\tmp\\x', docs: false }))).not.toThrow()
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
