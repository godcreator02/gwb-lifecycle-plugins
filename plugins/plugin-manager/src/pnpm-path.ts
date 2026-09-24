export interface SpawnPlan {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

/** 环境原样透传，只去掉 `ELECTRON_RUN_AS_NODE`：留着会传给 pnpm 启动的依赖构建脚本 */
export function spawnPlan(file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): SpawnPlan {
  const envWithoutElectronFlag = { ...env }
  delete envWithoutElectronFlag['ELECTRON_RUN_AS_NODE']
  return { command: file, args: [...args], env: envWithoutElectronFlag }
}

/** 日志里那一句「用的是哪份 pnpm」 */
export function describePnpm(found: { file: string; version: string }): string {
  return `pnpm ${found.version}（${found.file}）`
}
