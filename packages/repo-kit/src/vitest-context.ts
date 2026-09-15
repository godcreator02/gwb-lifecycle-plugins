/**
 * 薄壳传进来的 vitest 三件套，只要结构对得上。收窄在这儿——repo-kit 不依赖 vitest
 * 本身，消费仓用哪一版都行，也不会解析出第二份实例。
 */
export interface GuardExpect {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toContain(part: string): void
  toMatch(pattern: RegExp): void
  toHaveLength(n: number): void
}

export interface GuardVt {
  describe(name: string, fn: () => void): void
  it(name: string, fn: () => void | Promise<void>): void
  expect(actual: unknown, message?: string): GuardExpect
}
