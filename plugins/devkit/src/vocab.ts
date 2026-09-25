import type { GwbContext, GwbKernelApi } from '@godcreator/gwb-kernel-desktop'

/** 团队的包名范围：建仓不给 scope 时生成的包在它下面；发版前检查只查这个范围下的库在源上的 latest */
export const TEAM_SCOPE = '@godcreator'

/**
 * 团队源：gitea 上 godcreator 组织的 npm 源，与用户级 `~/.npmrc` 里 `@godcreator` 那行同一个地址。
 * 建仓不给 registry 时写进生成的 `publishConfig.registry`；`devkit.release` 拒没写这个字段的包时拿它作例子
 */
export const TEAM_REGISTRY = 'https://git.tianshen02.online:28377/api/packages/godcreator/npm/'

/** 按 URL 解析得了、协议是 http 或 https 才回 URL，否则回 undefined */
export function parseHttpUrl(raw: string): URL | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
}

/** 取内核服务。不要写进 `export const inject` */
export function requireKernel(ctx: Pick<GwbContext, 'gwbKernel'>): GwbKernelApi {
  const kernel = ctx.gwbKernel
  if (kernel === undefined) {
    throw new Error('ctx.gwbKernel 不在——这个插件运行在一个不是 gwb 内核的 cordis 宿主里')
  }
  return kernel
}

/** 版本号：`x.y.z`，可带预发布段（`0.3.2-dev.20260925120000`）；四个捕获组是主、次、补丁号与预发布段 */
export const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** 版本号只留 x.y.z 三段（去掉预发布段与构建段）：插件 peer 里内核包的范围按它写成 `^x.y.z`。调用方保证传入的是合法版本号 */
export function versionCore(version: string): string {
  return version.replace(/[-+].*$/, '')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
