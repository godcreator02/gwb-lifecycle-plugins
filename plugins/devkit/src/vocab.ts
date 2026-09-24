import type { GwbContext, GwbKernelApi } from '@godcreator/gwb-plugin-api'

/** 取内核服务。不要写进 `export const inject` */
export function requireKernel(ctx: Pick<GwbContext, 'gwbKernel'>): GwbKernelApi {
  const kernel = ctx.gwbKernel
  if (kernel === undefined) {
    throw new Error('ctx.gwbKernel 不在——这个插件运行在一个不是 gwb 内核的 cordis 宿主里')
  }
  return kernel
}

/** 版本号只留 x.y.z 三段（去掉预发布段与构建段）：插件 peer 里内核包的范围按它写成 `^x.y.z`。调用方保证传入的是合法版本号 */
export function versionCore(version: string): string {
  return version.replace(/[-+].*$/, '')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
