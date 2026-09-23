/**
 * 升级与重新加载为什么要在同一条命令里：左右两栏各是一条时间轴。上面一行是动作，中间一行是旧版插件
 * 在运行的时段，下面一行是磁盘上的版本目录。左栏分两条命令，旧版在目录删掉之后还运行一段；右栏没有这一段。
 */

import { BORDER, FG, MUTED, Note } from './parts'

function Bar({ x, y, w, label, tone }: { x: number; y: number; w: number; label: string; tone?: 'a' | 'b' }) {
  const stroke = tone === undefined ? MUTED : `var(--diagram-${tone})`
  const fill = tone === undefined ? 'none' : `var(--diagram-${tone}-soft)`
  return (
    <g>
      <rect x={x} y={y} width={w} height={26} rx={5} fill={fill} stroke={stroke} strokeWidth={1.2} />
      <text x={x + w / 2} y={y + 14} textAnchor="middle" dominantBaseline="middle" fontSize={11} fill={FG}>
        {label}
      </text>
    </g>
  )
}

function Panel({ x, title, split }: { x: number; title: string; split: boolean }) {
  const addEnd = x + 116
  const remountStart = split ? x + 236 : addEnd + 4
  const end = x + 336
  return (
    <g>
      <Note x={x} y={24} size={12.5} color={split ? 'var(--diagram-b)' : 'var(--diagram-a)'} weight={600}>
        {title}
      </Note>
      <Note x={x} y={52} size={11} color={MUTED}>
        动作
      </Note>
      <Bar x={x + 16} y={60} w={100} label="pnpm add" />
      <Bar x={remountStart} y={60} w={100} label="停用再启用" />
      {split && (
        <Note x={(addEnd + remountStart) / 2} y={78} anchor="middle" size={10.5} color={MUTED}>
          另一条命令
        </Note>
      )}

      <Note x={x} y={108} size={11} color={MUTED}>
        旧版 A 在运行
      </Note>
      <Bar x={x + 16} y={116} w={100} label="正常运行" />
      {split ? <Bar x={addEnd} y={116} w={remountStart - addEnd} label="目录已删，读不到文件" tone="b" /> : null}

      <Note x={x} y={164} size={11} color={MUTED}>
        磁盘上的目录
      </Note>
      <Bar x={x + 16} y={172} w={100} label="A@1.0" />
      <Bar x={addEnd} y={172} w={end - addEnd} label="A@1.1（A@1.0 已删）" tone="a" />
      <line x1={x + 16} y1={210} x2={end} y2={210} stroke={BORDER} />
      <Note x={end} y={224} anchor="end" size={10.5} color={MUTED}>
        时间 →
      </Note>
    </g>
  )
}

export function PmUpgradeGap() {
  return (
    <svg viewBox="0 0 760 240" role="img" aria-label="升级与重新加载分两条命令时的空档">
      <Panel x={14} title="分两条命令：中间有一段空档" split />
      <Panel x={400} title="同一条命令：没有空档" split={false} />
    </svg>
  )
}
