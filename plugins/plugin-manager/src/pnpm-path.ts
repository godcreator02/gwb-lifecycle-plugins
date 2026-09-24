export interface SpawnPlan {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

/**
 * 环境原样透传，改两处：去掉 `ELECTRON_RUN_AS_NODE`（留着会传给 pnpm 启动的依赖构建脚本）；
 * `pnpm_config_auto_install_peers` 设成 `false`——pnpm 默认把缺的 peer 不声不响装进 `.pnpm`，不进 home 清单、没有条目；
 * 命令行参数 `--config.auto-install-peers=false` 会被 pnpm 忽略，只有环境变量与 home 的 `pnpm-workspace.yaml` 关得掉
 */
export function spawnPlan(file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): SpawnPlan {
  const pnpmEnv: Record<string, string | undefined> = { ...env, pnpm_config_auto_install_peers: 'false' }
  delete pnpmEnv['ELECTRON_RUN_AS_NODE']
  return { command: file, args: [...args], env: pnpmEnv }
}

/** 日志里那一句「用的是哪份 pnpm」 */
export function describePnpm(found: { file: string; version: string }): string {
  return `pnpm ${found.version}（${found.file}）`
}
