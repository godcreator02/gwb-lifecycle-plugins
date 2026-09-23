import type { GwbContext, GwbKernelApi } from '@godcreator/gwb-plugin-api'

/**
 * plugin-api 的两个运行时小 helper 在这里内联：plugin-api 只提供类型，helper 由使用方
 * 各自带一份。无状态纯函数，不要加副作用。
 */

/** 取内核服务。不要写进 `export const inject` */
export function requireKernel(ctx: Pick<GwbContext, 'gwbKernel'>): GwbKernelApi {
  const kernel = ctx.gwbKernel
  if (kernel === undefined) {
    throw new Error('ctx.gwbKernel 不在——这个插件跑在一个不是 gwb 内核的 cordis 宿主里')
  }
  return kernel
}

/** 把 unknown 收窄成对象 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
