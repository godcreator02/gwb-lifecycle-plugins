/**
 * 示意图共用的组件与常量：颜色、方框、连线、说明文字。颜色全部取站点主题变量与 global.css 里的两种强调色，
 * 深浅主题都跟着走。这里不能标 'use client'：服务端渲染的图要从这里取颜色常量，标了就拿到客户端引用而不是字符串。
 * 带状态的分步播放在 steps.tsx。
 */
import type { ReactNode } from 'react'

export const FG = 'var(--color-fd-foreground)'
export const MUTED = 'var(--color-fd-muted-foreground)'
export const BORDER = 'var(--color-fd-border)'
export const BG = 'var(--color-fd-background)'
export const MONO = 'var(--font-mono, monospace)'

export type Tone = 'a' | 'b'

export function toneStroke(tone?: Tone): string {
  return tone === undefined ? MUTED : `var(--diagram-${tone})`
}

export function toneFill(tone?: Tone): string {
  return tone === undefined ? BG : `var(--diagram-${tone}-soft)`
}

const FADE = 'fill 400ms ease, stroke 400ms ease, opacity 400ms ease'

/** 方框：第一行加粗当标题，其余行弱化；dashed 画虚线框（可选的、还没出现的东西）；dim 把整框调淡 */
export function Box({ x, y, w, h, lines, tone, dashed, mono, dim }: { x: number; y: number; w: number; h: number; lines: string[]; tone?: Tone; dashed?: boolean; mono?: boolean; dim?: boolean }) {
  const top = y + h / 2 - ((lines.length - 1) * 16) / 2
  return (
    <g style={{ opacity: dim ? 0.35 : 1, transition: FADE }}>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={toneFill(tone)} stroke={toneStroke(tone)} strokeWidth={1.2} strokeDasharray={dashed ? '5 4' : undefined} style={{ transition: FADE }} />
      {lines.map((line, index) => (
        <text
          key={`${index}-${line}`}
          x={x + w / 2}
          y={top + index * 16}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={index === 0 ? 12.5 : 11}
          fontWeight={index === 0 ? 600 : 400}
          fill={index === 0 ? FG : MUTED}
          fontFamily={mono && index > 0 ? MONO : undefined}
        >
          {line}
        </text>
      ))}
    </g>
  )
}

/** 带箭头的直线；label 写在线的中点旁边 */
export function Arrow({ from, to, label, dashed, tone, labelAt = 'above' }: { from: [number, number]; to: [number, number]; label?: string; dashed?: boolean; tone?: Tone; labelAt?: 'above' | 'below' }) {
  const [x1, y1] = from
  const [x2, y2] = to
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = 7
  const left: [number, number] = [x2 - head * Math.cos(angle - 0.4), y2 - head * Math.sin(angle - 0.4)]
  const right: [number, number] = [x2 - head * Math.cos(angle + 0.4), y2 - head * Math.sin(angle + 0.4)]
  const color = toneStroke(tone)
  const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1)
  return (
    <g style={{ transition: FADE }}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.2} strokeDasharray={dashed ? '4 4' : undefined} />
      <polygon points={`${x2},${y2} ${left[0]},${left[1]} ${right[0]},${right[1]}`} fill={color} />
      {label !== undefined && (
        <text
          x={(x1 + x2) / 2 + (vertical ? 6 : 0)}
          y={(y1 + y2) / 2 + (vertical ? 4 : labelAt === 'above' ? -6 : 14)}
          textAnchor={vertical ? 'start' : 'middle'}
          fontSize={10.5}
          fill={tone === undefined ? MUTED : color}
        >
          {label}
        </text>
      )}
    </g>
  )
}

/** 一段普通说明文字 */
export function Note({ x, y, children, anchor = 'start', size = 11, color = MUTED, weight, mono }: { x: number; y: number; children: ReactNode; anchor?: 'start' | 'middle' | 'end'; size?: number; color?: string; weight?: number; mono?: boolean }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={size} fill={color} fontWeight={weight} fontFamily={mono ? MONO : undefined}>
      {children}
    </text>
  )
}

/** 分界线：一条横向或纵向虚线，旁边一句这条线两边各不知道什么 */
export function SeamLine({ x1, y1, x2, y2, label, labelX, labelY, anchor = 'end' }: { x1: number; y1: number; x2: number; y2: number; label: string; labelX: number; labelY: number; anchor?: 'start' | 'middle' | 'end' }) {
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={MUTED} strokeWidth={1} strokeDasharray="6 5" />
      <text x={labelX} y={labelY} textAnchor={anchor} fontSize={11} fill={MUTED}>
        {label}
      </text>
    </g>
  )
}

/** 分步动画的说明：第几步、这一步做什么 */
export function StepCaption({ x, y, w, title, detail }: { x: number; y: number; w: number; title: string; detail: string }) {
  return (
    <g>
      <text x={x} y={y} fontSize={13} fontWeight={600} fill={FG}>
        {title}
      </text>
      <foreignObject x={x} y={y + 8} width={w} height={48}>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-fd-muted-foreground)' }}>{detail}</div>
      </foreignObject>
    </g>
  )
}
