import { describe, expect, it } from 'vitest'
import { registerPluginGuard } from '@godcreator/gwb-repo-kit'
import { apply, name } from '../src/index.js'

/**
 * 插件名与包名对得上、`apply` 在替身上能运行、登记的每条命令 `plugin` 是包名且 `description` 与 `usage`
 * 非空、每个窗格 `id` 非空——**检查逻辑在 @godcreator/gwb-repo-kit**，这里只传参数。不查有几个窗格、
 * 几条命令，模板改成真插件之后照样适用。本仓特有的断言另写一个 describe；要自己用替身调 apply、
 * 看注册了什么，import 它的 mountHarness。
 */
registerPluginGuard({ describe, it, expect }, {
  apply,
  name,
  pkg: '{{pkg}}',
  pkgName: '{{pkgName}}',
  short: '{{name}}',
})
