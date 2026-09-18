import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerSelfReportGuard } from '@godcreator/gwb-repo-kit'

/**
 * 自述防漏——**正本住 @godcreator/gwb-repo-kit**，这儿只是挂号薄壳。
 * 修守卫＝升那个包，别把正本抄回来；本仓特有断言另起一份 describe。
 *
 * 守的是：description 三格齐全（服务 / skill / 命令）、`super(ctx, '<名>')` 提供的服务都点了名、
 * 说明书份数对上 `skills/`、源码 inject 的服务名在站现状区里都写了。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
registerSelfReportGuard({ describe, it, expect }, { root: path.resolve(here, '..') })
