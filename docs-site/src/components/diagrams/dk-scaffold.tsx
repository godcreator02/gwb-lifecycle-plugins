'use client'

/**
 * devkit.scaffold 建仓的四格：算计划、在内存里渲染、写磁盘、给回执，都在开发套件自己的代码里。
 */

import { Chain, type ChainItem, NARROW } from './parts'
import { StepControls, StepText, useSteps } from './steps'

const ITEMS: ChainItem[] = [
  { lines: ['1 算计划 planScaffold', '短名 → <scope>/gwb-<短名>'], mono: true },
  { lines: ['2 在内存里渲染模板', 'template/repo/ + template/pkg/'], mono: true },
  { lines: ['3 writeRepo 写磁盘', '仓根 + plugins/<短名>/'], mono: true },
  { lines: ['4 回执', 'repoDir、pluginDir、pkg、nextSteps'], mono: true },
]

const STEPS: { title: string; detail: string; active: number }[] = [
  { title: '全貌', detail: '四格都是开发套件自己的代码，不调别的插件的命令，也不建文档站。', active: -1 },
  { title: '第 1 步：算计划', detail: '校验短名、scope 与 registry，派生包名 <scope>/gwb-<短名>（scope 缺省 @godcreator）、插件名 gwb-<短名>，发布目标写进插件包的 publishConfig.registry（缺省团队源）；peer 里内核包的范围取运行中内核版本号的 x.y.z 三段。只算、不碰磁盘，参数不对把整份用法放进报错。', active: 0 },
  { title: '第 2 步：在内存里渲染', detail: '整套模板先渲染成内存里的文件表，要显示名的地方填短名；认不出的占位符当场抛错，这时磁盘上还什么都没写。生成的 JSON / YAML 读不读得懂由测试对本包的模板核对。', active: 1 },
  { title: '第 3 步：写磁盘', detail: '目标目录必须还不存在，存在就拒、不覆盖。仓根写 package.json、pnpm-workspace.yaml、README.md、.gitignore，插件包写到 plugins/<短名>/。', active: 2 },
  { title: '第 4 步：回执', detail: '回执报仓与插件包在哪、包名与发布目标、写了几个文件；nextSteps 只写这次建仓特有的路径，流程指向说明书 gwb-devkit 的「新写一个插件」。', active: 3 },
]

const TOP = 12
const H = 50
const GAP = 20

export function DkScaffold() {
  const state = useSteps(STEPS.length, 3400)
  const current = STEPS[state.step]!
  return (
    <>
      <svg viewBox="0 0 400 290" className={NARROW} role="img" aria-label="devkit.scaffold 建仓的四步">
        <Chain x={10} y={TOP} w={336} h={H} gap={GAP} items={ITEMS} active={current.active} />
      </svg>
      <StepText title={current.title} detail={current.detail} />
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
