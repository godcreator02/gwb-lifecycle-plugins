/** `cdp.mjs` 里被 `src/index.ts` import 的函数的类型。`cdp.mjs` 本身是纯 JS，不进类型检查 */
export function homesRootOf(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string
