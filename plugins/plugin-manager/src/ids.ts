/**
 * 条目 id、包名、版本范围的校验规则——零 I/O 纯逻辑（出现 `node:fs` import 就违反了这条约定）。
 *
 * **id 是条目的身份，一经确定不允许修改**：`gwb-settings` 与 `gwb-data` 都按 id 的末段分区，改一次 id
 * 就等于那条条目原有的设置和数据都留在旧分区里、再也读不到。所以不提供 rename，改显示名用 `setLabel`。
 *
 * **字符集与那两个插件里的校验完全一致**——生成的 id 通不过它们的校验，这条条目就
 * 存不下任何设置和数据。三处都是十几行纯逻辑，不值得为它新建一个包；
 * 改这里必须同时改那两处。
 */

/** 条目 id：kebab-case。字符集里没有点号与冒号，所以不会出现路径穿越，也不会被拆成多段 id */
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** loader 用它把父条目 id 跟自己的拼成完整 entryId（cordis 的 `EntryTree.sep`） */
const ID_SEP = ':'

/**
 * npm 的包名规则，比 npm 严格两处：**只接受小写**（大写包名在 registry 上本来也是历史
 * 遗留），**首字符不许是 `-`**（那种名字 npm 上不存在，而且会被当成命令行选项）。
 */
const PKG_PATTERN = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/

/** 包名去掉 scope */
const SCOPE_PREFIX = /^@[^/]+\//

/** 本生态的插件包名都带这个前缀（与已废弃的那批包区分开），生成 id 时去掉 */
const GWB_PREFIX = /^gwb-/

/** 处理后一个字符都不剩时使用的默认 id。出现这种情况说明包名完全不是 ASCII；重名由后面的去重处理 */
const FALLBACK_ID = 'plugin'

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** id 不合规立即抛错——不合规的 id 一旦写入 cordis.yml 就成了那条条目的身份 */
export function assertId(value: string): void {
  if (!isValidId(value)) {
    throw new Error(
      `条目 id ${JSON.stringify(value)} 不合规。一律 kebab-case（小写字母、数字、单连字符分段），比如 commands、py-cli。`,
    )
  }
}

/**
 * 完整 entryId → 不带前缀的 id（末段）。
 *
 * **这一步不能省。** 插件从 ctx 上读到的是完整的 `home:commands`，而 loader 的
 * `tree.resolve` / `remove` / `update` 在**承载 cordis.yml 的那棵树**上只认不带前缀的 id：
 * `resolve` 内部 `split(':')` 逐段往子树查找，传入完整 id 会直接报「cannot resolve entry」。
 * `home` 那段是内核那条 include 条目的 id，与插件本身无关。
 */
export function bareId(entryId: string): string {
  const last = entryId.split(ID_SEP).pop() ?? ''
  if (last === '') throw new Error(`认不出条目 ${JSON.stringify(entryId)}：末段是空的。`)
  return last
}

/**
 * 包名 → 默认 id：去掉 scope 与 `gwb-` 前缀，剩下的收进 kebab-case。
 * `@godcreator/gwb-py-cli` → `py-cli`。重名由 `pickId` 处理。
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
 * 重名时加数字后缀：`py-cli` → `py-cli-2`。
 *
 * **`taken` 要是整棵树的 id**，不是某个包底下的——id 在 cordis.yml 里全局唯一，
 * loader 的 store 是一张不分层的表。
 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  // taken 有 n 条，`base-2 … base-(n+2)` 有 n+1 个候选，必有一个是空的
  for (let n = 2; n <= taken.size + 2; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`以 ${JSON.stringify(base)} 为基础生成不出一个没被占用的 id。`)
}

/**
 * 磁盘上的归属记录：id → 用过它的包。数据目录与设置分区各自记录一次归属，所以可能不止一个。
 *
 * 默认 id 去掉了 scope，`@a/gwb-foo` 与 `@b/foo` 都叫 `foo`；而条目删除后数据与设置都留在磁盘上。
 * 只按条目树判断重名的话，空出来的 `foo` 会被下一个同名的包拿走、读到前一个包的数据。
 */
export type IdOwners = Readonly<Record<string, readonly string[]>>

/** 磁盘上有别的包的归属记录 */
function ownedByOther(owners: IdOwners, id: string, pkg: string): string | undefined {
  return owners[id]?.find((owner) => owner !== pkg)
}

/** 磁盘上有归属记录，而且全属于这个包 */
function ownedBy(owners: IdOwners, id: string, pkg: string): boolean {
  const list = owners[id]
  return list !== undefined && list.length > 0 && list.every((owner) => owner === pkg)
}

/**
 * 给 `pkg` 挑一个 id。
 *
 * 1. **先收回自己用过的**：磁盘上归属于本包、条目树上又空着的 id，说明这个包装过又卸了——沿用它，
 *    数据与设置原样接上。有多个时优先默认 id，其余按字典序
 * 2. 否则从默认 id 开始加后缀，**条目树上已有的和磁盘上归属于别的包的都跳过**
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

/** 手动指定的 id 能否给 `pkg` 用：条目树上已被占用、磁盘上归属于别的包，都立即抛错 */
export function assertIdUsable(id: string, pkg: string, taken: ReadonlySet<string>, owners: IdOwners): void {
  assertId(id)
  if (taken.has(id)) throw new Error(`条目 id ${JSON.stringify(id)} 已经被占用了。换一个，或者不给 id 由插件管理自动生成一个。`)
  const other = ownedByOther(owners, id, pkg)
  if (other !== undefined) {
    throw new Error(
      `条目 id ${JSON.stringify(id)} 的数据或设置归 ${other}，给 ${pkg} 用会读到别人的东西。换一个 id；确认是同一个插件改了包名，先调用 plugin-manager.transfer-owner 把归属转过去。`,
    )
  }
}

/**
 * 包名不合规立即抛错。**这不是安全边界**——参数全程以数组传递、从不经过 shell，本来就不需要
 * 转义。它拦截的是把 `-r` 这类会被 pnpm 当成命令行选项的东西当包名传进去。
 */
export function assertPkgName(value: string): void {
  if (!PKG_PATTERN.test(value)) {
    throw new Error(
      `包名 ${JSON.stringify(value)} 不合规。要么 \`name\`，要么 \`@scope/name\`，小写字母、数字与 - . _ ~。`,
    )
  }
}

/** 版本范围宽松校验：`^1.2.3`、`0.0.3`、`latest`、`workspace:*` 都要放行，只拦截命令行选项与空白 */
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
