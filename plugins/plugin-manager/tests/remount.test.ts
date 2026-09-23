import { describe, expect, it } from 'vitest'
import { remountOne, type RemountLog, type Schedule } from '../src/remount.js'
import type { EntryTreeLike } from '../src/tree.js'

/**
 * `remount` 一趟：停用 → 等拆完 → 启用 → 等挂上。条目树是假的：停用把 fiber 置成 DISPOSED 并
 * 摘掉，启用新建一个 ACTIVE 的 fiber——跟 loader 的 update 同一个形状。
 */

const ACTIVE = 2
const DISPOSED = 4

interface FakeFiber {
  state: number
  await: () => Promise<void>
}

function fiber(): FakeFiber {
  return { state: ACTIVE, await: () => Promise.resolve() }
}

interface FakeTree extends EntryTreeLike {
  /** 按发生顺序记下每一次 update：`<id> off` / `<id> on` */
  calls: string[]
}

function fakeTree(ids: readonly string[], onDisable?: (id: string) => void): FakeTree {
  const store = Object.create(null) as Record<string, { disabled: boolean; fiber: FakeFiber | undefined }>
  for (const id of ids) store[id] = { disabled: false, fiber: fiber() }
  const calls: string[] = []
  return {
    store,
    calls,
    create: () => Promise.reject(new Error('不该调')),
    remove: () => undefined,
    resolve: (id) => store[id],
    update: (id, options) => {
      const entry = store[id]
      if (entry === undefined) return Promise.reject(new Error(`cannot resolve entry ${id}`))
      if (options['disabled'] === true) {
        calls.push(`${id} off`)
        entry.disabled = true
        if (entry.fiber !== undefined) entry.fiber.state = DISPOSED
        entry.fiber = undefined
        onDisable?.(id)
      } else if (options['disabled'] === null) {
        calls.push(`${id} on`)
        entry.disabled = false
        entry.fiber = fiber()
      }
      return Promise.resolve()
    },
  }
}

function quietLog(): RemountLog & { lines: string[] } {
  const lines: string[] = []
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(`warn ${m}`) }
}

/** 手动触发的「下一个宏任务」 */
function manualSchedule(): { schedule: Schedule; flush: () => void; pending: () => number } {
  const tasks: (() => void)[] = []
  return {
    schedule: (task) => tasks.push(task),
    flush: () => {
      for (const task of tasks.splice(0)) task()
    },
    pending: () => tasks.length,
  }
}

const OWN = 'plugin-manager'

describe('remountOne：普通条目在这一趟里做完', () => {
  it('停用再启用、回 remounted 带重挂后的状态', async () => {
    const tree = fakeTree([OWN, 'hello'])
    const result = await remountOne(tree, 'hello', OWN, quietLog(), manualSchedule().schedule, 10)
    expect(result).toEqual({ id: 'hello', action: 'remounted', state: 'ACTIVE' })
    expect(tree.calls).toEqual(['hello off', 'hello on'])
  })

  it('本来停用的条目：终态是启用', async () => {
    const tree = fakeTree([OWN, 'hello'])
    await tree.update('hello', { disabled: true })
    tree.calls.length = 0
    const result = await remountOne(tree, 'hello', OWN, quietLog(), manualSchedule().schedule, 10)
    expect(result).toEqual({ id: 'hello', action: 'remounted', state: 'ACTIVE' })
  })

  it('动条目树时抛了：回 failed，state 里是那句错', async () => {
    const tree = fakeTree([OWN])
    const result = await remountOne(tree, 'ghost', OWN, quietLog(), manualSchedule().schedule, 10)
    expect(result.action).toBe('failed')
    expect(result.state).toContain('cannot resolve entry ghost')
  })
})

describe('remountOne：目标是本件自己', () => {
  it('当下回 deferred（动手前的状态），一下都没动；下一个宏任务才重挂', async () => {
    const tree = fakeTree([OWN, 'hello'])
    const timers = manualSchedule()
    const log = quietLog()
    const result = await remountOne(tree, OWN, OWN, log, timers.schedule, 10)
    expect(result).toEqual({ id: OWN, action: 'deferred', state: 'ACTIVE' })
    expect(tree.calls).toEqual([])
    expect(timers.pending()).toBe(1)

    timers.flush()
    await expect.poll(() => tree.calls).toEqual([`${OWN} off`, `${OWN} on`])
    await expect.poll(() => log.lines.some((line) => line.includes('重挂了：ACTIVE'))).toBe(true)
  })
})

describe('remountOne：目标是命令总线', () => {
  it('总线停用时撤掉全部命令（连 remount 这条），处理器那条链照样做完、条目回到启用', async () => {
    const bus = new Map<string, (args: { entryId: string }) => Promise<unknown>>()
    const tree = fakeTree([OWN, 'commands'], (id) => {
      if (id === 'commands') bus.clear()
    })
    const timers = manualSchedule()
    bus.set('plugin-manager.remount', (args) => remountOne(tree, args.entryId, OWN, quietLog(), timers.schedule, 10))

    const handler = bus.get('plugin-manager.remount')!
    const result = await handler({ entryId: 'commands' })

    expect(result).toEqual({ id: 'commands', action: 'remounted', state: 'ACTIVE' })
    expect(tree.calls).toEqual(['commands off', 'commands on'])
    expect(bus.size).toBe(0)
    expect(timers.pending()).toBe(0)
    expect((tree.store['commands'] as { disabled: boolean }).disabled).toBe(false)
  })
})
