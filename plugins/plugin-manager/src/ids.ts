/**
 * 条目 id、包名、版本范围的规矩——零 I/O 纯逻辑（出现 `node:fs` import 即越界）。
 *
 * **id 是身份，定死不给改**：`gwb-settings` 与 `gwb-data` 都按它的末段分区，改一次 id
 * 等于把那条条目的设置和数据全丢在原地。所以没有 rename，要改显示名走 `setLabel`。
 *
 * **字符集跟那两个件里的那两份一模一样**——发出去的 id 过不了它们的校验，就等于发了
 * 一条谁也存不下东西的条目。三处都是十几行纯逻辑，为它新建一个共享包过不了准入判据；
 * 改这儿就得同时看那两处。
 */

/** 条目 id：kebab-case。字符集里没有点号与冒号，路径穿越与 id 分段都进不来 */
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** loader 用它把父条目 id 跟自己的拼成完整 entryId（cordis 的 `EntryTree.sep`） */
const ID_SEP = ':'

/**
 * npm 的包名规矩，收得比 npm 严两处：**只认小写**（大写包名在 registry 上本来也是历史
 * 遗留），**首字符不许是 `-`**（那种名字 npm 上不存在，而它正好长得像一个开关）。
 */
const PKG_PATTERN = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/

/** 包名去掉 scope */
const SCOPE_PREFIX = /^@[^/]+\//

/** 本生态的件都带这个前缀（跟废弃那批错开），它不进 id */
const GWB_PREFIX = /^gwb-/

/** 一个字符都剩不下时用的兜底 id。真撞上说明包名整个不是 ASCII，后面还有撞名那一层兜着 */
const FALLBACK_ID = 'plugin'

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** id 不合规当场抛——别让坏 id 落进 cordis.yml，它一落盘就是那条条目的身份 */
export function assertId(value: string): void {
  if (!isValidId(value)) {
    throw new Error(
      `条目 id ${JSON.stringify(value)} 不合规。一律 kebab-case（小写字母、数字、单连字符分段），比如 commands、py-cli。`,
    )
  }
}

/**
 * 完整 entryId → 裸 id。
 *
 * **这一步不能省。** 件从 ctx 上读到的是完整的 `home:commands`，而 loader 的
 * `tree.resolve` / `remove` / `update` 在**承载 cordis.yml 的那棵树**上认的是裸 id：
 * `resolve` 内部 `split(':')` 逐段往子树钻，喂完整 id 给它会当场「cannot resolve entry」。
 * `home` 那段是内核那条 include 条目的 id，跟件本身没关系。
 */
export function bareId(entryId: string): string {
  const last = entryId.split(ID_SEP).pop() ?? ''
  if (last === '') throw new Error(`认不出条目 ${JSON.stringify(entryId)}：末段是空的。`)
  return last
}

/**
 * 包名 → 默认 id：去掉 scope 与 `gwb-` 前缀，剩下的收进 kebab-case。
 * `@godcreator/gwb-py-cli` → `py-cli`。撞名归 `pickId` 管。
 */
export function defaultIdFor(pkg: string): string {
  const bare = pkg.replace(SCOPE_PREFIX, '').replace(GWB_PREFIX, '')
  const kebab = bare
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return kebab === '' ? FALLBACK_ID : kebab
}

/**
 * 撞了就加数字后缀：`py-cli` → `py-cli-2`。
 *
 * **`taken` 要是整棵树的 id**，不是某个包底下的——id 在 cordis.yml 里全局唯一，
 * loader 的 store 就是一张平表。
 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  // taken 有 n 条，`base-2 … base-(n+2)` 有 n+1 个候选，必有一个是空的
  for (let n = 2; n <= taken.size + 2; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`给 ${JSON.stringify(base)} 编不出一个没被占的 id。`)
}

/**
 * 盘上的户主：id → 认领过它的包。数据目录与设置分区各盖一个章，所以可能不止一个。
 *
 * 默认 id 去掉了 scope，`@a/gwb-foo` 与 `@b/foo` 都叫 `foo`；而条目删了数据与设置都留盘。
 * 只看树判重的话，空出来的 `foo` 会被下一个同名的包拿走、读到前一个包的东西。
 */
export type IdOwners = Readonly<Record<string, readonly string[]>>

/** 盘上有别的包的章 */
function ownedByOther(owners: IdOwners, id: string, pkg: string): string | undefined {
  return owners[id]?.find((owner) => owner !== pkg)
}

/** 盘上有章、而且全是这个包的 */
function ownedBy(owners: IdOwners, id: string, pkg: string): boolean {
  const list = owners[id]
  return list !== undefined && list.length > 0 && list.every((owner) => owner === pkg)
}

/**
 * 给 `pkg` 挑一个 id。
 *
 * 1. **先接回自己的**：盘上有本包的章、树上又空着的 id，说明这个包装过又卸了——用回它，
 *    数据与设置原样接上。有好几个时优先默认那个，其余按字典序
 * 2. 否则默认 id 往下数后缀，**树上有的和盘上归别的包的都跳过**
 */
export function pickId(pkg: string, taken: ReadonlySet<string>, owners: IdOwners): string {
  const base = defaultIdFor(pkg)
  const reclaim = Object.keys(owners)
    .filter((id) => !taken.has(id) && ownedBy(owners, id, pkg))
    .sort()
  if (reclaim.includes(base)) return base
  if (reclaim.length > 0) return reclaim[0]!
  const blocked = new Set(taken)
  for (const id of Object.keys(owners)) {
    if (ownedByOther(owners, id, pkg) !== undefined) blocked.add(id)
  }
  return uniqueId(base, blocked)
}

/** 手给的 id 能不能给 `pkg` 用：树上被占、盘上归别的包，都当场抛 */
export function assertIdUsable(id: string, pkg: string, taken: ReadonlySet<string>, owners: IdOwners): void {
  assertId(id)
  if (taken.has(id)) throw new Error(`条目 id ${JSON.stringify(id)} 已经被占了。换一个，或者不给由这边编一个。`)
  const other = ownedByOther(owners, id, pkg)
  if (other !== undefined) {
    throw new Error(
      `条目 id ${JSON.stringify(id)} 的数据或设置归 ${other}，给 ${pkg} 用会读到别人的东西。换一个 id；确认是同一个件改了包名，先走 plugin-manager.transfer-owner 过户。`,
    )
  }
}

/**
 * 包名不合规当场抛。**不是安全边界**——参数全程走数组、一次都不过 shell，本来就不用
 * 转义。它拦的是「`-r` 这种被 pnpm 读成开关的东西被当包名传进去」。
 */
export function assertPkgName(value: string): void {
  if (!PKG_PATTERN.test(value)) {
    throw new Error(
      `包名 ${JSON.stringify(value)} 不合规。要么 \`name\`，要么 \`@scope/name\`，小写字母、数字与 - . _ ~。`,
    )
  }
}

/** 版本范围松着收：`^1.2.3`、`0.0.3`、`latest`、`workspace:*` 都得让过，只挡开关与空白 */
export function assertSpec(value: string): void {
  if (value === '' || /\s/.test(value) || value.startsWith('-')) {
    throw new Error(`版本范围 ${JSON.stringify(value)} 不合规：不能是空的、带空白、或者以 - 开头（那会被读成开关）。`)
  }
}

/** `pnpm add` 的那个参数：不给版本就是 `名`，给了就是 `名@范围` */
export function installSpec(pkg: string, spec?: string): string {
  assertPkgName(pkg)
  if (spec === undefined) return pkg
  assertSpec(spec)
  return `${pkg}@${spec}`
}
