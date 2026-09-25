// 零 I/O 纯逻辑：这个文件里不 import node:fs

/**
 * 条目 id：kebab-case。字符集与 gwb-data、gwb-settings 的校验一致，三处一起改。
 * 没有点号与冒号，所以不会路径穿越，也不会被拆成多段 id
 */
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** loader 用它把父条目 id 跟自己的拼成完整 entryId（cordis 的 `EntryTree.sep`） */
const ID_SEP = ':'

/** npm 的包名规则，严两处：只接受小写；首字符不许是 `-`（会被当成命令行选项） */
const PKG_PATTERN = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/

const SCOPE_PREFIX = /^@[^/]+\//

/** 本生态的插件包名前缀，生成 id 时去掉 */
const GWB_PREFIX = /^gwb-/

/** 处理后一个字符都不剩时（包名完全不是 ASCII）用的 id；重名由后面的去重处理 */
const FALLBACK_ID = 'plugin'

/** 自动生成的 id 都满足它：测试拿它核对 `defaultIdFor` 与 `uniqueId` 的产物 */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** 完整 entryId → 末段。loader 的 resolve / remove / update 只认末段，传完整 id 会报「cannot resolve entry」 */
export function bareId(entryId: string): string {
  const lastSegment = entryId.split(ID_SEP).pop() ?? ''
  if (lastSegment === '') throw new Error(`认不出条目 ${JSON.stringify(entryId)}：末段是空的。`)
  return lastSegment
}

/** `@godcreator/gwb-py-cli` → `py-cli` */
export function defaultIdFor(pkg: string): string {
  const nameWithoutPrefixes = pkg.replace(SCOPE_PREFIX, '').replace(GWB_PREFIX, '')
  const kebab = nameWithoutPrefixes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return kebab === '' ? FALLBACK_ID : kebab
}

/** 重名时加数字后缀：`py-cli` → `py-cli-2`。`taken` 要是整棵树的 id：loader 的 store 是一张不分层的表 */
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
 * 新条目的 id：默认 id，条目树上重名就加数字后缀。不读数据插件与设置插件的归属记录：卸载后另一个同名包拿到同一个 id、
 * 读到前一个包留下的数据时，由那两个插件自己的归属检查报错
 */
export function pickId(pkg: string, taken: ReadonlySet<string>): string {
  return uniqueId(defaultIdFor(pkg), taken)
}

/** 合不合包名规则（规则同 `assertPkgName`），不抛 */
export function isPkgName(value: string): boolean {
  return PKG_PATTERN.test(value)
}

/** 不是安全边界（参数全程以数组传递、不经 shell）：拦的是把 `-r` 这类 pnpm 选项当包名传进去 */
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
