import { describe, expect, it } from 'vitest'
import { registerPluginGuard } from '@godcreator/gwb-repo-kit'
import { apply, name } from '../src/index.js'

/**
 * 插件名与包名对得上、apply 时注册了窗格和命令——**检查逻辑在 @godcreator/gwb-repo-kit**，这里只传参数。
 * 本仓特有的断言另写一个 describe；要自己用假 ctx 调 apply、看注册了什么，import 它的 mountHarness。
 */
registerPluginGuard({ describe, it, expect }, {
  apply,
  name,
  pkg: '{{pkg}}',
  pkgName: '{{pkgName}}',
  short: '{{name}}',
})
