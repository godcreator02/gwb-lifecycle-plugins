import fs from 'node:fs'
import path from 'node:path'
import { toDependencies, toShared } from './inventory.js'

/** 读 home 的 `package.json` 与已装包的清单。类型收窄与跟条目树对照的纯逻辑在 `inventory.ts` */

/** pnpm 维护的清单文件，与 `cordis.yml` 在同一目录 */
const MANIFEST = 'package.json'

export function manifestFile(homeDir: string): string {
  return path.join(homeDir, MANIFEST)
}

/** home 的 `node_modules` 里某个包的清单路径。带 scope 的包名按 `/` 拆成两级目录 */
function installedManifestFile(homeDir: string, ...pkgs: readonly string[]): string {
  const segments = pkgs.flatMap((pkg) => ['node_modules', ...pkg.split('/')])
  return path.join(homeDir, ...segments, MANIFEST)
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

/** home 里装着的某个包自己的清单。读不到回 undefined */
export async function readInstalledManifest(homeDir: string, pkg: string): Promise<unknown> {
  return readJson(installedManifestFile(homeDir, pkg))
}

/**
 * `owner` 这个包的某个 peer 的清单。**读不到回 undefined。**
 *
 * **要先解析软链接。** pnpm 自动补装的 peer 不在 home 顶层，而是和 owner 一起放在虚拟存储目录（`.pnpm/`）里：
 * `<home>/node_modules/<owner>` 是一条指向
 * `<home>/node_modules/.pnpm/<owner>@<hash>/node_modules/<owner>` 的 junction，那一层
 * `node_modules/` 才是 owner 解析依赖的目录，peer 就在里面（本机实测：`gwb-docfirst-workflow` 的
 * `gwb-plugin-api` / `docfirst-workflow` 都在那儿，而 `<home>/node_modules/<owner>/node_modules/`
 * 里只有 `.bin`）。所以做法是：解析出 owner 的真实目录，包名有几段就往上退几层，
 * 退到的就是那个目录。
 *
 * 再到顶层找一次是回退查找——peer 已经是 home 的直接依赖时它就在顶层，虚拟存储目录里未必另有一份。
 * 两处都没有的常见原因是它是 `optional` 的 peer：pnpm 不为这种 peer 自动补装。
 */
export async function readPeerManifest(homeDir: string, owner: string, peer: string): Promise<unknown> {
  const segments = owner.split('/')
  const link = path.join(homeDir, 'node_modules', ...segments)
  let sibling: unknown
  try {
    // realpath 只解析 owner 这一条链接，解析失败（包没装、不是软链接）就走回退查找
    const real = await fs.promises.realpath(link)
    const face = path.resolve(real, ...segments.map(() => '..'))
    sibling = await readJson(path.join(face, ...peer.split('/'), MANIFEST))
  } catch {
    sibling = undefined
  }
  if (sibling !== undefined) return sibling
  const nested = await readJson(installedManifestFile(homeDir, owner, peer))
  return nested === undefined ? readJson(installedManifestFile(homeDir, peer)) : nested
}

/**
 * home 里装了哪些包：包名 → 版本范围。
 *
 * **读不到就当空表**，不抛：清单由 pnpm 写入，安装过程中可能只写了一半；而
 * `list()` 因为读不到清单而整体失败，比少报几行难排查得多。条目树那一侧照样报得出来。
 */
export async function readHomeDependencies(homeDir: string): Promise<Record<string, string>> {
  return toDependencies(await readJson(manifestFile(homeDir)))
}

/**
 * home 里哪些包是**共享包**，各自提供哪些包名 import（bare specifier）。
 *
 * 由本插件自己从磁盘读：扫的是内核生成 importmap 时扫的同一批清单（home 的 dependencies，逐包读
 * `gwb.shared`），所以两边看到的是同一份数据。读不了的包**跳过不报错**：安装过程中
 * 清单可能只写了一半，而少标一个「共享包」的代价远小于整个窗格画不出来。
 */
export async function readSharedPackages(homeDir: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const pkg of Object.keys(await readHomeDependencies(homeDir))) {
    const bares = toShared(await readInstalledManifest(homeDir, pkg))
    if (bares !== undefined) out[pkg] = bares
  }
  return out
}
