'use client'

/**
 * 停用之后马上启用，和等旧实例卸载完再启用：三条时间线（旧实例、它提供的服务、新实例）跟着播放头往前走，
 * 看新实例注册同名服务的那一刻，旧的撤销了没有。
 */
import { useEffect, useRef, useState } from 'react'

type Mode = 'immediate' | 'wait'

const END = 4
const STOP_AT = 1
const UNLOADED_AT = 2.2
const START_AT: Record<Mode, number> = { immediate: 1.2, wait: 2.5 }
const REGISTER_DELAY = 0.3
const X0 = 150
const X1 = 720
const xOf = (t: number) => X0 + ((X1 - X0) * t) / END

const INK = '#111'
const ORANGE = '#ff9f1c'
const CYAN = '#2ec4ff'
const RED = '#ff3b3b'
const GREEN = '#2ecc71'

function useClock(runKey: string): number {
  const [time, setTime] = useState(0)
  const frame = useRef(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTime(END)
      return
    }
    setTime(0)
    const started = performance.now()
    const tick = (now: number) => {
      const next = Math.min(END, (now - started) / 1000)
      setTime(next)
      if (next < END) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [runKey])
  return time
}

/** 漫画爆炸框：锯齿星形 */
function burstPoints(cx: number, cy: number, outer: number, inner: number, spikes: number): string {
  return Array.from({ length: spikes * 2 }, (_, index) => {
    const radius = index % 2 === 0 ? outer : inner * (0.85 + ((index * 37) % 10) / 40)
    const angle = (Math.PI * index) / spikes - Math.PI / 2
    return `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`
  }).join(' ')
}

function Bar({ y, from, to, fill, label, light }: { y: number; from: number; to: number; fill: string; label: string; light?: boolean }) {
  if (to <= from) return null
  const width = xOf(to) - xOf(from)
  return (
    <g>
      <rect x={xOf(from)} y={y - 17} width={width} height={34} rx={6} fill={fill} stroke={INK} strokeWidth={3} />
      {width > 84 && label !== '' && (
        <text x={xOf(from) + 10} y={y + 6} fontSize={14} fontWeight={900} style={light ? { fill: '#fff' } : undefined}>
          {label}
        </text>
      )}
    </g>
  )
}

const LANES = [
  { label: '旧实例', y: 50 },
  { label: '服务 gwbNotes', y: 118 },
  { label: '新实例', y: 186 },
]

export function RemountRace() {
  const [mode, setMode] = useState<Mode>('immediate')
  const [run, setRun] = useState(0)
  const time = useClock(`${mode}-${run}`)
  const start = START_AT[mode]
  const registerAt = start + REGISTER_DELAY
  const clash = mode === 'immediate' && time >= registerAt
  const ok = mode === 'wait' && time >= registerAt
  const hitX = xOf(registerAt)

  return (
    <figure className="rr not-prose">
      <div className="rr-head">
        <span className="rr-title">停用之后，什么时候启用？</span>
        <div className="rr-toggle" role="group" aria-label="停用之后什么时候启用">
          <button type="button" aria-pressed={mode === 'immediate'} onClick={() => setMode('immediate')}>
            马上启用
          </button>
          <button type="button" aria-pressed={mode === 'wait'} onClick={() => setMode('wait')}>
            等卸载完再启用
          </button>
          <button type="button" className="rr-replay" onClick={() => setRun(run + 1)}>
            ↻ 再放一遍
          </button>
        </div>
      </div>

      <div className="rr-panel">
        <svg viewBox="0 0 740 262" role="img" aria-label="旧实例、服务、新实例三条时间线">
          <defs>
            <pattern id="rr-stripes" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="10" height="10" fill="#fff" />
              <rect width="4" height="10" fill={INK} />
            </pattern>
          </defs>
          {LANES.map((lane) => (
            <text key={lane.label} x={4} y={lane.y + 6} fontSize={14} fontWeight={900}>
              {lane.label}
            </text>
          ))}
          {[
            { t: STOP_AT, text: '停用' },
            { t: UNLOADED_AT, text: '旧实例卸载完' },
          ].map((mark) => (
            <g key={mark.text}>
              <line x1={xOf(mark.t)} y1={20} x2={xOf(mark.t)} y2={214} stroke={INK} strokeWidth={2} strokeDasharray="5 5" />
              <text x={xOf(mark.t)} y={240} textAnchor="middle" fontSize={14} fontWeight={900}>
                {mark.text}
              </text>
            </g>
          ))}

          <Bar y={50} from={0} to={Math.min(time, STOP_AT)} fill="#fff" label="运行中" />
          <Bar y={50} from={STOP_AT} to={Math.min(time, UNLOADED_AT)} fill="url(#rr-stripes)" label="" />
          <Bar y={118} from={0} to={Math.min(time, UNLOADED_AT)} fill={ORANGE} label="旧实例注册的" />
          {ok && <Bar y={118} from={registerAt} to={Math.min(time, END)} fill={CYAN} label="新实例注册的" />}
          <Bar y={186} from={start} to={Math.min(time, clash ? registerAt : END)} fill={clash ? RED : CYAN} label={ok ? '' : '启动中'} light={clash} />

          <line x1={xOf(time)} y1={14} x2={xOf(time)} y2={218} stroke={RED} strokeWidth={3} />
          <polygon points={`${xOf(time) - 8},6 ${xOf(time) + 8},6 ${xOf(time)},18`} fill={RED} stroke={INK} strokeWidth={2} />

          {clash && (
            <g className="rr-burst">
              <polygon points={burstPoints(hitX + 96, 150, 92, 52, 14)} fill={RED} stroke={INK} strokeWidth={3.5} />
              <text x={hitX + 96} y={146} textAnchor="middle" fontSize={26} fontWeight={900} style={{ fill: '#fff', fontStyle: 'italic' }}>
                撞了！
              </text>
              <text x={hitX + 96} y={170} textAnchor="middle" fontSize={11.5} fontWeight={800} style={{ fill: '#ffe14d' }}>
                service has been registered
              </text>
            </g>
          )}
          {ok && (
            <g className="rr-burst">
              <polygon points={burstPoints(hitX + 70, 186, 58, 38, 12)} fill={GREEN} stroke={INK} strokeWidth={3} />
              <text x={hitX + 70} y={193} textAnchor="middle" fontSize={17} fontWeight={900} style={{ fill: '#fff', fontStyle: 'italic' }}>
                ACTIVE！
              </text>
            </g>
          )}
        </svg>
      </div>
    </figure>
  )
}
