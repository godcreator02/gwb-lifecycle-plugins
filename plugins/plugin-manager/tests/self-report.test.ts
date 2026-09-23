import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerSelfReportGuard } from '@godcreator/gwb-repo-kit'

/**
 * 自述检查的实现在 @godcreator/gwb-repo-kit，这里只登记。要改检查就改那个包，别把实现抄回来；
 * 本仓特有的断言另写一个 describe。
 *
 * 不给 docsDir：devkit 仓文档站的现状区还没有插件管理的页，「源码 inject 的服务名在现状区里都写了」
 * 那一条指过去会因 gwbData 没写而失败。插件管理的页写进站里以后，把 docsDir 指向
 * `../../../docs-site/content/docs`。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
registerSelfReportGuard({ describe, it, expect }, { root: path.resolve(here, '..') })
