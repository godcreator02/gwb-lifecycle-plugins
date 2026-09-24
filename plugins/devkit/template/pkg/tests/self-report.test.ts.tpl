import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerSelfReportGuard } from '@godcreator/gwb-repo-kit'

/**
 * 自述检查——检查逻辑在 @godcreator/gwb-repo-kit，这里只登记。
 * 检查有错就升级那个包，别把它的代码抄进来；本仓特有的断言另写一个 describe。
 *
 * 检查的是：description 的三项齐全（服务 / skill / 命令）、`super(ctx, '<名>')` 提供的服务都写进了
 * description、说明书个数与 `skills/` 对得上、源码 inject 的服务名在文档站现状区里都写了。
 *
 * 文档站在仓根，本文件在 plugins/<短名>/tests/，所以 docsDir 显式指到仓根的现状区；不给的话
 * 守卫去包目录下找 docs-site，找不到就跳过 inject 那一条检查。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
registerSelfReportGuard(
  { describe, it, expect },
  { root: path.resolve(here, '..'), docsDir: path.resolve(here, '../../../docs-site/content/docs') },
)
