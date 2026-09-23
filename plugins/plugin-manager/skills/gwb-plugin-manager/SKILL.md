---
name: gwb-plugin-manager
description: 要装插件、更新插件、启用停用、重新加载一条条目、或查这个 home 装了什么时读。讲清包与条目两层、装了包不等于加载了、**装的是库就不加条目**（清单 keywords 只写 gwb、没写 gwb-plugin 的那种）、remove-entry 不删包、插件因「数据目录或设置分区属于别的包」加载失败时怎么办（transfer-owner 还是换 id）、update 与 install 的区别、装插件时哪些 peer 装、哪些跳过、peer 版本对不上时回执怎么读（照装不拦，peerWarnings 点名谁要什么范围）、发完新版本怎么一键热升（update-all，不重启）、以及装完之后要重新调 MCP 入口的 index 拿到新命令。查 registry 上有什么可装、配第三方包源不在这里，见说明书 gwb-plugin-sources。
---

# 插件怎么装、怎么管、怎么升

这个 home 里装了哪些插件、各自加载了没有、谁有新版本，归 `gwb-plugin-manager` 管。十四条命令，
agent 经 MCP 入口的 `run` 按名字调用。查源上有什么可装、配第三方包源，见说明书 `gwb-plugin-sources`。

## 先分清两层：包与条目

- **包**：npm 包，`pnpm add` 进 home 的 `node_modules`。装了包**什么都不会发生**，它只是在磁盘上
- **条目**：`cordis.yml` 里的一行，指向一个包。**有了条目，插件的代码才会被加载运行**

一个包可以有好几条条目（各是一个实例、各存各的数据）。`plugin-manager.list` 返回的就是这两层：
每个包下面有哪些条目、每条启用没有、加载成功（active）没有。

## 装：plugin-manager.install

`{ "pkg": "@godcreator/gwb-xxx" }`（可选 `spec` 指定版本）。它做三件事：pnpm add 进 home →
**把该进 home 的 peer 也装成 home 的直接依赖** → **自动加一条条目（默认启用）**，回执里带新条目的
`entryId`。

**装的是「库」就不加条目**：清单 `keywords` 里写了 `gwb`、却没写 `gwb-plugin` 的那种
（`block-note`、`gwb-plugin-api`、`gwb-repo-kit`）。库没有 `apply`，加进 `cordis.yml` 也加载不了
（日志 `invalid plugin, expect function or object with apply`），只会多一条报错的条目。这种回执**没有
`entryId`**，`note` 里写着原因；包照样装上了，要用它的插件自己 `inject` 它提供的服务。

只有**明确写明是库**的才不加条目——第三方插件（`@j/…` 那类）常常一个 keywords 都不写，把「没写」
也当库，就会变成「装上了却不加载」，更难查。要显式给一个包加条目，用 `plugin-manager.add-entry`
（它不看 keywords）。

- 装不下来（pnpm 没成、包名不存在）返回 `ok: false`，error 带着原因和 pnpm 输出的最后几行
- **装完之后调一遍 MCP 入口的 `index`**——新插件的命令这时才出现

### peer 版本对不上：照装不拦，回执里点名

插件管理调用 pnpm 时不带任何 peer 参数，pnpm 默认不严格：peer 对不上时**照装、`ok: true`**。
`install`、`update`、`update-all` 装完都运行一次 `pnpm peers check`，home 里对不上的每一处写进回执的
`data.peerWarnings`，一处都没有就没有这一项：

```json
"peerWarnings": [
  { "peer": "@godcreator/gwb-shell", "installed": "0.7.2", "wanted": ">=0.8.0", "by": "@godcreator/gwb-glm-quota@0.1.2" }
]
```

- `peer` 是对不上的那个上游包，`installed` 是 home 里现在的版本（根本没装上时没有这一项），`wanted` 是
  `by` 那个插件要求的范围。`by` 隔着几层依赖时，从 home 的直接依赖一路写到它，用 ` > ` 连接
- 查的是 **home 整棵依赖树**：原来就对不上的也在里面，不只这一次新加的
- 怎么办：多半是**有插件还没跟上上游的破坏性版本**——`by` 那个插件要发一个跟上的版本，发了再升它；
  如果是 home 里的上游太旧（新装的插件要更新的上游），就把上游升上来。在那之前两边照常装着，
  运行是否正常要自己看一眼
- `pnpm peers check` 本身没读出结果时没有 `peerWarnings`，`note` 里会说一句「peer 版本是否对得上不知道」

### peer 那一步：谁装、谁跳过、谁没装上

插件如果依赖一个**会独立升级**的 npm 包，而且只读它的文件、启动它的进程（不 import 它的代码），
那个包就该写成插件的 peer，并且**装成 home 的直接依赖**——只有写进 home 的 `package.json`，
`<home>/node_modules/<包名>` 这个链接才存在，升级时 pnpm 会改它指向新版本，插件每次现查就拿到
当前版本，不用重启也不用重新加载。**pnpm 自动补装的 peer 做不到这一点**：它只放进 `.pnpm/`，
那个链接根本不存在，于是 `plugin-manager.outdated`（只看 `package.json`）看不见它，
`plugin-manager.update-all` 也永远升不到它。

所以 install 读刚装进来的那个包的 `peerDependencies`，逐条判断：

| 回执里的 `action` | 什么情况 |
| --- | --- |
| `installed` | 这次装成了 home 的直接依赖（装 latest；`range` 里是插件清单写的范围，latest 通常都满足） |
| `present` | 本来就在 home 的 `package.json` 里，**版本一个字没动**——不降级、不改别人定好的版本 |
| `skipped` | 不该由这里装：`cordis`（内核提供的那一份）、本生态的插件（要装走 `plugin-manager.install`，那条还会加条目）。共享包（清单里有 `gwb.shared` 的库，如 `block-note`；react 由 shell 自己声明）与生态外的包照装 |
| `failed` | 装不上（源上没有之类，`note` 里是原因）。**插件本身照样装上了**，回执顶层 `note` 里点名，自己去 home 里 `pnpm add` 一次 |

回执形状：`{ ok, pkg, entryId, peers?: [{ pkg, range, action, note? }], note?, peerWarnings? }`。插件一条
peer 都没声明就没有 `peers` 这一项。`peers` 说的是「装了没有」，版本对不对得上看 `peerWarnings`（上一节）。

**卸载不动 peer。** `plugin-manager.uninstall` 只删这个包和它的条目，**不去查谁还在用那些 peer，
一条都不删**——这不是漏了：残留一个没人用的包只是占磁盘，误删一个还有插件在用的包会让它运行出错。
真要清理，自己在 home 里 `pnpm remove`。

**只有 install 会装 peer。** `plugin-manager.update` / `plugin-manager.update-all` 不重读
`peerDependencies`——升级会把已经在 `package.json` 里的那些一起升到最新，但新版本**新加**的 peer
不会自动装进来。插件加了新 peer 的那个版本，要自己补一次 `pnpm add`。

## 升：plugin-manager.update（和 install 只差一点：不加条目）

`{ "pkg": "@godcreator/gwb-xxx" }` 把**已装**的包升到最新。先用 `plugin-manager.outdated` 查谁有新版本
（不用传参数），返回 `包 → { current, latest }` 的表。

- 它运行 `pnpm add <pkg>@latest`，**不建条目**——条目引的是包名，包换了版本条目照样有效。
  别拿 install 当升级用：那会给同一个包再加一条条目
- **正在运行的插件还是旧代码，重启内核后才换成新的**——升完要把这句告诉人；要立即生效用下面的
  `plugin-manager.update-all`
- 包没装会直接抛错；pnpm 没成返回 `ok: false` 带最后几行输出；成了返回 `{ ok, pkg, peerWarnings?, note? }`，
  peer 对不上照升、`peerWarnings` 点名（同 install 那一节）

## 一键热升：plugin-manager.update-all（发完新版本就调它，不重启）

不带参数直接调（或 `{ "only": ["@godcreator/gwb-xxx"] }` 只升指定的）。一条命令做完三件事：
`plugin-manager.outdated` 拿到清单 → **一次** `pnpm add` 把全部过期包升到清单上的精确版本 →
升了的每个包的**每条条目**停用再启用（loader 重新 import，运行的就是新版本；本来停用的保持停用）→
`shell.reload` 整页重新加载界面。

- 回执 `{ updated: [{ pkg, from, to, entries: [{ id, action, state }] }], selfDeferred, reload, note?, peerWarnings? }`：
  `action` 是 remounted / skipped / deferred / failed，`state` 是重新加载后的状态（ACTIVE 才算加载成功）
- **升到 `gwb-plugin-manager` 自己**（`selfDeferred: true`）：它那条条目在回执发出之后才重新加载，别等它
  出现在 `entries` 里显示 remounted
- **升到 `gwb-mcp` 自己**：进行中的 MCP 请求会中断（MCP 入口随插件一起重新加载）。MCP 是会话状态的，
  **要重连一次**，不会自己恢复；重连后用 `plugin-manager.list` 核对版本与 active，再调一遍 `index`
- pnpm 没成返回 `ok: false` 带最后几行输出，**一条条目都没动**；`note` 里有话就读（全都是最新的、
  only 里指定了却不在清单里的、界面要手动刷新）
- **有插件没跟上上游的破坏性版本**：照升、不拦，`data.peerWarnings` 点名谁要什么范围（见 install 那一节）——
  去追那个插件；不想让上游先升，就用 `{ "only": [...] }` 只升别的

## 删：remove-entry 与 uninstall 的分工

**只删一条条目**用 `plugin-manager.remove-entry`（`{ "entryId": "..." }`）：条目从 `cordis.yml` 里删掉、
插件当场卸载，**包留在 home 里**——随时可以用 `plugin-manager.add-entry` 加回来。有多条实例的插件
要去掉一条，用它。

**整个包删掉**用 `plugin-manager.uninstall`（`{ "pkg": "..." }`）：先删掉这个包的**全部条目**，再
`pnpm remove` 掉包。设置与数据留在磁盘上，重新装回来还是那份。依赖它的其他插件会被 cordis 卸载，
在 `plugin-manager.list` 里显示为未加载。**不要拿 install 当反操作**——那是再加一条条目。

## 条目 id 与归属：数据与设置属于哪个包

数据目录与设置分区按条目 id 划分，而默认 id 去掉了 scope——`@a/gwb-foo` 与 `@b/foo` 都叫 `foo`。
所以数据插件和设置插件都给磁盘上的东西记了归属（包名）：

- install 与 `add-entry` 不给 id 时，**优先用回本包留在磁盘上的旧 id**，属于别的包的 id 跳过——
  装回来的插件拿到的还是自己那份数据与设置
- `add-entry` 手工给的 id 属于别的包时直接拒绝，错误里写明属于谁
- 插件加载失败、日志说「数据目录 … 属于 X」「设置分区 … 属于 X」：就是这条在拦。**同一个插件改了包名**
  要继续用旧数据，用 `plugin-manager.transfer-owner`（`{ "id": "foo", "pkg": "<新包名>" }`）把数据与设置
  一起转过去，再 `remount` 那条条目；**不是同一个插件**就给它换个 id（`remove-entry` 再带 `id` 调
  `add-entry`），别转归属——那等于把前一个包的东西交给它

## 启用与停用

用 `{ "entryId": "..." }` 调 `plugin-manager.enable` / `plugin-manager.disable`。停用的条目不加载，
立即生效。entryId 写完整的（`home:commands` 那种）或只写 id（`commands`）都可以。

## 重新加载一条：plugin-manager.remount

`{ "entryId": "..." }`。停用 → 等卸载完 → 启用 → 等加载完，**一条命令做完**（本来停用的，最后是启用的）。
要让一条条目重新 import（装了新版本之后）就调它，**别用 disable 加 enable 两条拼**：目标是
plugin-manager 自己或命令总线时，disable 一返回命令表就没了，enable 调不进去，条目停在停用状态。

- 回执 `{ id, action, state }`。`remounted`：在这条命令里做完，`state` 是重新加载后的状态，ACTIVE 才算成功。
  重新加载命令总线（`commands`）也属于这一种
- `deferred`：目标是 **plugin-manager 自己**。回执先发出，下一个宏任务才重新加载，`state` 是动手前的状态；
  不会有第二份回执，过一会儿用 `plugin-manager.list` 核对 `active`
- 修改条目树时抛错返回 `ok: false`，`data.action` 是 `failed`；条目不存在返回 `ok: false` 和一句说明

## 改显示名

`plugin-manager.set-label` 传 `{ "entryId": "...", "label": "中文名也行" }`——条目 id 只能是 ASCII，
给人看的名字写在这里；空串是清除。只影响显示，不影响任何行为。

## 建议的顺序

装插件 → `list` 看一遍 active → 调 MCP 入口的 `index` 看新命令。**「装上了」和「加载成功」是两回事**，
加载失败的插件在 `plugin-manager.list` 里看得出来（条目在、active 为假）。
