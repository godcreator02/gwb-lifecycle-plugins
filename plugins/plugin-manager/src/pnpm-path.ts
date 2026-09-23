/**
 * 用哪个 pnpm、怎么启动——零 I/O 纯逻辑，实际查磁盘、启动进程的部分在 `pnpm.ts`。
 *
 * 插件管理只用**自己依赖里的那份 pnpm**：`dependencies` 里固定版本的 `@pnpm/exe.<平台>-<架构>`，
 * 包里只有一个原生可执行文件，直接 spawn。不依赖 `pnpm` 包：它带安装脚本，pnpm 默认不运行依赖的
 * 安装脚本，每次改 home 都会以 `ERR_PNPM_IGNORED_BUILDS` 退出码 1 结束。
 */

/** 本机平台那份原生 pnpm：包名与包里可执行文件的文件名 */
export function pnpmExecutableOf(platform: string, arch: string): { pkg: string; bin: string } {
  return { pkg: `@pnpm/exe.${platform}-${arch}`, bin: platform === 'win32' ? 'pnpm.exe' : 'pnpm' }
}

export type LookupResult = { ok: true; file: string; version: string } | { ok: false; error: string }

/** 一次 spawn 需要的三样：运行哪个文件、带什么参数、什么环境 */
export interface SpawnPlan {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

/**
 * pnpm 可执行文件 → spawn 参数。直接启动那个可执行文件，环境原样透传，只**去掉**
 * `ELECTRON_RUN_AS_NODE`——它只对 electron 有意义，留着会传给 pnpm 启动的依赖构建脚本。
 */
export function spawnPlan(file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): SpawnPlan {
  const copy = { ...env }
  delete copy['ELECTRON_RUN_AS_NODE']
  return { command: file, args: [...args], env: copy }
}

/** 日志里那一句「用的是哪份 pnpm」 */
export function describePnpm(found: { file: string; version: string }): string {
  return `pnpm ${found.version}（${found.file}）`
}
