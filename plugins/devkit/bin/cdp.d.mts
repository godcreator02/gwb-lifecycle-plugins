/** `cdp.mjs` 里被 `src/index.ts` import 的名字的类型。`cdp.mjs` 本身是纯 JS，不进类型检查 */
export function homesRootOf(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string
/** `cmd` 回执的上限（字符），与 MCP 入口的 `RESULT_CHAR_LIMIT` 一致 */
export const MCP_RESULT_CHAR_LIMIT: number
