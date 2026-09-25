---
name: gwb-plugin-manager
description: 装插件、找插件或配第三方包源、升级插件、升内核、查插件 peer 里的内核包或别的插件满没满足、增删改条目、插件装了却没加载时读。
---

# 插件管理

home 里有两层：

* **包**：pnpm 装进 home 的 `node_modules`，只是在磁盘上
* **条目**：`cordis.yml` 里指向一个包的一行。有了条目，插件的代码才加载运行。一个包可以有好几条条目，各是一个实例、各存各的数据

`plugin-manager.list` 同时报两层：每个包下有哪些条目，每条启用没有、`active`（加载成功）没有。内核包与 `cordis` 没有条目，`list` 与 `outdated` 都不列它们，也不许 `uninstall`；内核包照下面「升内核」换。命令作用在 MCP 入口连着的那个 home；要操作隔离 home，经 `devkit.cdp {"args":["<home 名>","cmd","plugin-manager.<命令>","<JSON 参数>"]}` 调。

回执只有外层一层 `ok`：成功时读 `data`，失败时读 `error`（pnpm 输出的最后几行拼在它末尾）。

## 装一个插件

1. `plugin-manager.search` 确认包名（第三方 scope 先按下一节配包源）
2. `plugin-manager.install {"pkg":"<包名>"}`，可选 `spec` 指定版本或 tag。一次 `pnpm add`，home 的 `package.json` 照 pnpm 默认写 `^` 范围，再加一条启用的条目，回执 `data` 是 `{ pkg, entryId }`。包已经装了直接报错：再加一条条目用 `add-entry`，换版本用 `update {"specs":…}`
3. `plugin-manager.list` 看这个包的条目 `active`
4. 调一次 MCP 入口的 `index`，新插件的命令这时出现

**完成判据**：`list` 里这个包的条目 `active` 为 true；`index` 里有它的命令。

`active` 为 false 时原因在 `gwb.log`；日志说数据目录或设置分区属于别的包，见「增删改条目」第 3 步。

## 配第三方包源

插件管理只读 npmrc、不写。第三方 scope 的包源由你往机器级 `~/.npmrc`（本机所有 home 共用）手写：

1. 读一遍 `~/.npmrc`，这个 scope 已有 `@<scope>:registry=` 行就改那一行，没有就在末尾加
2. 加路由行 `@<scope>:registry=<源地址>`，源地址以 `/` 结尾。gitea 上的包源地址是 `<gitea 地址>/api/packages/<用户或组织>/npm/`
3. 私有源另加凭据行 `//<主机>/<路径>/:_authToken=<token>`：`<主机>/<路径>/` 就是源地址去掉 `https:` 的部分（如 `//git.example.com/api/packages/j/npm/:_authToken=…`）。token 向人要，不要自己编，也不要写进回复与日志
4. `@godcreator` 那两行不动：本机所有 home 的安装、所有源码仓的安装与发版都靠它
5. `plugin-manager.search` 核对

**完成判据**：`search` 回执 `data.packages` 里有那条源上的插件，`data.note` 里没有点名这个 scope。

`search` 两份 npmrc 都读：先找 `@scope:registry=`，再找 `registry=`，每一种都是 home 级 `<home>/.npmrc` 优先于机器级 `~/.npmrc`，都没写就是 npm 官方源。这和 pnpm 安装读的是同一批配置行，从哪装就在哪搜；home 级有同名 scope 时生效的是 home 级那条。删一条包源就删掉这两行。

## 升级插件

1. `plugin-manager.outdated` 看谁有新版本，回执 `data.updates` 是 `包名 → { current, latest }`
2. `plugin-manager.update`，参数三选一、恰好给一个，不给参数直接报错：

   * 全升：`{"all":true}`
   * 只升几个：`{"only":["<包名>"]}`；名字不在 home 的 dependencies 里、或是内核包与 `cordis`，直接报错；已是最新的写进 `note`
   * 按给定写法装已装的包：`{"specs":{"<包名>":"<版本号、tag 或 file:<绝对路径>>"}}`，不查 `outdated`；包不在 home 的 dependencies 里直接报错（首次安装用 `install`）。写法是准确版本号的，装完核对装上的就是它，对不上回 `ok: false`、`error` 逐项写要的与装上的、一条条目都没重新加载——多半是在往回退版本：清单里那一项是 `^` 范围，pnpm 留着范围里更新的那个。不做回退，升坏了发新版往前修；tag 与 `file:` 不核对

   一条命令做完：一次 `pnpm add`（`all` 与 `only` 升到 `outdated` 查到的版本，`specs` 原样用给的写法）→ 装之前与装之后真实目录变了的包，每条条目重新加载（停用、等卸载完、启用、等加载完；本来停用的保持停用；点了名的在前，跟着换了目录的别的包——多半是 peer 写了被升级包的插件——在后），装的就是原来那一版、目录没变的不动，不重启
3. 读回执 `data.updated[].entries[]` 与 `data.dependents[].entries[]`：每条 `{ id, action, state }`，`action` 是 `remounted` 且 `state` 为 `ACTIVE` 才算加载成功，`failed` 时 `state` 是出错原因；`dependents` 是没升级、但这次换了目录跟着重新加载的包。`specs` 的 `updated[].to` 是装完读到的版本号（tag 与 `file:` 装上了哪一版看它）；装之前读不到版本号的包没有 `from`。`selfDeferred: true` 表示插件管理自己在回执发出后才重新加载，过一会儿用 `list` 核对；升到 gwb-mcp 自己时进行中的 MCP 请求会断，重连一次
4. 插件管理不整页重新加载：要让界面换成新代码，拿到成功回执后自己调一次 `shell.reload`
5. `plugin-manager.list` 核对版本与 `active`，再调一次 `index`

**完成判据**：`outdated` 里不再有这次升的包；`list` 里它们的版本是新版、条目 `active` 为 true，`dependents` 里的包条目 `active` 也为 true；升级后调过 `shell.reload`。

升级前的隔离 home 验证、上游发了破坏性版本时怎么升，见说明书 `gwb-release`。

## 升内核

内核包 `@godcreator/gwb-kernel-desktop` 也经 `update` 的 `specs` 换，`all` 与 `only` 不动它。`outdated` 不报内核有没有新版本：写 `latest` 就装源上的最新版，回执里内核包的 `from` 与 `to` 相同就是已是最新。新内核先在隔离 home 里升、重启验完，再升 default。

1. `plugin-manager.update {"specs":{"@godcreator/gwb-kernel-desktop":"<版本号或 latest>"}}`，可以连同别的包一起写。`cordis` 不写（写了直接报错）：插件管理装完内核包，自己照它 `peerDependencies.cordis` 写的精确版本号装 `cordis`。不重新加载任何条目
2. 读回执 `data`：`updated` 里内核包与末尾 `cordis` 的 `{ from, to }`；`restartRequired`（装上的内核与正在运行的不同时是 true）
3. `restartRequired` 为 true 时告诉人要重启工作台才生效；重启由人决定，不要自己重启。重启后调 `plugin-manager.list`，`unmetPeers` 里有内核包那一项的插件，peer 范围不包含新内核（下一节）
4. `ok: false` 且 `data.kernel` 在、`error` 说先别重启：内核包已经装上、`cordis` 没对齐。按 `error` 修好再调一次：内核包 peer 里的 `cordis` 写成了范围；装 `cordis` 时 pnpm 失败（原因在 `error` 末尾）；或者 pnpm 装上的 `cordis` 不是要的版本，照 `error` 里给的精确版本号改 home 的 `package.json` 里 `cordis` 那一项

**完成判据**：回执 `ok` 为 true，人已知道要重启；重启后 `runtime.json` 报的内核版本是回执里内核包的 `to`，`list` 里 peer 范围不包含新内核的插件已告诉人。

## 查插件 peer 里的内核包与别的插件满没满足

1. `plugin-manager.list`，看每个包的 `unmetPeers`：插件（keywords 含 gwb-plugin）peer 里 `cordis` 以外、没满足的包，每条 `{ pkg, range, installed? }`
   * 内核包 `@godcreator/gwb-kernel-desktop`：`range` 不包含正在运行的内核就列，`installed` 是运行中的内核版本；peer 里没写内核包的插件不列这一项
   * 别的包没装：没有 `installed` 字段；`peerDependenciesMeta` 里标了 `optional: true` 的没装不算
   * 别的包装着但版本不在 `range` 里：带 `installed`
   * `range` 不是 `^x.y.z`：原样照抄，算没满足
   * 比法：`^x.y.z` 在主版本号为 0 时要求次版本号相同（`^0.3.0` 包含 `0.3.4`，不包含 `0.4.0`），≥1 时要求主版本号相同，并且不低于 x.y.z；预发布段不看
   * 库、第三方 cordis 插件、清单读不到的包、全都满足时是空数组
2. 列出 `unmetPeers` 不空的包。这些都只是报告、照常加载；出了问题先怀疑它们
   * 内核包那一项：到那个插件的仓里在隔离 home 验证后改 peer 里内核包的范围再发版（说明书 `gwb-devkit`、`gwb-release`）
   * peer 里的插件太旧或没装：升级或安装那个插件，`update {"only":["<那个插件的包名>"]}` 或 `install`；装着的版本比范围新（上游出了破坏性版本）的，到写 peer 的那个插件的仓里适配后改 peer 再发版
   * `range` 不是 `^x.y.z`：到那个插件的仓里改写法再发版，`devkit.release` 会拒写错的

**完成判据**：给出 `unmetPeers` 不空的全部包名与每条没满足的 peer。

## 增删改条目

1. `plugin-manager.list` 找到条目的 entryId（写完整的 `home:commands` 或只写 id `commands` 都行）

2. 调对应的命令：

   | 要做什么        | 命令（前缀 `plugin-manager.`）                                                              |
   | ----------- | ------------------------------------------------------------------------------------- |
   | 给已装的包再加一条条目 | `add-entry {"pkg":"<包名>"}`，只收 `pkg`；id 自动生成：包名去掉 scope 与 `gwb-` 前缀，条目树上已有就加 `-2`、`-3` |
   | 删一条条目、留着包   | `remove-entry {"entryId":"…"}`，随时可以 `add-entry` 加回来                                   |
   | 删包连同它的全部条目  | `uninstall {"pkg":"<包名>"}`，设置与数据留在磁盘上，重装回来默认 id 空着就还是那份；依赖它的插件停在未加载                   |
   | 启用、停用       | `enable` / `disable {"entryId":"…"}`，立即生效                                             |
   | 手动重新加载一条    | 先 `disable` 再 `enable`；目标是命令插件（`gwb-commands`）、MCP 入口（`gwb-mcp`）或插件管理自己时别这样做，见「参考」    |

3. 插件加载失败、日志说「数据目录 … 属于 X」或「设置分区 … 属于 X」：这个 id 的数据或设置是别的包留下的（卸载后另一个同名包拿到了同一个 id）。插件管理不读也不改归属，照数据插件与设置插件报错里说的处理

4. `plugin-manager.list` 核对

**完成判据**：`list` 里条目的有无、启停与 `active` 都是你要的状态。

## 参考

* **别用 `disable` 加 `enable` 重新加载调用要经过的插件**：命令插件、MCP 入口、插件管理自己停用以后，`enable` 调不进去，条目停在停用状态。这几个换版本经 `update`，它在一条命令里做完停用与启用
* **同一时刻只允许一个改动**：`install`、`uninstall`、`update` 正在运行时再调回 `{ ok: false, error: "BUSY…" }`，等前一个返回回执后再调。`outdated`、`search` 不写 home，不受这条限制。`add-entry`、`remove-entry`、`enable`、`disable` 也不经过这道检查：`update` 运行时别动它要重新加载的条目。插件管理之外在同一个 home 里运行的 pnpm（`devkit.dev`、手工运行）不受它管，和插件管理的改动同时写 home 会丢改动、而且都退出码 0
* **失败回执**：参数写错（包名、版本范围不合规，有认不出的参数，条目不存在）直接报错；执行中失败回 `ok: false`，`error` 是原因，pnpm 输出的最后几行拼在它末尾。`update` 的 pnpm 失败时一条条目都没动
* **install 只装点名的包**：不装它 peer 里的插件，也不判断它是不是库。插件管理启动 pnpm 时带环境变量 `pnpm_config_auto_install_peers=false`，pnpm 也不会自动补装缺的 peer；缺的看 `list` 的 `unmetPeers`，要用就另外 `install`。人在 home 里手工运行 pnpm 时自己设这个环境变量，命令行参数 `--config.auto-install-peers=false` 会被 pnpm 忽略。装了一个没有 `apply` 的包，条目照样加上、加载失败，用 `uninstall` 删掉
* **是不是插件只看包清单 `keywords` 里有没有 `gwb-plugin`**，名字不参与。`search` 回的是这条规则筛出的全部结果，不维护的旧包也在里面
