import fs from 'node:fs'
import path from 'node:path'
import { toDependencies } from './inventory.js'

const MANIFEST = 'package.json'

export function manifestFile(homeDir: string): string {
  return path.join(homeDir, MANIFEST)
}

/** 读不了、不是合法 JSON 都抛错，带上路径 */
async function readJson(file: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    throw new Error(`读不了 ${file}：${String(err)}`, { cause: err })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new Error(`${file} 不是合法的 JSON：${String(err)}`, { cause: err })
  }
}

/** 包名 → 版本范围。清单读不了、不是 JSON、形状不对都抛错，报错带路径 */
export async function readHomeDependencies(homeDir: string): Promise<Record<string, string>> {
  const file = manifestFile(homeDir)
  return toDependencies(await readJson(file), file)
}

export function installedPackageManifestFile(homeDir: string, pkg: string): string {
  return path.join(homeDir, 'node_modules', ...pkg.split('/'), MANIFEST)
}

/** 文件不在回 undefined（条目指向没装的包、或 pnpm 装到一半）；在但读不了或不是 JSON 就抛错，带上路径 */
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

/**
 * `node_modules/<包名>` 这个目录链接指向的真实目录（pnpm 虚拟存储里的那一个，目录名带着包与它 peer 的版本）；
 * 包不在回 undefined，在但读不了就抛错，带上路径
 */
export async function installedPackageRealpath(homeDir: string, pkg: string): Promise<string | undefined> {
  const link = path.join(homeDir, 'node_modules', ...pkg.split('/'))
  try {
    return await fs.promises.realpath(link)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`读不出 ${link} 的真实目录：${String(err)}`, { cause: err })
  }
}

const NPMRC = '.npmrc'

/** 机器级 npmrc 在用户目录下，home 级的在 home 目录下 */
export function npmrcFiles(userDir: string, homeDir: string): { user: string; home: string } {
  return { user: path.join(userDir, NPMRC), home: path.join(homeDir, NPMRC) }
}

/** 文件不在就是空文本（没加过包源时多半不存在）；在但读不了就抛错，带上路径 */
export async function readNpmrc(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new Error(`读不了 ${file}：${String(err)}`, { cause: err })
  }
}

/** 先写同目录的临时文件再改名，写到一半断电也不会留下半份 npmrc */
export async function writeNpmrc(file: string, text: string): Promise<void> {
  const tempFile = `${file}.gwb-tmp-${String(process.pid)}-${String(Date.now())}`
  await fs.promises.writeFile(tempFile, text, 'utf8')
  await fs.promises.rename(tempFile, file)
}
