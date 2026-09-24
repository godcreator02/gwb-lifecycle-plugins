---
name: gwb-release
description: 升版本号、改依赖版本号、发版时读。
---

# gwb 发版规则

全生态一套。插件在隔离 home 里的验证步骤在说明书 `gwb-devkit`。

## 一、升哪一位

1. 包还在 0.0.x：这一次升到 0.1.0（0.0.x 上 `^` 只放行同一个补丁号，发版前检查拒 0.0.x）
2. 对照契约清单，判断这次改动破坏了没有：
   * **名字**改名或删掉：服务名、命令名、事件名、说明书名、窗格 id
   * **形状**变了：服务方法的参数与返回；命令参数（删参数、改类型、可选改必选）；回执（删字段、改字段的类型或含义）；事件载荷；共享包导出的名字与用法、令牌名
   * **磁盘上的数据格式**变了：data 文档、设置项的键与值的格式、布局文件里存的 id
   * 调用方依赖着的**语义**变了（比如 `ok: true` 意味着什么）
3. 定升哪一位：
   * 破坏了契约 → 升 x（0.8.3 → 0.9.0），发版时加做第四节的两步
   * 加功能、加命令、加可选参数、回执加字段、修 bug、改说明书、改内部实现 → 升 y（0.8.3 → 0.8.4）。这些都明确是补丁版本
   * 只有改动属于上面的契约清单、又判断不了算不算破坏时，才按破坏升 x
4. 改 `package.json` 的 `version` 并提交。同一个版本号永不重发

**完成判据**：新版本号已提交；`pnpm view <包>@<新版本号> version` 没有输出（源上还没有这个号）；说得出这次升 x 还是 y 对应契约清单的哪一条。

内核包另有口径：

* **包根导出的接口类型**（`GwbContext`、`GwbKernelApi`、`GwbResult`、`GwbWindowApi`、`ShellBoot`，插件 `import type` 取）：只增不减（加类型、给已有类型加可选字段）升 y；删掉、改名、改形状、改调用方依赖的语义升 x
* **接缝**：改了接缝上已有的东西（包括升级 loader、include 的版本、改 home 的布局）升 x，只加东西升 y。内核升 x 后，插件 peer 里内核包的范围不再包含新内核，所有插件都要在新内核上重新验过、把范围改成 `^<新内核的版本号>`

## 二、改依赖版本号

上游发版时下游一个数字都不动，由下游在自己发版时决定跟不跟。

1. 确定要不要跟：
   * 自己发版时，`devkit.release` 拿每个 `@godcreator` 的 dev 对照源上 `dist-tags.latest`：还在范围内（含相等）放行，一个数字都不动；已出范围（上游出了新的次版本线）必须跟
   * 要用上游的新东西：下限升到带那个东西的版本。上游是别的插件、它太旧时新东西静默失效（比如外壳新加的主题令牌取不到值）的，在 `package.json` 的 `gwb.requires` 写 `{ "<包名>": "<这个版本>" }`，`plugin-manager.list` 会报 home 里装的版本不够新（规矩见 gwb-devkit 附件 `references/rules.md` 的「要求别的插件的最低版本」）
   * 想看全生态谁落后：`devkit.audit-deps`（见参考）
2. 改写法：`@godcreator` 包写在 dev，`^<源上已经发了的版本>`（精确号也合法）；同仓的包写 `workspace:*`，`devkit.release` 发版时写成 `^<版本>`。插件包 peer 里的内核包 `@godcreator/gwb-kernel-desktop` 例外，写 `^<验证时那个内核的版本号>`（见第三节第 1 步）。依赖写进 peer、dev 还是 `dependencies`，照 gwb-devkit 附件 `references/rules.md` 的「依赖怎么写」
3. 出范围的先适配代码，再 `pnpm install`、`pnpm check`

**完成判据**：`pnpm check` 全绿；`devkit.audit-deps` 的回执里这个仓没有 `dead-pin`、`out-of-range`、`loose-dev-pin`、`peer-not-cordis`。

## 三、发正式版

1. 在隔离 home 里验证过这一版（说明书 `gwb-devkit` 的「改一版看一版」）。插件包 peer 里内核包 `@godcreator/gwb-kernel-desktop` 的范围 `^x.y.z` 要包含验证时那个内核，不包含就改成 `^<那个内核的版本号>`
2. 按第一节升版本号并提交，仓根 git 工作区干净
3. `devkit.release {"dir":"<仓根>","packages":["plugins/<短名>"]}`。`packages` 相对仓根、按依赖顺序（被依赖的在前），workspace 仓必须给，例：`["packages/model","packages/engine","plugins/gwb-bn-core"]`
4. 回执 `ok: false`：发版前检查按包列全了没过的条目，一个包都没发。逐条改完、`pnpm check`、提交，再调第 3 步
5. 升级日常用的 default：人在插件管理窗格点「全部更新」，或调 `plugin-manager.update-all`（只升几个给 `{"only":["<包名>"]}`）。新插件第一次装用 `plugin-manager.install {"pkg":"<包名>"}`。升到 gwb-mcp 自己时连接会断，重连后再核对

**完成判据**：`devkit.release` 回执 `ok: true`，`shipped` 里是这次的包与版本；default 的 `plugin-manager.list` 里这个包的版本是刚发的正式版、条目 `active` 为 true；再调一次 `index`，看得到这个包的命令与说明书。

## 四、发破坏性版本多做的两步

1. **发之前**：调 `devkit.audit-deps`，找出 dev 依赖这个包的下游（发完它们会报 `out-of-range`），往每个下游仓文档站 feedback 区的 `inbox.mdx` 投一条「要跟 X 0.9」
2. **发之后**：升 default 之前先让下游跟上，或用 `plugin-manager.update-all {"only":[…]}` 只升别的——插件之间不写 peer，一键更新不会提示下游配着出了范围的上游运行。改了名字（命令名、说明书名、术语）的，再查两遍：
   * 拿旧名字搜 MCP 入口的 instructions、各仓 AGENTS 里讲命令的段落、所有随包说明书的描述
   * 文档里点名的每个说明书名与命令名，拿 `skill.list` 与 `index` 现查一遍，指向不存在的就改

**完成判据**：每个下游仓的 `inbox.mdx` 里都有这一条；default 升级后 `plugin-manager.list` 里所有条目 `active` 为 true；旧名字在上面几处搜不到。

## 参考

### `devkit.release` 做什么

依次：仓根 git 工作区干净 → 仓根 `pnpm build` → 照 `files` 白名单检查产物在不在 → 同一个版本号已在源上就拒 → 发版前检查 → 在临时目录组装发布内容、发到 `latest`（`workspace:` 依赖写成 `^`：同一次发的写 `^新版本号`，其余写 `^<工作区里的版本号>`）。它不改仓里任何文件、只碰源不碰 home；「运行中的内核」指调它的那个 home 里的内核。

发版前检查，每个包：

| 检什么                                                                                                                                                                                                                                              | 没过                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 自己在 0.0.x                                                                                                                                                                                                                                        | 拒：先升到 0.1.0                                                                      |
| `@godcreator` 的 dev：写法认不出下限、下限比源上 latest 新、latest 已出范围、或问不出源上的 latest（`workspace:` 跳过）                                                                                                                                                           | 拒；范围内落后（含相等）放行                                                                   |
| 构建产物里有空 import（`import {} from '…'`，源码写了 `import { type X }`），或相对 import 指向的文件不在                                                                                                                                                                 | 拒                                                                                |
| 不是内核包 `@godcreator/gwb-kernel-desktop`，清单里却写了 `gwb.shared`                                                                                                                                                                                       | 拒：页面 importmap 只收内核包声明的名字，删掉 `gwb.shared`，那份代码由用它的插件各自打包                         |
| 包目录里 `pnpm exec tsc --noEmit -p <tsconfig> --skipLibCheck false`：node 侧有 `tsconfig.build.json` 用它、没有用 `tsconfig.json`，有 `src/client/tsconfig.json` 再查一次浏览器侧；测试与构建脚本不查                                                                            | 拒，写明没过的是哪一份、带输出的最后几行；node 侧两份 tsconfig 都没有也拒                                     |
| `keywords` 含 `gwb` 或 `gwb-plugin` 的包：`gwb.provides` 与源码对得上——源码（`src/` 下的 `super(ctx, '<名>')`、`ctx.provide('<名>', …)`、`new X(ctx, '<名>')`）提供的每个服务都有一条；每个键是源码提供的服务名，或本包 `exports` 里的 import 说明符（主入口写包名，子路径写 `包名/子路径`）；每条的 `summary`、`usage` 是非空字符串 | 拒，写明加哪条、删哪条或把哪一项改成什么；`devkit.audit-structure` 报同一条（`provides-declaration`，error） |

插件包（`keywords` 含 `gwb-plugin`）另查：

| 检什么                                                                                                                                   | 没过                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| peer 里有 `cordis` 与内核包 `@godcreator/gwb-kernel-desktop` 以外的包                                                                           | 拒，写明按「运行时谁提供」改写成 dev 还是 `dependencies`       |
| node 侧产物按值 import 了 `cordis`，peer 里却没有                                                                                                | 拒                                            |
| 写了 peer `cordis`，node 侧产物却没有 import 它                                                                                                 | 不拒，回执 `reminders` 里提醒                        |
| node 侧产物（`exports["."]` 入口顺着相对 import 走到的文件）的包名 import 不是 node 内置模块、`electron`、`cordis`                                               | 拒                                            |
| 浏览器侧产物（`dist/client.js` 顺着相对 import 走到的文件）的包名 import 不在页面 importmap 里——importmap 只有内核包清单 `gwb.shared` 的键，从包目录 `node_modules` 里装好的内核包读 | 拒；内核包的清单读不到也拒，提示 peer 写上内核包、再 `pnpm install` |
| peer 里没写内核包 `@godcreator/gwb-kernel-desktop`、写法不是 `^x.y.z`、或范围不包含运行中的内核（主版本号为 0 时次版本号相同，≥1 时主版本号相同，并且不低于下限；预发布段不看）                    | 拒，写明该改成的 `^<运行中的内核的 x.y.z>`                  |
| 写了 `gwb.requires` 而它不是对象、某个值不是合法的 x.y.z、某个包不在 `devDependencies` 里、或要求的版本高于 dev 范围的下限（dev 写 `workspace:` 的不比下限）；没写不查                   | 拒                                            |

### `devkit.audit-deps` 报什么

只报告、不拦，扫容器根下各仓：`dead-pin`（写的版本源上没有）、`out-of-range`（latest 已出范围，必须跟）、`behind`（范围内落后，不用处理）、`loose-dev-pin`（写法既不是精确号也不是 `^`）、`peer-not-cordis`（插件包的 peer 里有 `cordis` 与内核包以外的包，下次发版会被拒）。

### 手工发版

要运行仓里 `prepublishOnly` 钩子时才手工发：在包目录 `pnpm publish --no-git-checks`，源由用户级 `~/.npmrc` 的 scope 行决定，命令行不写 `--registry`。手工发版不做发版前检查；`prepublishOnly: pnpm build` 要留着，少了它会把上一版的 `dist/` 原样发出去而且不报错。

### 机器上的两处配置

都不在任何仓里，换机器或重装会丢：

* **用户级 `~/.npmrc`**：`@godcreator` 的 scope 行与发布 token。仓里不配 `.npmrc`、不写 `publishConfig`
* **用户级 pnpm 配置**（`pnpm config get globalconfig` 报位置）：`minimumReleaseAgeExclude` 放行 `'@godcreator/*'`。pnpm 11 起刚发的包要放一天才准装，丢了它的症状是新机器上装不上刚发的包

仓与 home 的 `pnpm-workspace.yaml` 只写各自需要的项，`minimumReleaseAgeExclude` 与 `strictPeerDependencies` 都留给用户级配置与 pnpm 默认值：`pnpm-workspace.yaml` 里写了哪一项，就逐项覆盖用户级的同名项。
