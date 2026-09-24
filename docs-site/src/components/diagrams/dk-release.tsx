'use client'

/**
 * devkit.release 的检查流水线：左边六格依次做，右边是第五格「发版前检查」逐包查的各项（上半每个包都查，下半只查插件包）。
 * 最下面一格是任何一项没过时的结果：一个包都不发，回执按包列全。
 */

import { Box, Chain, type ChainItem, FG, Frame, MUTED, NARROW, Note } from './parts'
import { StepControls, StepText, useSteps } from './steps'

const ITEMS: ChainItem[] = [
  { lines: ['1 git 工作区干净', 'git status'], mono: true },
  { lines: ['2 仓根 pnpm build'] },
  { lines: ['3 产物都在', 'files 白名单逐项'] },
  { lines: ['4 版本号没发过', '源上已有就拒'] },
  { lines: ['5 发版前检查', '所有包一次查完'] },
  { lines: ['6 按顺序发到 latest', '临时目录里组装'] },
]

const EVERY_PACKAGE = ['不在 0.0.x', 'dev 范围含源上的 latest', '产物里没有空 import', '相对 import 的文件都在', 'tsc --noEmit 类型检查', 'gwb.provides 与源码对得上']
const PLUGIN_ONLY = ['peer 只有 cordis、内核包', '包名 import 的两份名单', '内核包范围含运行中内核', 'gwb.requires 写法']

const STEPS: { title: string; detail: string; active: number; refused?: boolean }[] = [
  { title: '全貌', detail: '六格依次做，前五格任何一处没过，一个包都不发。它只碰团队源、不碰任何 home，不改仓里任何文件，从哪个 home 调用都可以。', active: -1 },
  { title: '第 1 步：git 工作区干净', detail: '在仓根运行 git status --porcelain=v1，有一条改动就拒，连构建都不跑；不是 git 仓也拒。发出去的必须是提交过的状态。', active: 0 },
  { title: '第 2 步：仓根 pnpm build', detail: '在仓根构建，不在包目录：同仓的包常常用着另一个包的产物。构建失败，一个都不发。', active: 1 },
  { title: '第 3 步：产物都在', detail: '按 package.json 的 files 白名单查：不带 ! 与通配的每一项都得在包目录里。不另列一份名单，免得两份对不上。', active: 2 },
  { title: '第 4 步：版本号没发过', detail: '同一个版本号永不重发：源上已经有这个版本号就拒。要发新的一版，先升 package.json 的版本号、提交，再调用。', active: 3 },
  {
    title: '第 5 步：发版前检查',
    detail: '要发的包全部一起查、问题一次列全。每个包查右边上半的六项（dev 范围一项只看 @godcreator 的包，类型检查用 skipLibCheck false，gwb.provides 一项只看 keywords 含 gwb 或 gwb-plugin 的包）；keywords 含 gwb-plugin 的插件包另查下半的四项。只提醒、不拒的写进 reminders。',
    active: 4,
  },
  {
    title: '第 6 步：按顺序发到 latest',
    detail: '在系统临时目录里组装发布内容，按 packages 给的顺序发（被依赖的排前面）。workspace: 依赖写成 ^：同一次发的写 ^新版本号，其余写 ^工作区里的版本号。不运行 prepublishOnly。',
    active: 5,
  },
  { title: '有一项没过', detail: '任何一个包的任何一项没过，一个包都不发；回执按包列出每一项问题与该怎么改。改完提交，再调一次。', active: 6, refused: true },
]

const TOP = 12
const H = 50
const GAP = 18
const FRAME_X = 212
const FRAME_W = 180

export function DkRelease() {
  const state = useSteps(STEPS.length, 3400)
  const current = STEPS[state.step]!
  const checking = current.active === 4
  const refused = current.refused === true
  const chainActive = refused ? 4 : current.active
  const itemColor = checking || refused ? FG : MUTED
  const failY = TOP + ITEMS.length * (H + GAP) + 6
  return (
    <>
      <svg viewBox="0 0 400 490" className={NARROW} role="img" aria-label="devkit.release 发正式版前依次做的检查">
        <Chain x={10} y={TOP} w={186} h={H} gap={GAP} items={ITEMS} active={chainActive} tone={refused ? 'b' : 'a'} />
        <Frame x={FRAME_X} y={TOP} w={FRAME_W} h={failY - TOP - 16} label="发版前检查的各项" lit={checking} size={13} />
        <Note x={FRAME_X + 10} y={TOP + 44} size={12} weight={600} color={FG}>
          每个包
        </Note>
        {EVERY_PACKAGE.map((line, index) => (
          <Note key={line} x={FRAME_X + 14} y={TOP + 66 + index * 22} size={12.5} color={itemColor}>
            {`· ${line}`}
          </Note>
        ))}
        <Note x={FRAME_X + 10} y={TOP + 196} size={12} weight={600} color={FG}>
          插件包另查
        </Note>
        {PLUGIN_ONLY.map((line, index) => (
          <Note key={line} x={FRAME_X + 14} y={TOP + 218 + index * 22} size={12.5} color={itemColor}>
            {`· ${line}`}
          </Note>
        ))}
        <line x1={196} y1={TOP + 4 * (H + GAP) + H / 2} x2={FRAME_X} y2={TOP + 4 * (H + GAP) + H / 2} stroke={checking || refused ? 'var(--diagram-a)' : MUTED} strokeDasharray="3 3" />
        <Box x={10} y={failY} w={380} h={H} lines={['任一项没过：一个包都不发', '回执按包列出每一项问题']} tone={refused ? 'b' : undefined} dashed={!refused} size={14} />
      </svg>
      <StepText title={current.title} detail={current.detail} />
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
