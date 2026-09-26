'use client'

/**
 * 装上了≠换上了：pnpm add 让链接 node_modules/gwb-shell 指到新目录，正在运行的代码还是从旧目录加载的；
 * 停用再启用之后，运行的代码才换成新目录里的。读者按两个按钮一步步看。
 */
import { useState } from 'react'

type Phase = 'before' | 'installed' | 'reloaded'

const INK = '#1b1b2f'
const MUSTARD = '#ffd23f'
const SALMON = '#ffb4a2'
const MINT = '#7be0ad'
const LILAC = '#c3b1ff'
const CORAL = '#ff6b6b'
const VIOLET = '#5b3cc4'

const CAPTIONS: Record<Phase, string> = {
  before: '外壳 0.14.0 在运行：链接指向它的目录，运行中的代码也是从那里加载的。',
  installed: 'pnpm add 装上了 0.14.1，链接改指新目录。可运行中的代码还是启动时从旧目录加载的那一份——装上了，还没换上。',
  reloaded: '停用、再启用：插件顺着链接重新加载，这回拿到的是新目录里的 0.14.1。旧目录没人用了，pnpm 过一段时间会清掉它。',
}

function Card({ x, y, fill, title, sub, className }: { x: number; y: number; fill: string; title: string; sub: string; className?: string }) {
  return (
    <g className={className ? `ds-anim ${className}` : undefined}>
      <rect x={x + 6} y={y + 6} width={260} height={66} rx={14} fill={INK} />
      <rect x={x} y={y} width={260} height={66} rx={14} fill={fill} stroke={INK} strokeWidth={3} style={{ transition: 'fill 0.4s' }} />
      <text x={x + 16} y={y + 29} fontSize={16} fontWeight={800} className="ds-mono">
        {title}
      </text>
      <text x={x + 16} y={y + 51} fontSize={13} fontWeight={500}>
        {sub}
      </text>
    </g>
  )
}

function Rope({ d, shown, color, marker }: { d: string; shown: boolean; color: string; marker: string }) {
  return <path d={d} pathLength={1} className="ds-rope" data-shown={shown ? '' : undefined} stroke={color} strokeWidth={5} markerEnd={`url(#${marker})`} />
}

export function DirSwap() {
  const [phase, setPhase] = useState<Phase>('before')
  const installed = phase !== 'before'
  const reloaded = phase === 'reloaded'
  const step = phase === 'before' ? 0 : phase === 'installed' ? 1 : 2

  return (
    <figure className="ds not-prose">
      <div className="ds-head">
        <div className="ds-title">
          装上了 <mark>≠</mark> 换上了
        </div>
        <div className="ds-dots" aria-hidden>
          {[0, 1, 2].map((dot) => (
            <span key={dot} data-on={dot <= step ? '' : undefined} />
          ))}
        </div>
      </div>

      <svg viewBox="0 0 740 330" role="img" aria-label="链接指向与运行中的代码加载自哪个目录">
        <defs>
          <marker id="ds-ink" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={INK} />
          </marker>
          <marker id="ds-violet" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={VIOLET} />
          </marker>
        </defs>

        <text x={14} y={30} fontSize={13} fontWeight={800}>
          HOME 里的链接
        </text>
        <Card x={14} y={40} fill={MUSTARD} title="node_modules/gwb-shell" sub="谁 import 外壳，就顺着它找" />

        <text x={14} y={196} fontSize={13} fontWeight={800}>
          正在运行的代码
        </text>
        <Card
          key={phase}
          x={14}
          y={206}
          fill={reloaded ? MINT : installed ? CORAL : LILAC}
          title={reloaded ? '外壳 0.14.1' : '外壳 0.14.0'}
          sub={reloaded ? '重新加载过了' : installed ? '装上了新版本，跑的还是我' : '条目在运行'}
          className={reloaded ? 'ds-flip' : installed ? 'ds-wiggle' : undefined}
        />
        {installed && !reloaded && (
          <g className="ds-anim ds-pop">
            <rect x={196} y={186} width={92} height={30} rx={6} fill="#fff" stroke={INK} strokeWidth={2.5} />
            <text x={242} y={206} textAnchor="middle" fontSize={13} fontWeight={900} style={{ fill: CORAL }}>
              旧代码！
            </text>
          </g>
        )}

        <text x={466} y={30} fontSize={13} fontWeight={800}>
          PNPM 存放包的真实目录
        </text>
        <g style={{ opacity: reloaded ? 0.45 : 1, transition: 'opacity 0.5s' }}>
          <Card x={466} y={40} fill={SALMON} title=".pnpm/gwb-shell@0.14.0" sub="旧版本" />
        </g>
        {reloaded && (
          <g className="ds-anim ds-stamp">
            <rect x={532} y={60} width={150} height={32} rx={4} fill="none" stroke={CORAL} strokeWidth={3} />
            <text x={607} y={82} textAnchor="middle" fontSize={14} fontWeight={900} style={{ fill: CORAL }}>
              没人用了 · 稍后清理
            </text>
          </g>
        )}
        {installed ? (
          <Card key="new" x={466} y={206} fill={MINT} title=".pnpm/gwb-shell@0.14.1" sub="新版本，刚装进来" className="ds-drop" />
        ) : (
          <g>
            <rect x={466} y={206} width={260} height={66} rx={14} fill="none" stroke={INK} strokeOpacity={0.35} strokeWidth={2.5} strokeDasharray="8 7" />
            <text x={596} y={244} textAnchor="middle" fontSize={13} fontWeight={600} opacity={0.5}>
              新版本还没装
            </text>
          </g>
        )}

        <Rope d="M 282 73 C 370 73, 380 73, 456 73" shown={!installed} color={INK} marker="ds-ink" />
        <Rope d="M 282 73 C 380 73, 370 239, 456 239" shown={installed} color={INK} marker="ds-ink" />
        <Rope d="M 282 239 C 380 239, 370 90, 456 90" shown={!reloaded} color={VIOLET} marker="ds-violet" />
        <Rope d="M 282 252 C 370 252, 380 252, 456 252" shown={reloaded} color={VIOLET} marker="ds-violet" />

        <g transform="translate(14 314)">
          <line x1={0} y1={0} x2={30} y2={0} stroke={INK} strokeWidth={5} strokeLinecap="round" />
          <text x={40} y={5} fontSize={13} fontWeight={700}>
            链接指向
          </text>
          <line x1={130} y1={0} x2={160} y2={0} stroke={VIOLET} strokeWidth={5} strokeLinecap="round" />
          <text x={170} y={5} fontSize={13} fontWeight={700}>
            运行中的代码加载自
          </text>
        </g>
      </svg>

      <figcaption className="ds-caption" aria-live="polite">
        {CAPTIONS[phase]}
      </figcaption>

      <div className="ds-buttons">
        <button type="button" className="ds-btn" style={{ background: MUSTARD }} disabled={phase !== 'before'} onClick={() => setPhase('installed')}>
          ① pnpm add 装 0.14.1
        </button>
        <button type="button" className="ds-btn" style={{ background: MINT }} disabled={phase !== 'installed'} onClick={() => setPhase('reloaded')}>
          ② 停用、再启用
        </button>
        <button type="button" className="ds-btn ds-btn-ghost" disabled={phase === 'before'} onClick={() => setPhase('before')}>
          重来
        </button>
      </div>
    </figure>
  )
}
