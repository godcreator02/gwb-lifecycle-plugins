import { describe, expect, it } from 'vitest'
import { BusyGate, BUSY_MESSAGE } from '../src/busy'

describe('BusyGate：同一时刻只允许一个改动', () => {
  it('没有改动在运行时照常执行，执行完释放标志', async () => {
    const gate = new BusyGate()
    const out = await gate.run(() => ({ ok: true, data: 1 }))
    expect(out).toEqual({ ok: true, data: 1 })
    const again = await gate.run(() => ({ ok: true, data: 2 }))
    expect(again).toEqual({ ok: true, data: 2 })
  })

  it('有改动在运行时重入回 BUSY，不执行', async () => {
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

  it('执行中抛错也释放标志，下一次能执行', async () => {
    const gate = new BusyGate()
    await expect(gate.run(() => { throw new Error('炸了') })).rejects.toThrow('炸了')
    const out = await gate.run(() => ({ ok: true }))
    expect(out).toEqual({ ok: true })
  })
})
