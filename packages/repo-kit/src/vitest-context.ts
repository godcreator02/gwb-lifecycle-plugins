/** 调用方传进来的 vitest 的 describe / it / expect，只要求结构对得上 */
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
