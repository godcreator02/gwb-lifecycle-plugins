import type { GwbContext, GwbKernelApi } from '@godcreator/gwb-kernel-desktop'

/** 取内核服务。不要写进 `export const inject` */
export function requireKernel(ctx: Pick<GwbContext, 'gwbKernel'>): GwbKernelApi {
  const kernel = ctx.gwbKernel
  if (kernel === undefined) {
    throw new Error('ctx.gwbKernel 不在——这个插件运行在一个不是 gwb 内核的 cordis 宿主里')
  }
  return kernel
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 命令回执：成功只带 `data`，失败只带 `error`（pnpm 失败时输出的最后几行拼在里面）。经命令总线原样传出去 */
export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string }

/** 几句提醒用「；」连成回执的 `note` 字段；一句都没有时不带这个字段 */
export function noteOf(notes: readonly string[]): { note?: string } {
  return notes.length === 0 ? {} : { note: notes.join('；') }
}
