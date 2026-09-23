import { describe, expect, it } from 'vitest'
import { BusyGate, BUSY_MESSAGE } from '../src/busy'

describe('BusyGate：变更互斥', () => {
  it('门开着时照跑，跑完放门', async () => {
    const gate = new BusyGate()
    const out = await gate.run(() => ({ ok: true, data: 1 }))
    expect(out).toEqual({ ok: true, data: 1 })
    const again = await gate.run(() => ({ ok: true, data: 2 }))
    expect(again).toEqual({ ok: true, data: 2 })
  })

  it('占门期间重入回 BUSY，fn 不执行', async () => {
    const gate = new BusyGate()
    let inner = 0
    let release!: () => void
    const first = gate.run(
      () =>
        new Promise<{ ok: true; data: number }>((resolve) => {
          release = () => resolve({ ok: true, data: inner })
        }),
    )
    const second = await gate.run(() => {
      inner += 1
      return { ok: true, data: inner }
    })
    expect(second).toEqual({ ok: false, error: BUSY_MESSAGE })
    expect(inner).toBe(0)
    release()
    expect(await first).toEqual({ ok: true, data: 0 })
  })

  it('fn 抛了也放门，下一趟能跑', async () => {
    const gate = new BusyGate()
    await expect(gate.run(() => { throw new Error('炸了') })).rejects.toThrow('炸了')
    const out = await gate.run(() => ({ ok: true }))
    expect(out).toEqual({ ok: true })
  })
})
