import fs from 'node:fs'
import path from 'node:path'
import { toDependencies, toShared } from './inventory.js'

/** home 那份 `package.json`。收窄与对账的纯逻辑在 `inventory.ts` */

/** pnpm 维护的那份清单，跟 `cordis.yml` 并排 */
const MANIFEST = 'package.json'

export function manifestFile(homeDir: string): string {
  return path.join(homeDir, MANIFEST)
}

/** home 的 `node_modules` 里某个包的清单在哪。包名带 scope 的按 `/` 拆成两段目录 */
function installedManifestFile(homeDir: string, ...pkgs: readonly string[]): string {
  const segments = pkgs.flatMap((pkg) => ['node_modules', ...pkg.split('/')])
  return path.join(homeDir, ...segments, MANIFEST)
}

/** 一份 JSON 读成 unknown。**读不到、坏了都回 undefined**，不抛——调用方按「认不出」处置 */
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

/** home 里装着的某个包，它自己那份清单。读不到回 undefined */
export async function readInstalledManifest(homeDir: string, pkg: string): Promise<unknown> {
  return readJson(installedManifestFile(homeDir, pkg))
}

/**
 * `owner` 这个包的某条 peer，它自己那份清单。**读不到回 undefined。**
 *
 * **要先解软链。** pnpm 自动补的 peer 不进 home 顶层，而是跟 owner 并排躺在虚拟仓里：
 * `<home>/node_modules/<owner>` 是一条指向
 * `<home>/node_modules/.pnpm/<owner>@<hash>/node_modules/<owner>` 的 junction，那一层
 * `node_modules/` 才是 owner 的解析面，peer 就在里面（本机实测：`gwb-docfirst-workflow` 的
 * `gwb-plugin-api` / `docfirst-workflow` 都在那儿，而 `<home>/node_modules/<owner>/node_modules/`
 * 里只有 `.bin`）。所以取法是：解出 owner 的真实目录，按包名有几段就往上退几层，
 * 退到的就是那张解析面。
 *
 * 退到顶层再找一次是兜底——peer 已经是 home 的直接依赖时它就在顶层，虚拟仓里未必另有一份。
 * 两处都没有的常见原因是它是条 `optional` 的 peer：pnpm 不为这种自动补。
 */
export async function readPeerManifest(homeDir: string, owner: string, peer: string): Promise<unknown> {
  const segments = owner.split('/')
  const link = path.join(homeDir, 'node_modules', ...segments)
  let sibling: unknown
  try {
    // realpath 只解 owner 这一条链，解不开（包没装、不是软链）就走兜底
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
 * home 里装着哪些包：包名 → 版本范围。
 *
 * **读不到就当空表**，不抛：清单是 pnpm 写的，正在装的那一瞬间它可能是半份；而
 * `list()` 因为读不到清单整个失败，比少报几行难查得多。条目那一侧照样报得出来。
 */
export async function readHomeDependencies(homeDir: string): Promise<Record<string, string>> {
  return toDependencies(await readJson(manifestFile(homeDir)))
}

/**
 * home 里哪些包是**共享包**，各自提供哪些裸名。
 *
 * 这份数据以前从内核的 `kernel.info` 拿；单进程内核没有那条自省命令了，改成这个件自己
 * 去盘上读——扫的是内核算 importmap 时扫的同一批清单（home 的 dependencies，逐包读
 * `gwb.shared`），所以两边看到的是同一件事。读不动的包**跳过不报错**：正在装的那一瞬间
 * 清单可能是半份，而少标一个「共享包」的代价远小于整格画不出来。
 */
export async function readSharedPackages(homeDir: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const pkg of Object.keys(await readHomeDependencies(homeDir))) {
    const bares = toShared(await readInstalledManifest(homeDir, pkg))
    if (bares !== undefined) out[pkg] = bares
  }
  return out
}
