import { locatePnpm } from '@godcreator/gwb-plugin-manager'
import { pnpmPlan } from './dev.js'
import { runWithHomeAuth } from './node-dev-deps.js'
import { COMPONENT_STEP_TIMEOUT_MS, type PnpmInPluginDir } from './shadcn-components.js'

export type PnpmLookupForComponents = { ok: true; inDir(pluginDir: string): PnpmInPluginDir } | { ok: false; error: string }

/**
 * 插件管理认定的那个 pnpm，绑到插件包目录上给 `addTemplateComponents` 用。插件仓不是 home，不关自动补装 peer（见 `pnpmPlan`）。
 * 建仓命令在写文件之前调它：找不到 pnpm 就什么都不写
 */
export async function pnpmForComponents(homeDir?: string): Promise<PnpmLookupForComponents> {
  const pnpm = await locatePnpm()
  if (!pnpm.ok) return { ok: false, error: pnpm.error }
  return { ok: true, inDir: (pluginDir) => (args) => runWithHomeAuth(homeDir, pnpmPlan(args, pluginDir, pnpm.file), COMPONENT_STEP_TIMEOUT_MS) }
}
