'use client'

/**
 * devkit.scaffold 建仓的七格：前三格在开发套件里（算计划、在内存里渲染、写磁盘），中间两格经命令总线按名字交给
 * 站点插件与 docfirst 插件（虚线框：插件没装就跳过），最后写插件页、给回执。右侧竖线标出哪几格不是本包的命令。
 */

import { Chain, type ChainItem, MUTED, NARROW, Note } from './parts'
import { StepControls, StepText, useSteps } from './steps'

const ITEMS: ChainItem[] = [
  { lines: ['1 算计划 planScaffold', '短名 → @godcreator/gwb-<短名>'], mono: true },
  { lines: ['2 在内存里渲染模板', 'template/repo/ + template/pkg/'], mono: true },
  { lines: ['3 writeRepo 写磁盘', '仓根 + plugins/<短名>/'], mono: true },
  { lines: ['4 docs-site.create', '站点插件：生成 docs-site/ 骨架'], dashed: true },
  { lines: ['5 docfirst.attach', 'docfirst 插件：在骨架上装六区'], dashed: true },
  { lines: ['6 写插件页', 'content/docs/plugins/<短名>.mdx'], mono: true },
  { lines: ['7 回执', 'docs.built、docs.attached、nextSteps'], mono: true },
]

const STEPS: { title: string; detail: string; active: number }[] = [
  { title: '全貌', detail: '前三格是开发套件自己的代码；第 4、5 格是别的插件的命令，经命令总线按名字调用，哪个插件没装就跳过那一格，建仓不算失败。', active: -1 },
  { title: '第 1 步：算计划', detail: '校验短名，派生包名 @godcreator/gwb-<短名>、插件名 gwb-<短名>；gwb.testedKernel 取运行中内核的版本号。只算、不碰磁盘，参数不对把整份用法放进报错。', active: 0 },
  { title: '第 2 步：在内存里渲染', detail: '整套模板（还有插件页）先渲染成内存里的文件表；认不出的占位符当场抛错，这时磁盘上还什么都没写。', active: 1 },
  { title: '第 3 步：写磁盘', detail: '目标目录必须还不存在，存在就拒、不覆盖。仓根写 package.json、pnpm-workspace.yaml、README.md、.gitignore，插件包写到 plugins/<短名>/。', active: 2 },
  { title: '第 4 步：生成站点骨架', detail: '经命令总线调站点插件的 docs-site.create，目录是 <仓>/docs-site。成功时回执的 docs.built 是 true；站点插件没装就停在这里，回执说怎么补。', active: 3 },
  { title: '第 5 步：装六区', detail: '紧接着调 docfirst 插件的 docfirst.attach。它只在刚生成、没加过页的骨架上装得了，所以两步连着调用，中间不插别的事。成功时 docs.attached 是 true。', active: 4 },
  { title: '第 6 步：写插件页', detail: 'docs-site/docfirst.config.mjs 在（六区装好了）才写。页里写出模板插件注入的服务名，新仓第一次 pnpm check 的自述检查因此能过。', active: 5 },
  { title: '第 7 步：回执', detail: 'nextSteps 按 built 与 attached 分三种情况写下一步：站建好了、只有骨架、没有站。插件的文件在第 3 步就已经在磁盘上。', active: 6 },
]

const TOP = 12
const H = 50
const GAP = 20

export function DkScaffold() {
  const state = useSteps(STEPS.length, 3400)
  const current = STEPS[state.step]!
  const rowY = (index: number) => TOP + index * (H + GAP)
  return (
    <>
      <svg viewBox="0 0 400 500" className={NARROW} role="img" aria-label="devkit.scaffold 建仓的七步">
        <Chain x={10} y={TOP} w={336} h={H} gap={GAP} items={ITEMS} active={current.active} />
        <line x1={362} y1={rowY(3)} x2={362} y2={rowY(4) + H} stroke={MUTED} strokeDasharray="4 4" />
        <Note x={372} y={(rowY(3) + rowY(4) + H) / 2 - 14} size={12} color={MUTED}>
          别
        </Note>
        <Note x={372} y={(rowY(3) + rowY(4) + H) / 2 + 2} size={12} color={MUTED}>
          的
        </Note>
        <Note x={372} y={(rowY(3) + rowY(4) + H) / 2 + 18} size={12} color={MUTED}>
          插
        </Note>
        <Note x={372} y={(rowY(3) + rowY(4) + H) / 2 + 34} size={12} color={MUTED}>
          件
        </Note>
      </svg>
      <StepText title={current.title} detail={current.detail} />
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
