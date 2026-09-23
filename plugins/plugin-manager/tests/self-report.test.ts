import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerSelfReportGuard } from '@godcreator/gwb-repo-kit'

/**
 * 自述检查的实现在 @godcreator/gwb-repo-kit，这里只登记。要改检查就改那个包，别把实现抄回来；
 * 本仓特有的断言另写一个 describe。
 *
 * 文档站在仓根，插件管理的页在 `docs-site/content/docs/plugin-manager/`，所以 docsDir 显式指过去——
 * 目录里一个 .mdx 都读不到时，「源码 inject 的服务名在文档里都写了」那一条不报错、直接跳过。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
registerSelfReportGuard(
  { describe, it, expect },
  { root: path.resolve(here, '..'), docsDir: path.resolve(here, '../../../docs-site/content/docs/plugin-manager') },
)
