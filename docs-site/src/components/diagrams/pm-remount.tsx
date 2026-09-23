/**
 * 重新加载为什么要等旧的卸载完：上下两条时间轴。上面停用之后马上启用，新实例启动时旧实例的服务还没撤销，
 * cordis 报错；下面等旧的卸载完再启用，新实例正常加载。
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

function Lane({ y, title, waits }: { y: number; title: string; waits: boolean }) {
  const disposeEnd = waits ? 430 : 480
  const startAt = waits ? 440 : 360
  return (
    <g>
      <Note x={16} y={y + 16} size={12.5} color={waits ? 'var(--diagram-a)' : 'var(--diagram-b)'} weight={600}>
        {title}
      </Note>
      <Note x={16} y={y + 48} size={11} color={MUTED}>
        旧实例
      </Note>
      <Bar x={110} y={y + 30} w={190} label="运行中" />
      <Bar x={300} y={y + 30} w={disposeEnd - 300} label="卸载中，服务还没撤销" />
      <Note x={16} y={y + 84} size={11} color={MUTED}>
        新实例
      </Note>
      <Bar x={startAt} y={y + 66} w={waits ? 170 : 200} label={waits ? '启动 → ACTIVE' : '启动：provide 同名服务'} tone={waits ? 'a' : 'b'} />
      {!waits && (
        <Note x={566} y={y + 84} size={11} color="var(--diagram-b)">
          → service has been registered
        </Note>
      )}
      <line x1={300} y1={y + 26} x2={300} y2={y + 96} stroke={MUTED} strokeDasharray="3 3" />
      <Note x={304} y={y + 104} size={10.5} color={MUTED}>
        停用
      </Note>
      <line x1={startAt} y1={y + 60} x2={startAt} y2={y + 96} stroke={MUTED} strokeDasharray="3 3" />
      <Note x={startAt + 4} y={y + 104} size={10.5} color={MUTED}>
        启用
      </Note>
    </g>
  )
}

export function PmRemount() {
  return (
    <svg viewBox="0 0 760 250" role="img" aria-label="重新加载时不等旧的卸载完与等旧的卸载完">
      <Lane y={0} title="停用后马上启用" waits={false} />
      <line x1={14} y1={118} x2={746} y2={118} stroke={BORDER} />
      <Lane y={124} title="等旧的卸载完再启用" waits />
      <Note x={746} y={244} anchor="end" size={10.5} color={MUTED}>
        时间 →
      </Note>
    </svg>
  )
}
