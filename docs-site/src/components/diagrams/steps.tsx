'use client'

/** 分步动画的状态与控制按钮：自动播放，每隔一段时间走一步，走到头从 0 再来；系统设置了减少动态效果时不自动播放 */

import { useEffect, useState } from 'react'

export function useSteps(count: number, intervalMs = 2600) {
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(false)
  }, [])
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => setStep((value) => (value + 1) % count), intervalMs)
    return () => window.clearInterval(timer)
  }, [playing, count, intervalMs])
  return { step, setStep, playing, setPlaying }
}

/**
 * 这一步的说明，写在 svg 外面的 HTML 里：跟正文一样按屏宽折行、字号不随图缩小。
 * 窄画布的图用它，不用 parts.tsx 里画在 svg 里的 StepCaption
 */
export function StepText({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="diagram-step" aria-live="polite">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}

/** 图下的三个按钮：上一步、下一步、暂停 / 自动播放 */
export function StepControls({ count, state }: { count: number; state: ReturnType<typeof useSteps> }) {
  const { setStep, playing, setPlaying } = state
  return (
    <div className="diagram-controls">
      <button type="button" onClick={() => { setPlaying(false); setStep((value) => Math.max(0, value - 1)) }}>
        上一步
      </button>
      <button type="button" onClick={() => { setPlaying(false); setStep((value) => Math.min(count - 1, value + 1)) }}>
        下一步
      </button>
      <button type="button" aria-pressed={playing} onClick={() => setPlaying((value) => !value)}>
        {playing ? '暂停' : '自动播放'}
      </button>
    </div>
  )
}
