import type { GwbContext, GwbKernelApi } from '@godcreator/gwb-plugin-api'

/**
 * plugin-api 的两个运行时薄 helper 就地内联（实施 Spec D6：该包收敛为纯类型面，helper 打进
 * 消费者）。无状态纯函数，勿加副作用。
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
