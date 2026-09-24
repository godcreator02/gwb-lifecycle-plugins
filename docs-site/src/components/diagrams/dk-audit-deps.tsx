/**
 * devkit.audit-deps 对一条依赖的判法：上半是一条 @godcreator 的 dev 依赖从上往下问四个问题，右边是各自报的 finding；
 * 下半是插件包的 peer，cordis 与内核包以外的每一条报一条。橙色框是要处理的，behind 只是提示。
 */

import { Arrow, Box, MUTED, NARROW, Note } from './parts'

const QX = 10
const QW = 222
const FX = 262
const FW = 128
const H = 50
const LABEL = 12

function row(index: number): number {
  return 70 + index * 72
}

export function DkAuditDeps() {
  const qMid = QX + QW / 2
  return (
    <svg viewBox="0 0 400 524" className={NARROW} role="img" aria-label="devkit.audit-deps 的五种 finding 各在什么情况下报">
      <Box x={QX} y={8} w={QW} h={44} lines={['一条 @godcreator 的 dev 依赖', 'workspace:* 不查']} size={13.5} />

      <Box x={QX} y={row(0)} w={QW} h={H} lines={['写法认得出吗？', '准确版本号或 ^x.y.z']} size={14} />
      <Box x={QX} y={row(1)} w={QW} h={H} lines={['源上有这个版本号吗？', '准确版本号，或 ^ 的下限']} size={14} />
      <Box x={QX} y={row(2)} w={QW} h={H} lines={['源上的 latest 更新吗？']} size={14} />
      <Box x={QX} y={row(3)} w={QW} h={H} lines={['latest 还在 ^ 范围内吗？']} size={14} />
      <Box x={QX} y={row(4)} w={QW} h={H} lines={['out-of-range', '上游出了破坏性版本，必须跟进']} tone="b" size={14} mono />

      <Box x={FX} y={row(0)} w={FW} h={H} lines={['loose-dev-pin', '改成准确或 ^']} tone="b" size={14} />
      <Box x={FX} y={row(1)} w={FW} h={H} lines={['dead-pin', '安装必然失败']} tone="b" size={14} />
      <Note x={FX + 8} y={row(2) + H / 2 + 5} size={13} color={MUTED}>
        不报
      </Note>
      <Box x={FX} y={row(3)} w={FW} h={H} lines={['behind', '提示，不用处理']} size={14} />

      <Arrow from={[qMid, 52]} to={[qMid, row(0)]} />
      {[0, 1, 2].map((index) => (
        <Arrow key={index} from={[qMid, row(index) + H]} to={[qMid, row(index + 1)]} label="是" labelSize={LABEL} />
      ))}
      <Arrow from={[qMid, row(3) + H]} to={[qMid, row(4)]} label="否" labelSize={LABEL} />
      {[0, 1, 2].map((index) => (
        <Arrow key={index} from={[QX + QW, row(index) + H / 2]} to={[FX, row(index) + H / 2]} label="否" labelSize={LABEL} />
      ))}
      <Arrow from={[QX + QW, row(3) + H / 2]} to={[FX, row(3) + H / 2]} label="是" labelSize={LABEL} />

      <line x1={10} y1={row(5) - 6} x2={390} y2={row(5) - 6} stroke={MUTED} strokeDasharray="6 5" />
      <Box x={QX} y={row(5) + 12} w={QW} h={H} lines={['插件包的一条 peer', '不是 cordis 也不是内核包']} size={14} />
      <Box x={FX} y={row(5) + 12} w={FW} h={H} lines={['peer-not-cordis', '按谁提供改写']} tone="b" size={13} />
      <Arrow from={[QX + QW, row(5) + 12 + H / 2]} to={[FX, row(5) + 12 + H / 2]} />
      <Note x={QX} y={row(5) + 12 + H + 20} size={12} color={MUTED}>
        private 的清单与库不查 peer
      </Note>
    </svg>
  )
}
