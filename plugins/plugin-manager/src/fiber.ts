// 零 I/O 纯逻辑：这个文件里不 import node:fs

/** cordis 的 `FiberState`，按它的定义照抄数字顺序（`const enum`，`isolatedModules` 下引用不到）；`tests/fiber-state.test.ts` 核对 */
export const FIBER_STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const

/** 条目此刻到哪一步了，一个词。取法与内核 `main.ts` 的 `describe()` 一致：没 fiber 是 import 失败，认不出的数字原样带出来 */
export function fiberStateOf(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return 'no entry'
  const record = entry as { disabled?: unknown; fiber?: unknown }
  if (record.disabled === true) return 'disabled'
  const fiber = record.fiber
  if (typeof fiber !== 'object' || fiber === null) return 'no fiber（import 失败，原因在日志里）'
  const state = (fiber as { state?: unknown }).state
  if (typeof state !== 'number') return `state=${String(state)}`
  return FIBER_STATE[state] ?? `state=${String(state)}`
}

/**
 * 等 fiber 把手头的加载或卸载做完，最多等 `ms` 毫秒。cordis 的 `Fiber.await()` 在 PENDING 时立刻返回，
 * 会卡住的只有某个插件的 `apply` 自己不返回，所以超时就继续；它抛的错（FAILED）忽略，状态另外读
 */
export function settleFiber(fiber: unknown, ms: number): Promise<void> {
  if (typeof fiber !== 'object' || fiber === null) return Promise.resolve()
  const awaitMethod = (fiber as { await?: unknown }).await
  if (typeof awaitMethod !== 'function') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const finish = (): void => {
      clearTimeout(timer)
      resolve()
    }
    Promise.resolve((awaitMethod as () => Promise<unknown>).call(fiber)).then(finish, finish)
  })
}
