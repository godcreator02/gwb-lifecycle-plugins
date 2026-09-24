'use client'

/**
 * 同一时刻只允许一个改动：左边三条命令，中间是加在五条改动命令上的 BUSY 检查，右边是 home 里正在运行的 pnpm。
 * 命令 B 被 BUSY 拒绝；只读的 outdated 不经过 BUSY，它的 pnpm 和改动命令的 pnpm 同时运行。
 */

import { Arrow, Box, BORDER, FG, Note, StepCaption } from './parts'
import { StepControls, useSteps } from './steps'

type Part = 'a' | 'b' | 'c' | 'gate' | 'slot1' | 'slot2'

interface Step {
  title: string
  detail: string
  lit: Part[]
  rejected?: boolean
  gate: string
  slot1: string[]
  slot2: string[]
}

const STEPS: Step[] = [
  {
    title: '全貌',
    detail: 'BUSY 保证同一时刻只有一条改动命令在运行，会写 home 的 pnpm 都在这几条命令里，所以不会有两个同时运行；只读的 outdated 不经过 BUSY。',
    lit: [],
    gate: '标志：空',
    slot1: ['（空）'],
    slot2: ['（空）'],
  },
  {
    title: '命令 A（install）进来',
    detail: '通过 BUSY 检查、占住标志；它的 pnpm add 经 applyToHome 运行，写 home 的 package.json 与锁文件。',
    lit: ['a', 'gate', 'slot1'],
    gate: '标志：A 占着',
    slot1: ['A 的 pnpm add', '运行中，写 home'],
    slot2: ['（空）'],
  },
  {
    title: '命令 B（uninstall）进来：直接回 BUSY',
    detail: '标志被 A 占着，B 不排队，马上得到 { ok: false, error: "BUSY…" }。两个写 home 的 pnpm 同时运行会丢改动，而且都退出码 0。',
    lit: ['b', 'gate'],
    rejected: true,
    gate: '标志：A 占着',
    slot1: ['A 的 pnpm add', '运行中，写 home'],
    slot2: ['（空）'],
  },
  {
    title: '命令 C（outdated）进来：不过 BUSY，pnpm 直接运行',
    detail: 'pnpm outdated 不写文件，和 A 的 pnpm add 同时运行，add 的结果不受影响（实测 5 轮都对）。',
    lit: ['c', 'slot2'],
    gate: '标志：A 占着',
    slot1: ['A 的 pnpm add', '运行中，写 home'],
    slot2: ['C 的 pnpm outdated', '运行中，只读'],
  },
  {
    title: 'A 结束：释放标志',
    detail: 'A 返回回执时释放标志（抛错也会释放），再来的改动命令又能通过。',
    lit: ['gate'],
    gate: '标志：空',
    slot1: ['A 完成', '已返回回执'],
    slot2: ['C 的 pnpm outdated', '运行中，只读'],
  },
]

export function PmBusy() {
  const state = useSteps(STEPS.length, 3000)
  const current = STEPS[state.step]!
  const lit = (part: Part) => (current.lit.includes(part) ? 'a' : undefined)

  return (
    <>
      <svg viewBox="0 0 760 320" role="img" aria-label="BUSY 互斥与 home 里运行的 pnpm">
        <Box x={14} y={30} w={170} h={46} lines={['命令 A', 'plugin-manager.install']} tone={lit('a')} />
        <Box x={14} y={100} w={170} h={46} lines={['命令 B', 'plugin-manager.uninstall']} tone={current.rejected ? 'b' : undefined} />
        <Box x={14} y={176} w={170} h={46} lines={['命令 C（只读）', 'plugin-manager.outdated']} tone={lit('c')} />

        <Box x={230} y={30} w={150} h={116} lines={['BUSY 检查', '只加在五条改动命令上', current.gate]} tone={lit('gate')} />
        <Arrow from={[184, 53]} to={[230, 53]} />
        <Arrow from={[184, 116]} to={[230, 116]} />
        <Arrow from={[230, 132]} to={[184, 132]} label="BUSY" labelAt="below" tone={current.rejected ? 'b' : undefined} />
        <Arrow from={[380, 60]} to={[472, 76]} />
        <Arrow from={[184, 199]} to={[472, 146]} label="不经过 BUSY" labelAt="below" />

        <Note x={468} y={24} size={12} color={FG} weight={600}>
          home 里正在运行的 pnpm
        </Note>
        <rect x={460} y={34} width={220} height={170} rx={10} fill="none" stroke={BORDER} />
        <Box x={472} y={54} w={196} h={46} lines={current.slot1} tone={lit('slot1')} />
        <Box x={472} y={124} w={196} h={46} lines={current.slot2} tone={lit('slot2')} />
        <Note x={472} y={192} size={10.5}>
          写 home 的同一时刻最多一个
        </Note>

        <StepCaption x={20} y={258} w={720} title={current.title} detail={current.detail} />
      </svg>
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
