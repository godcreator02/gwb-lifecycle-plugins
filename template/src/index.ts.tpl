import type { GwbContext } from '@godcreator02/gwb-plugin-api'

export const name = '{{pkgName}}'

export function apply(ctx: GwbContext): void {
  // 先让自己挂上、日志里见着，再往里加东西——每一步都实机验，见 skill「gwb-devkit」
  ctx.logger(name).info('{{title}} 起来了')
}
