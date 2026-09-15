import { describe, expect, it } from 'vitest'
import { registerPluginGuard } from '@godcreator/gwb-repo-kit'
import { apply, name } from '../src/index.js'

/**
 * 件的身份与挂载登记——**正本住 @godcreator/gwb-repo-kit**，这儿只报参数。
 * 本仓特有断言另起 describe；要直接摸挂载替身，import 它的 mountHarness。
 */
registerPluginGuard({ describe, it, expect }, {
  apply,
  name,
  pkgName: '{{pkgName}}',
  short: '{{name}}',
})
