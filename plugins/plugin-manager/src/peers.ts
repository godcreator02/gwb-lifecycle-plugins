import { isRecord } from './vocab.js'
import { toShared } from './inventory.js'

/**
 * 装一个件时，它声明的 peer 里哪些该一并装成 **home 的直接依赖**——零 I/O 纯逻辑
 * （出现 `node:fs` import 即越界）。读清单那一半在 `home.ts`，真去跑 pnpm 的在 `index.ts`。
 *
 * **为什么非装不可。** 件如果依赖一个**会独立升级**的 npm 包，而且只是读它的文件、起它的
 * 进程（不 import 它的代码），那个包就该是件的 peer：件每次现查 `<home>/node_modules/<包名>`
 * 拿到的是一条**会被 pnpm 改指的 junction**，指向永远是当前版本，升级不用重启也不用重挂。
 * 反过来，`import.meta.resolve` 拿到的是一次性解开的、带版本号的真实路径，解开那一刻就
 * 定死了——而 pnpm 不删旧版本目录，于是升级之后读到的仍是旧文件，全程零报错。
 *
 * **但 pnpm 自动补的 peer 顶不上这个用**（内核仓 `probes/2609101500_peer-dep-live-swap` 实测）：
 * 自动补的只塞进 `.pnpm/`、只软链进件自己的私有 `node_modules/`，`<home>/node_modules/<包名>`
 * 这条路径**根本不存在**；于是 `pnpm outdated`（只看 `package.json`）永远看不见它，
 * `plugin-manager.update-all` 也就永远升不到它。`auto-install-peers` 那个开关帮不上忙——默认本来
 * 就是开的，开着也只塞进 `.pnpm/`，而且它在 pnpm 11 上写 `.npmrc` 完全不认。
 * **只有写进 home 的 `package.json` 才有那条 junction**，所以这一步只能由这个件来做。
 */

/**
 * 宿主提供的那几个包，**不许当普通包装进 home**。
 *
 * `cordis` 是唯一一条：件 `extends Service` 的那个基类必须是宿主手上那一份，home 里再装
 * 一份就是第二张服务注册表，件的身份对不上。它由 pnpm 自动补进件的私有 `node_modules/`
 * ——那正是自动补 peer 唯一够用的场合（宿主与件解析到同一份，不需要现查路径）。
 */
const HOST_PACKAGES: ReadonlySet<string> = new Set(['cordis'])

/** 本生态自己的命名空间：件、契约包、共享包都在这里面，三者要分开对待 */
const GWB_NAMESPACE = /^@godcreator\/gwb-/

/**
 * 一个 peer 是哪一种。**只对 `@godcreator/gwb-*` 里的包问这个问题**，判据是清单里有没有
 * `gwb.shared`——那是本生态既有的标记（内核扫它拼页面 importmap，`plugin-manager.shared` 读同一批）：
 *
 * - `shared`：共享包（`gwb-shared-react` / `gwb-tokens`）。**本来就该是 home 的直接依赖**
 *   ——内核只扫 home 的 dependencies 拼 importmap，它不在那张清单里等于没有。跟这次要装的
 *   peer 是同一个形状，所以装
 * - `plugin`：件。件有自己的进 home 之路（`plugin-manager.install`，装完还要落一条 `cordis.yml`
 *   条目），从 peer 这条路顺手塞进来只会在「已装、没挂条目」区里堆一排没人挂的包
 */
export type PeerKind = 'shared' | 'plugin'

/** 一个包的清单 → 它是共享包还是件。清单读不出来（undefined）时回 undefined，判定交给计划 */
export function peerKindOf(manifest: unknown): PeerKind | undefined {
  if (manifest === undefined) return undefined
  return toShared(manifest) === undefined ? 'plugin' : 'shared'
}

/** 计划里一条 peer 的去向。真去跑 pnpm 之前就定死了 */
export interface PeerPlanItem {
  pkg: string
  /** 件的清单里给它写的版本范围，原样带进回执 */
  range: string
  /** `install` 要装；`present` 已经在 home 的 `package.json` 里；`skipped` 不该由这条路装 */
  decision: 'install' | 'present' | 'skipped'
  /** present 是 home 里那条 spec，skipped 是跳过的理由。install 没有这一格 */
  note?: string
}

/**
 * 一个包的清单里 `peerDependencies` 那格收窄成 包名 → 版本范围。坏了当没有，不整份不认。
 *
 * **`peerDependenciesMeta.optional` 不参与判断**：它说的是「pnpm 不要为它缺席报警」，不是
 * 「别装」。真正决定该不该进 home 的是那个包是不是本生态自己提供的——一条轴，不是两条。
 */
export function toPeerDependencies(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const peers = raw['peerDependencies']
  if (!isRecord(peers)) return {}
  const out: Record<string, string> = {}
  for (const [pkg, range] of Object.entries(peers)) {
    if (typeof range === 'string') out[pkg] = range
  }
  return out
}

/**
 * 出计划：每条 peer 装、还是不装、还是本来就在。按包名排，回执与执行顺序都跟着它。
 *
 * `kinds` 是 `@godcreator/gwb-*` 那些 peer 各自的种类（由调用方读盘算出来，见
 * `peerKindOf`）；**认不出种类的保守当件跳过**——多装一个包只是占磁盘，可把一个件当普通
 * 包塞进 home 会在界面上凭空多出一行「装了没挂条目」，人得回头查它是哪来的。
 *
 * 判据一共四条，按顺序：
 *
 * 1. **已经在 home 的 `package.json` 里 → `present`，一个字不动。** 不降级、不改写别人钉好
 *    的版本：那条依赖是谁装的、为什么钉在那个版本，这儿一概不知道
 * 2. **宿主提供的（`cordis`）→ `skipped`**
 * 3. **`@godcreator/gwb-*`：共享包装、件跳过**（判据见 `PeerKind`）
 * 4. **其余一律装**——那正是这次要接的形状：会独立升级、被件现查路径读文件/起进程的包
 */
export function planPeers(
  peers: Readonly<Record<string, string>>,
  homeDeps: Readonly<Record<string, string>>,
  kinds: Readonly<Record<string, PeerKind | undefined>>,
): PeerPlanItem[] {
  const out: PeerPlanItem[] = []
  for (const pkg of Object.keys(peers).sort((a, b) => a.localeCompare(b))) {
    const range = peers[pkg] ?? ''
    const spec = homeDeps[pkg]
    if (spec !== undefined) {
      out.push({ pkg, range, decision: 'present', note: `home 里已经有它（${spec}），版本没动` })
      continue
    }
    if (HOST_PACKAGES.has(pkg)) {
      out.push({ pkg, range, decision: 'skipped', note: '宿主提供的那一份，home 里再装一份就是第二张服务注册表' })
      continue
    }
    if (GWB_NAMESPACE.test(pkg)) {
      const kind = kinds[pkg]
      if (kind === 'shared') {
        out.push({ pkg, range, decision: 'install' })
      } else if (kind === 'plugin') {
        out.push({ pkg, range, decision: 'skipped', note: '本生态的件，要装走 plugin-manager.install（那条还会落一条 cordis.yml 条目）' })
      } else {
        out.push({
          pkg,
          range,
          decision: 'skipped',
          note: '盘上找不到它的清单（多半是条 optional 的 peer，pnpm 不为这种自动补），认不出是件还是共享包，按件跳过——真要它自己在 home 里 pnpm add',
        })
      }
      continue
    }
    out.push({ pkg, range, decision: 'install' })
  }
  return out
}
