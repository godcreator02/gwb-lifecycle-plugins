import type { GwbContext, GwbKernelApi } from '@godcreator/gwb-plugin-api'

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
