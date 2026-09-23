---
name: gwb-plugin-manager
description: 要装插件、升级插件、启用停用、重新加载一条条目、或查这个 home 装了什么时读。讲清包与条目两层、装了包不等于加载了、install 只装包加条目（不装 peer、不判断是不是库）、remove-entry 不删包、插件因「数据目录或设置分区属于别的包」加载失败时怎么办（transfer-owner 还是换 id）、发完新版本怎么一键热升级（update-all，不重启；只升几个包给 only）、以及装完之后要重新调 MCP 入口的 index 拿到新命令。查 registry 上有什么可装、配第三方包源不在这里，见说明书 gwb-plugin-sources。
---

# 插件怎么装、怎么管、怎么升

这个 home 里装了哪些插件、各自加载了没有、谁有新版本，归 `gwb-plugin-manager` 管。十二条命令，
agent 经 MCP 入口的 `run` 按名字调用；插件管理没有别的调用方式。查源上有什么可装、配第三方包源，见说明书 `gwb-plugin-sources`。

## 先分清两层：包与条目

* **包**：npm 包，`pnpm add` 进 home 的 `node_modules`。装了包**什么都不会发生**，它只是在磁盘上
* **条目**：`cordis.yml` 里的一行，指向一个包。**有了条目，插件的代码才会被加载运行**

一个包可以有好几条条目（各是一个实例、各存各的数据）。`plugin-manager.list` 返回的就是这两层：
每个包下面有哪些条目、每条启用没有、加载成功（active）没有。

## 装：plugin-manager.install

`{ "pkg": "@godcreator/gwb-xxx" }`（可选 `spec` 指定版本或 tag）。它做两件事：一次 pnpm add 进 home →
**加一条条目（默认启用）**，回执 `{ ok, pkg, entryId }`。

* **不装插件的 peer，也不判断装的是不是库**：插件的 peer 只该是宿主提供的 `cordis`，库该由用它的插件自己带着。
  装了一个没有 `apply` 的包，条目照样加上、加载失败，`list` 里 active 为假；不要它就 `uninstall`
* 装不下来（pnpm 失败、包名不存在）返回 `ok: false`，error 带着原因和 pnpm 输出的最后几行
* 同一个包 install 两次会得到两条条目（第二条 id 带数字后缀）——只想加一条实例时这样做，否则别重复装
* **装完之后调一遍 MCP 入口的 `index`**——新插件的命令这时才出现

## 升：plugin-manager.update-all（发完新版本就调它，不重启）

先用 `plugin-manager.outdated` 查谁有新版本（不用传参数），返回 `包 → { current, latest }` 的表。

不带参数直接调 `update-all`（或 `{ "only": ["@godcreator/gwb-xxx"] }` 只升指定的）。一条命令做完三件事：
`plugin-manager.outdated` 拿到清单 → **一次** `pnpm add` 把过期包升到清单上的精确版本 →
升了的每个包的**每条条目**停用再启用（loader 重新 import，运行的就是新版本；本来停用的保持停用）→
`shell.reload` 整页重新加载界面。没有「只升包、不重新加载」的命令。

* 回执 `{ updated: [{ pkg, from, to, entries: [{ id, action, state }] }], selfDeferred, reload, note? }`：
  `action` 是 remounted / skipped / deferred / failed，`state` 是重新加载后的状态（ACTIVE 才算加载成功）
* **升到 `gwb-plugin-manager` 自己**（`selfDeferred: true`）：它那条条目在回执发出之后才重新加载，别等它
  出现在 `entries` 里显示 remounted
* **升到 `gwb-mcp` 自己**：进行中的 MCP 请求会中断（MCP 入口随插件一起重新加载）。MCP 是会话状态的，
  **要重连一次**，不会自己恢复；重连后用 `plugin-manager.list` 核对版本与 active，再调一遍 `index`
* pnpm 失败返回 `ok: false` 带最后几行输出，**一条条目都没动**；`note` 里有话就读（全都是最新的、
  only 里指定了却不在清单里的、界面要手动刷新）

## 删：remove-entry 与 uninstall 的分工

**只删一条条目**用 `plugin-manager.remove-entry`（`{ "entryId": "..." }`）：条目从 `cordis.yml` 里删掉、
插件立即卸载，**包留在 home 里**——随时可以用 `plugin-manager.add-entry` 加回来。有多条实例的插件
要去掉一条，用它。

**整个包删掉**用 `plugin-manager.uninstall`（`{ "pkg": "..." }`）：先删掉这个包的**全部条目**，再
`pnpm remove` 掉包。设置与数据留在磁盘上，重新装回来还是那份。依赖它的其他插件会被 cordis 卸载，
在 `plugin-manager.list` 里显示为未加载。**不要拿 install 当反操作**——那是再加一条条目。

## 条目 id 与归属：数据与设置属于哪个包

数据目录与设置分区按条目 id 划分，而默认 id 去掉了 scope——`@a/gwb-foo` 与 `@b/foo` 都叫 `foo`。
所以数据插件和设置插件都给磁盘上的东西记了归属（包名）：

* install 与 `add-entry` 不给 id 时，**优先用回本包留在磁盘上的旧 id**，属于别的包的 id 跳过——
  装回来的插件拿到的还是自己那份数据与设置
* `add-entry` 手工给的 id 属于别的包时直接拒绝，错误里写明属于谁
* 插件加载失败、日志说「数据目录 … 属于 X」「设置分区 … 属于 X」：就是这条在拦。**同一个插件改了包名**
  要继续用旧数据，用 `plugin-manager.transfer-owner`（`{ "id": "foo", "pkg": "<新包名>" }`）把数据与设置
  一起转过去，再 `remount` 那条条目；**不是同一个插件**就给它换个 id（`remove-entry` 再带 `id` 调
  `add-entry`），别转归属——那等于把前一个包的东西交给它

## 启用与停用

用 `{ "entryId": "..." }` 调 `plugin-manager.enable` / `plugin-manager.disable`。停用的条目不加载，
立即生效。entryId 写完整的（`home:commands` 那种）或只写 id（`commands`）都可以。

## 重新加载一条：plugin-manager.remount

`{ "entryId": "..." }`。停用 → 等卸载完 → 启用 → 等加载完，**一条命令做完**（本来停用的，最后是启用的）。
要让一条条目重新 import 就调它，**别用 disable 加 enable 两条拼**：目标是
plugin-manager 自己或命令插件（`gwb-commands`）时，disable 一返回命令表就没了，enable 调不进去，条目停在停用状态。

* 回执 `{ id, action, state }`。`remounted`：在这条命令里做完，`state` 是重新加载后的状态，ACTIVE 才算成功。
  重新加载命令插件（`commands` 条目）也属于这一种
* `deferred`：目标是 **plugin-manager 自己**。回执先发出，下一个宏任务才重新加载，`state` 是动手前的状态；
  不会有第二份回执，过一会儿用 `plugin-manager.list` 核对 `active`
* 修改条目树时抛错返回 `ok: false`，`data.action` 是 `failed`；条目不存在返回 `ok: false` 和一句说明

## 同一时刻只允许一个改动

`install`、`uninstall`、`update-all`、`remount` 同一时刻只允许一个，正在运行时再调回 `{ ok: false, error: "BUSY…" }`，
等前一个返回回执后再试，不要连续重试。

## 改显示名

`plugin-manager.set-label` 传 `{ "entryId": "...", "label": "中文名也行" }`——条目 id 只能是 ASCII，
给人看的名字写在这里；空字符串是清除。只影响显示，不影响任何行为。

## 建议的顺序

1. 装插件
2. 用 `plugin-manager.list` 看一遍 active
3. 调 MCP 入口的 `index`，看新命令

**「装上了」和「加载成功」是两回事**：加载失败的插件在 `plugin-manager.list` 里看得出来（条目在、active 为假）。
