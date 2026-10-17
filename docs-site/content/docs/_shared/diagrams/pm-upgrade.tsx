
/**
 * 一次热升级（update 的 all 或 only）的时间线：横轴是时间，每条横道是一个参与方（B 的 peer 写了被升级的 A，跟着重新加载）。每一步在它那条横道上点亮一个方框；
 * 已经发生的保持显示，还没发生的调淡。竖虚线是回执发出的时刻：插件管理自己与 peer 了它的包在它之后才重新加载。
 */

import { Box, BORDER, FG, MUTED, Note, StepCaption } from './parts'
import { StepControls, useSteps } from './steps'

const LANES = ['调用方', 'plugin-manager', '磁盘 node_modules', '条目 A、B（B 的 peer 写了 A）', '插件管理与依赖它的包', '外壳']

interface Event {
  lane: number
  lines: string[]
}

const STEPS: { title: string; detail: string; events: Event[] }[] = [
  {
    title: '调用 update，定计划',
    detail: '先查过期包（给 specs 时不查，按给定写法算），再由纯函数算出装哪些包、装成哪个版本；再记下装之前每个包的真实目录。',
    events: [
      { lane: 0, lines: ['update', '{ all: true }'] },
      { lane: 1, lines: ['查过期包', '定计划'] },
    ],
  },
  {
    title: '一次 pnpm add 精确版本',
    detail: '一次装完全部过期包，用查到的版本号而不是 @latest。pnpm 装上 A@1.1；B 的目录名带着 A 的版本，也换进新目录。装完再读一次真实目录，B 的变了，跟着重新加载；再读装上的清单里的 peer 排先后：B 的 peer 写了 A，A 先，插件管理自己与 peer 了它的包排到回执之后。这一步失败就一条条目都不动。',
    events: [
      { lane: 1, lines: ['一次', 'pnpm add'] },
      { lane: 2, lines: ['A@1.1 装上', 'B 换新目录'] },
    ],
  },
  {
    title: '按 peer 排的先后：条目 A、再 B 停用再启用',
    detail: '在同一条命令里做：被依赖的 A 先，再是 peer 写了 A 的 B，每条都是停用 → 等旧的卸载完 → 启用 → 等新的加载完。启用时按真实路径重新解析，拿到的就是新目录里的代码；B 重新加载时 A 已经是新版本。',
    events: [{ lane: 3, lines: ['A、B', '停用→启用'] }],
  },
  {
    title: '回执发出',
    detail: '回执里写着 selfDeferred: true，插件管理自己与 peer 了它的包的条目记 deferred。在这之前停用插件管理自己，回执就发不出去了。',
    events: [{ lane: 0, lines: ['收到回执', 'selfDeferred'] }],
  },
  {
    title: '下一个宏任务：插件管理自己，再是 peer 了它的包',
    detail: '先重新加载插件管理自己，再照排好的先后一条接一条重新加载 peer 了它的包（baseui、devkit 这类），一条失败只记日志、接着下一条。这段代码只持有条目树、条目 id 与 logger：插件管理原来的实例已经卸载，ctx 上什么都不能用。',
    events: [{ lane: 4, lines: ['自己→依赖', '它的包'] }],
  },
  {
    title: '调用方整页重新加载',
    detail: '插件管理不整页重新加载。调用方拿到成功回执后自己调外壳的 shell.reload，窗格拿到新版本的页面代码；devkit.dev 本来就自己刷新目标页面。',
    events: [
      { lane: 0, lines: ['调 shell', '.reload'] },
      { lane: 5, lines: ['整页', '重新加载'] },
    ],
  },
]

const LANE_Y = (lane: number) => 34 + lane * 48
const COL_X = (step: number) => 176 + step * 96

export function PmUpgrade() {
  const all = [{ title: '全貌', detail: '一条命令里按时间先后做完：定计划 → 一次 pnpm add → 按 peer 排的先后逐条停用再启用（被依赖的先） → 回执 → 重新加载插件管理自己与 peer 了它的包；调用方拿到回执后自己整页重新加载。', events: [] as Event[] }, ...STEPS]
  const state = useSteps(all.length, 3000)
  const current = all[state.step]!
  const replyX = COL_X(3) - 4

  return (
    <>
      <svg viewBox="0 0 760 414" role="img" aria-label="一次热升级的时间线">
        {LANES.map((lane, index) => (
          <g key={lane}>
            <line x1={14} y1={LANE_Y(index) + 40} x2={746} y2={LANE_Y(index) + 40} stroke={BORDER} />
            <Note x={16} y={LANE_Y(index) + 24} size={11.5} color={FG}>
              {lane}
            </Note>
          </g>
        ))}
        <line x1={replyX} y1={24} x2={replyX} y2={LANE_Y(LANES.length - 1) + 40} stroke={MUTED} strokeDasharray="4 4" />
        <Note x={replyX + 4} y={20} size={11} color={MUTED}>
          回执发出
        </Note>

        {STEPS.map((step, index) => {
          const at = index + 1
          const tone = state.step === at ? 'a' : undefined
          const dim = state.step !== 0 && at > state.step
          return step.events.map((event) => (
            <Box key={`${at}-${event.lane}`} x={COL_X(index)} y={LANE_Y(event.lane) + 4} w={78} h={34} lines={event.lines} tone={tone} dim={dim} />
          ))
        })}

        <Note x={746} y={LANE_Y(LANES.length - 1) + 56} anchor="end" size={11} color={MUTED}>
          时间 →
        </Note>
        <StepCaption x={20} y={356} w={720} title={current.title} detail={current.detail} />
      </svg>
      <StepControls count={all.length} state={state} />
    </>
  )
}
