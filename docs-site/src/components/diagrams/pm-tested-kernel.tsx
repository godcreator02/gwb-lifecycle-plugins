/**
 * 版本线比对的例子：上半是运行中的内核 0.2.7（主版本号为 0，比前两位），下半是内核 1.4.0（只比主版本号）。
 * 每行左边是插件声明的 gwb.testedKernel，右边是 list 报的 kernelUntested。最下面两格是谁拿这个结果做什么。
 */

import { Box, FG, MUTED, NARROW, Note } from './parts'

interface Row {
  declared: string
  why: string
  untested: boolean
}

const ZERO_LINE: Row[] = [
  { declared: '0.2.1', why: '都是 0.2', untested: false },
  { declared: '0.3.0', why: '0.3 ≠ 0.2', untested: true },
  { declared: '没写', why: '算没测过', untested: true },
  { declared: '"latest"', why: '不是合法版本号', untested: true },
]

const ONE_LINE: Row[] = [
  { declared: '1.0.2', why: '都是 1', untested: false },
  { declared: '2.0.0', why: '2 ≠ 1', untested: true },
]

function Rows({ y, rows }: { y: number; rows: Row[] }) {
  return (
    <g>
      {rows.map((row, index) => {
        const top = y + index * 34
        return (
          <g key={row.declared}>
            <text x={16} y={top + 18} fontSize={13} fill={FG} fontFamily="var(--font-mono, monospace)">
              {row.declared}
            </text>
            <text x={112} y={top + 18} fontSize={12.5} fill={MUTED}>
              {row.why}
            </text>
            <rect x={250} y={top} width={140} height={26} rx={6} fill={row.untested ? 'var(--diagram-b-soft)' : 'var(--diagram-a-soft)'} stroke={row.untested ? 'var(--diagram-b)' : 'var(--diagram-a)'} />
            <text x={320} y={top + 17} textAnchor="middle" fontSize={12.5} fill={FG} fontFamily="var(--font-mono, monospace)">
              {row.untested ? 'true' : 'false'}
            </text>
          </g>
        )
      })}
    </g>
  )
}

export function PmTestedKernel() {
  return (
    <svg viewBox="0 0 400 452" className={NARROW} role="img" aria-label="gwb.testedKernel 与运行中的内核按版本线比对的例子">
      <Note x={16} y={20} size={12} color={MUTED}>
        声明的版本
      </Note>
      <Note x={320} y={20} anchor="middle" size={12} color={MUTED}>
        kernelUntested
      </Note>
      <Note x={10} y={48} size={13.5} weight={600} color={FG}>
        内核 0.2.7：主版本号为 0，比前两位
      </Note>
      <Rows y={60} rows={ZERO_LINE} />
      <Note x={10} y={218} size={13.5} weight={600} color={FG}>
        内核 1.4.0：主版本号 ≥1，只比主版本号
      </Note>
      <Rows y={230} rows={ONE_LINE} />
      <line x1={10} y1={314} x2={390} y2={314} stroke={MUTED} strokeDasharray="6 5" />
      <Box x={10} y={330} w={185} h={62} lines={['plugin-manager.list', '只报告，照常加载']} size={13.5} />
      <Box x={205} y={330} w={185} h={62} lines={['devkit.release', '插件包是 true 就拒发']} size={13.5} />
      <Note x={10} y={418} size={12} color={MUTED}>
        两边的比对规则各有一份，同一个提交一起改，
      </Note>
      <Note x={10} y={438} size={12} color={MUTED}>
        对照测试拿同一组版本号比两份的结果
      </Note>
    </svg>
  )
}
