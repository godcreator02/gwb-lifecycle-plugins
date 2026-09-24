import fs from 'node:fs'
import path from 'node:path'
import { toDependencies } from './inventory.js'

/**
 * 读写磁盘：home 的 `package.json`、装在 home 里的包自己的 `package.json`、两份 npmrc。
 * 清单的类型收窄与跟条目树对照的纯逻辑在 `inventory.ts`，npmrc 文本的解析与改写在 `sources.ts`
 */

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

export function installedPackageManifestFile(homeDir: string, pkg: string): string {
  return path.join(homeDir, 'node_modules', ...pkg.split('/'), MANIFEST)
}

/**
 * 装在 home 里的一个包自己的 `package.json`，原样返回解析结果。
 *
 * 文件不存在时是 undefined：条目可以引用没装的包，pnpm 装到一半时目录也可能还没建好，这两种都按
 * 「包没声明任何东西」报。文件在但读不了、或不是合法 JSON，直接抛错并带上文件路径。
 */
export async function readInstalledPackageManifest(homeDir: string, pkg: string): Promise<unknown> {
  const file = installedPackageManifestFile(homeDir, pkg)
  let text: string
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`读不了 ${file}：${String(err)}`, { cause: err })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new Error(`${file} 不是合法的 JSON：${String(err)}`, { cause: err })
  }
}

const NPMRC = '.npmrc'

/** 机器级 npmrc 在用户目录下，home 级的在 home 目录下 */
export function npmrcFiles(userDir: string, homeDir: string): { user: string; home: string } {
  return { user: path.join(userDir, NPMRC), home: path.join(homeDir, NPMRC) }
}

/** 读一份 npmrc。文件不在就是空文本——没加过包源时它多半不存在；在但读不了直接抛错并带上路径 */
export async function readNpmrc(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new Error(`读不了 ${file}：${String(err)}`, { cause: err })
  }
}

/** 原子写：先写同目录的临时文件再改名，写到一半断电也不会留下半份 npmrc */
export async function writeNpmrc(file: string, text: string): Promise<void> {
  const temp = `${file}.gwb-tmp-${String(process.pid)}-${String(Date.now())}`
  await fs.promises.writeFile(temp, text, 'utf8')
  await fs.promises.rename(temp, file)
}
