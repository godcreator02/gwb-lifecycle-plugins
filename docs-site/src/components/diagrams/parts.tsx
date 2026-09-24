/**
 * 示意图共用的组件与常量：颜色、方框、连线、外框、说明文字。颜色全部取站点主题变量与 global.css 里的两种强调色，
 * 深浅主题都跟着走。这里不能标 'use client'：服务端渲染的图要从这里取颜色常量，标了就拿到客户端引用而不是字符串。
 * 带状态的分步播放在 steps.tsx。
 *
 * 画布两种宽度：760 宽的图在正文栏里铺满；手机上缩得太小的图画成 400 宽的窄画布，svg 带 NARROW 这个类名，
 * global.css 给它限宽居中，字号用 Box 的 size 调大。
 */
import type { ReactNode } from 'react'

export const FG = 'var(--color-fd-foreground)'
export const MUTED = 'var(--color-fd-muted-foreground)'
export const BORDER = 'var(--color-fd-border)'
export const BG = 'var(--color-fd-background)'
export const MONO = 'var(--font-mono, monospace)'

/** 窄画布 svg 的类名，样式在 global.css */
export const NARROW = 'diagram-narrow'

export type Tone = 'a' | 'b'

export function toneStroke(tone?: Tone): string {
  return tone === undefined ? MUTED : `var(--diagram-${tone})`
}

export function toneFill(tone?: Tone): string {
  return tone === undefined ? BG : `var(--diagram-${tone}-soft)`
}

const FADE = 'fill 400ms ease, stroke 400ms ease, opacity 400ms ease'

/**
 * 方框：第一行加粗当标题，其余行弱化；dashed 画虚线框（可选的、还没出现的东西）；dim 把整框调淡。
 * size 是标题字号，其余行小 1.5，行距是字号加 3.5
 */
export function Box({ x, y, w, h, lines, tone, dashed, mono, dim, size = 12.5 }: { x: number; y: number; w: number; h: number; lines: string[]; tone?: Tone; dashed?: boolean; mono?: boolean; dim?: boolean; size?: number }) {
  const gap = size + 3.5
  const top = y + h / 2 - ((lines.length - 1) * gap) / 2
  return (
    <g style={{ opacity: dim ? 0.35 : 1, transition: FADE }}>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={toneFill(tone)} stroke={toneStroke(tone)} strokeWidth={1.2} strokeDasharray={dashed ? '5 4' : undefined} style={{ transition: FADE }} />
      {lines.map((line, index) => (
        <text
          key={`${index}-${line}`}
          x={x + w / 2}
          y={top + index * gap}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={index === 0 ? size : size - 1.5}
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

function arrowHead(from: [number, number], to: [number, number]): string {
  const [x1, y1] = from
  const [x2, y2] = to
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = 7
  const left: [number, number] = [x2 - head * Math.cos(angle - 0.4), y2 - head * Math.sin(angle - 0.4)]
  const right: [number, number] = [x2 - head * Math.cos(angle + 0.4), y2 - head * Math.sin(angle + 0.4)]
  return `${x2},${y2} ${left[0]},${left[1]} ${right[0]},${right[1]}`
}

/** 带箭头的直线；label 写在线的中点旁边；flow 让线上的虚线沿箭头方向移动（global.css 的 .diagram-flow，减少动态效果时停住） */
export function Arrow({ from, to, label, dashed, tone, flow, labelAt = 'above', labelSize = 10.5 }: { from: [number, number]; to: [number, number]; label?: string; dashed?: boolean; tone?: Tone; flow?: boolean; labelAt?: 'above' | 'below'; labelSize?: number }) {
  const [x1, y1] = from
  const [x2, y2] = to
  const color = toneStroke(tone)
  const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1)
  return (
    <g style={{ transition: FADE }}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={flow ? 1.6 : 1.2} strokeDasharray={dashed ? '4 4' : undefined} className={flow ? 'diagram-flow' : undefined} />
      <polygon points={arrowHead(from, to)} fill={color} />
      {label !== undefined && (
        <text
          x={(x1 + x2) / 2 + (vertical ? 6 : 0)}
          y={(y1 + y2) / 2 + (vertical ? 4 : labelAt === 'above' ? -6 : 14)}
          textAnchor={vertical ? 'start' : 'middle'}
          fontSize={labelSize}
          fill={tone === undefined ? MUTED : color}
        >
          {label}
        </text>
      )}
    </g>
  )
}

/** 折线箭头：沿 points 依次连过去，箭头画在最后一段的终点；flow 同 Arrow */
export function Route({ points, tone, dashed, flow }: { points: [number, number][]; tone?: Tone; dashed?: boolean; flow?: boolean }) {
  const color = toneStroke(tone)
  const last = points[points.length - 1]!
  const beforeLast = points[points.length - 2]!
  return (
    <g style={{ transition: FADE }}>
      <polyline points={points.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke={color} strokeWidth={flow ? 1.6 : 1.2} strokeDasharray={dashed ? '4 4' : undefined} className={flow ? 'diagram-flow' : undefined} />
      <polygon points={arrowHead(beforeLast, last)} fill={color} />
    </g>
  )
}

/** 竖排步骤里的一格 */
export interface ChainItem {
  lines: string[]
  /** 可能被跳过的一步画虚线框 */
  dashed?: boolean
  mono?: boolean
}

/**
 * 竖排的一串步骤，从上往下连箭头。active 是当前这一步的下标（点亮、进入它的连线流动），它后面的调淡；
 * active 为 -1 时是全貌，都不点亮也不调淡。每格的 y 是 y + 下标 × (h + gap)，图里别的东西按这个对齐
 */
export function Chain({ x, y, w, h, gap, items, active, size = 14, tone = 'a' }: { x: number; y: number; w: number; h: number; gap: number; items: ChainItem[]; active: number; size?: number; tone?: Tone }) {
  const mid = x + w / 2
  return (
    <g>
      {items.map((item, index) => {
        const top = y + index * (h + gap)
        return (
          <g key={item.lines[0]}>
            {index > 0 && <Arrow from={[mid, top - gap]} to={[mid, top]} tone={index === active ? tone : undefined} flow={index === active} />}
            <Box x={x} y={top} w={w} h={h} lines={item.lines} tone={index === active ? tone : undefined} dashed={item.dashed} mono={item.mono} dim={active >= 0 && index > active} size={size} />
          </g>
        )
      })}
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

/** 外框：圈住同一个进程、插件或文件里的几样东西，左上角写名字；lit 时框线换成强调色 */
export function Frame({ x, y, w, h, label, lit, size = 12 }: { x: number; y: number; w: number; h: number; label: string; lit?: boolean; size?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill="none" stroke={lit ? 'var(--diagram-a)' : BORDER} strokeWidth={lit ? 1.4 : 1} style={{ transition: FADE }} />
      <text x={x + 10} y={y + size + 5} fontSize={size} fontWeight={600} fill={FG}>
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
