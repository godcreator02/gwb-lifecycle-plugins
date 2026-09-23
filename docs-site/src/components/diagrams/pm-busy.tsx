'use client'

/**
 * 两道「同一时刻只允许一个改动」：左边三条命令，中间是加在四条改动命令上的 BUSY 检查，右边是
 * 串行队列与 pnpm。命令 B 被 BUSY 拒绝；只读的 outdated 不经过 BUSY，但它的 pnpm 照样排队。
 */

import { Arrow, Box, BORDER, FG, Note, StepCaption } from './parts'
import { StepControls, useSteps } from './steps'

type Part = 'a' | 'b' | 'c' | 'gate' | 'slot1' | 'slot2' | 'pnpm'

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
    detail: '两道检查各管一件事：BUSY 让重入的改动命令马上得到回答；串行队列保证任何时候只有一个 pnpm 在运行。',
    lit: [],
    gate: '标志：空',
    slot1: ['（空）'],
    slot2: ['（空）'],
  },
  {
    title: '命令 A（install）进来',
    detail: '通过 BUSY 检查、占住标志；它的 pnpm add 经 applyToHome 进队列，开始运行。',
    lit: ['a', 'gate', 'slot1', 'pnpm'],
    gate: '标志：A 占着',
    slot1: ['A 的 pnpm add', '运行中'],
    slot2: ['（空）'],
  },
  {
    title: '命令 B（uninstall）进来：直接回 BUSY',
    detail: '标志被 A 占着，B 不排队，马上得到 { ok: false, error: "BUSY…" }——排队的话，界面上看起来是点了没反应。',
    lit: ['b', 'gate'],
    rejected: true,
    gate: '标志：A 占着',
    slot1: ['A 的 pnpm add', '运行中'],
    slot2: ['（空）'],
  },
  {
    title: '命令 C（outdated）进来：不过 BUSY，但 pnpm 要排队',
    detail: 'outdated 只读不改 home，不加 BUSY；它的 pnpm outdated 照样排在 A 后面，省得另外处理两个 pnpm 同时运行。',
    lit: ['c', 'slot2'],
    gate: '标志：A 占着',
    slot1: ['A 的 pnpm add', '运行中'],
    slot2: ['C 的 pnpm outdated', '等 A 运行完'],
  },
  {
    title: 'A 结束：释放标志，C 的 pnpm 开始',
    detail: 'A 返回回执时释放标志（抛错也会释放），再来的改动命令又能通过；队列里下一个 pnpm 开始运行。',
    lit: ['gate', 'slot2', 'pnpm'],
    gate: '标志：空',
    slot1: ['A 完成', '已返回回执'],
    slot2: ['C 的 pnpm outdated', '运行中'],
  },
]

export function PmBusy() {
  const state = useSteps(STEPS.length, 3000)
  const current = STEPS[state.step]!
  const lit = (part: Part) => (current.lit.includes(part) ? 'a' : undefined)

  return (
    <>
      <svg viewBox="0 0 760 320" role="img" aria-label="串行队列与 BUSY 互斥">
        <Box x={14} y={30} w={170} h={46} lines={['命令 A', 'plugin-manager.install']} tone={lit('a')} />
        <Box x={14} y={100} w={170} h={46} lines={['命令 B', 'plugin-manager.uninstall']} tone={current.rejected ? 'b' : undefined} />
        <Box x={14} y={176} w={170} h={46} lines={['命令 C（只读）', 'plugin-manager.outdated']} tone={lit('c')} />

        <Box x={230} y={30} w={150} h={116} lines={['BUSY 检查', '只加在四条改动命令上', current.gate]} tone={lit('gate')} />
        <Arrow from={[184, 53]} to={[230, 53]} />
        <Arrow from={[184, 116]} to={[230, 116]} />
        <Arrow from={[230, 132]} to={[184, 132]} label="BUSY" labelAt="below" tone={current.rejected ? 'b' : undefined} />
        <Arrow from={[380, 60]} to={[432, 76]} />
        <Arrow from={[184, 199]} to={[432, 146]} label="不经过 BUSY" labelAt="below" />

        <Note x={428} y={24} size={12} color={FG} weight={600}>
          pnpm 的串行队列
        </Note>
        <rect x={420} y={34} width={200} height={170} rx={10} fill="none" stroke={BORDER} />
        <Box x={432} y={54} w={176} h={46} lines={current.slot1} tone={lit('slot1')} />
        <Box x={432} y={124} w={176} h={46} lines={current.slot2} tone={lit('slot2')} />
        <Note x={432} y={192} size={10.5}>
          前一个失败，后面的照常运行
        </Note>

        <Box x={650} y={54} w={96} h={46} lines={['pnpm', '运行']} tone={lit('pnpm')} />
        <Arrow from={[608, 77]} to={[650, 77]} />

        <StepCaption x={20} y={258} w={720} title={current.title} detail={current.detail} />
      </svg>
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
