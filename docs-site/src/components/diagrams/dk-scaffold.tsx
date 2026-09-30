'use client'

/**
 * devkit.scaffold 建仓的五格：算计划、在内存里渲染、写磁盘、加 shadcn 组件、给回执，都在开发套件自己的代码里。
 */

import { Chain, type ChainItem, NARROW } from './parts'
import { StepControls, StepText, useSteps } from './steps'

const ITEMS: ChainItem[] = [
  { lines: ['1 算计划 planScaffold', '短名 → <scope>/gwb-<短名>'], mono: true },
  { lines: ['2 在内存里渲染模板', 'template/repo/ + template/pkg/'], mono: true },
  { lines: ['3 writeRepo 写磁盘', '仓根 + plugins/<短名>/'], mono: true },
  { lines: ['4 addTemplateComponents', 'shadcn CLI 加 button，依赖进 dev'], mono: true },
  { lines: ['5 回执', 'repoDir、pluginDir、components…'], mono: true },
]

const STEPS: { title: string; detail: string; active: number }[] = [
  { title: '全貌', detail: '五格都是开发套件自己的代码，不调别的插件的命令，也不建文档站；第 4 格经 pnpm 运行 shadcn 官方 CLI，要联网。', active: -1 },
  { title: '第 1 步：算计划', detail: '校验短名、scope 与 registry，派生包名 <scope>/gwb-<短名>（scope 缺省 @godcreator）、插件名 gwb-<短名>，发布目标写进插件包的 publishConfig.registry（缺省团队源）；peer 里内核包、命令总线、外壳的范围取运行建仓命令的那个 home 里的版本号（x.y.z 三段）。只算、不碰磁盘，参数不对把整份用法放进报错。接着找 pnpm，找不到就停，什么都不写。', active: 0 },
  { title: '第 2 步：在内存里渲染', detail: '整套模板先渲染成内存里的文件表，要显示名的地方填短名；认不出的占位符当场抛错，这时磁盘上还什么都没写。生成的 JSON / YAML 读不读得懂由测试对本包的模板核对。', active: 1 },
  { title: '第 3 步：写磁盘', detail: '目标目录必须还不存在，存在就拒、不覆盖。仓根写 package.json、pnpm-workspace.yaml、README.md、.gitignore，插件包写到 plugins/<短名>/，其中有 components.json 与指向 src/client 的 @/ 别名。', active: 2 },
  { title: '第 4 步：加 shadcn 组件', detail: '在插件包目录运行 pnpm dlx shadcn@latest add button --yes，组件写到 src/client/components/ui/button.tsx；CLI 装依赖时整个 workspace 装一遍。再一次 pnpm add -D 把 CLI 写进 dependencies 的包和组件 import 了却没装的包放进 devDependencies，最后读清单核对。没成就回 ok: false，已写的文件不回滚。', active: 3 },
  { title: '第 5 步：回执', detail: '回执报仓与插件包在哪、包名与发布目标、写了几个文件、加了哪些组件；nextSteps 只写这次建仓特有的路径，流程指向说明书 gwb-devkit 的「新写一个插件」。', active: 4 },
]

const TOP = 12
const H = 50
const GAP = 20

export function DkScaffold() {
  const state = useSteps(STEPS.length, 3400)
  const current = STEPS[state.step]!
  return (
    <>
      <svg viewBox="0 0 400 360" className={NARROW} role="img" aria-label="devkit.scaffold 建仓的五步">
        <Chain x={10} y={TOP} w={336} h={H} gap={GAP} items={ITEMS} active={current.active} />
      </svg>
      <StepText title={current.title} detail={current.detail} />
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
