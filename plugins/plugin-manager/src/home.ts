import fs from 'node:fs'
import path from 'node:path'
import { toDependencies } from './inventory.js'

/** 读 home 的 `package.json`。类型收窄与跟条目树对照的纯逻辑在 `inventory.ts` */

/** pnpm 维护的清单文件，与 `cordis.yml` 在同一目录 */
const MANIFEST = 'package.json'

export function manifestFile(homeDir: string): string {
  return path.join(homeDir, MANIFEST)
}

/** 把 JSON 文件读成 unknown。**读不到或解析失败都回 undefined**，不抛——调用方按「无法识别」处理 */
async function readJson(file: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * home 里装了哪些包：包名 → 版本范围。
 *
 * **读不到就当空表**，不抛：清单由 pnpm 写入，安装过程中可能只写了一半；而
 * `list` 因为读不到清单而整体失败，比少报几行难排查得多。条目树那一侧照样报得出来。
 */
export async function readHomeDependencies(homeDir: string): Promise<Record<string, string>> {
  return toDependencies(await readJson(manifestFile(homeDir)))
}
