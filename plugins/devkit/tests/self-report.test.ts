import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerSelfReportGuard } from '@godcreator/gwb-repo-kit'

/**
 * 自述防漏——**正本住 @godcreator/gwb-repo-kit**，这儿只是挂号薄壳。
 * 修守卫＝升那个包，别把正本抄回来；本仓特有断言另起一份 describe。
 *
 * 文档站在仓根，薄壳在 plugins/devkit/tests/，所以 docsDir 显式指过去——缺了那条
 * （inject 的服务名要在现状区里出现）会静默空跑。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
registerSelfReportGuard(
  { describe, it, expect },
  { root: path.resolve(here, '..'), docsDir: path.resolve(here, '../../../docs-site/content/docs') },
)
