# gwb-devkit

开发套件，**一个普通的 gwb 插件**：住 `plugins/devkit/`，仓是双包 workspace（件住 plugins/、包住 packages/，与 base-plugins 同习俗）（2026-09-15 起，
`packages/repo-kit` 是仓侧守卫工具包 `@godcreator/gwb-repo-kit`，`docs-site/` 照旧）。发团队源
（gitea 个人源，**本仓发版要给 packages 参数**），装进 home。
它管建仓 / 加件 / 手册 / 测试 home / 改一版看一版五件事，外加一支包内 CLI——`bin/cdp.mjs`（经 `gwbNodeCli` 登记成 `devkit.cdp`）。
**本插件没有浏览器半**：它的使用者是 agent，读的是回执。设计与原理在文档站（`docs-site/`，
六区），这份只装**不知道就会做错事**的硬约束。

## 文档站是正本，六区

`AGENTS.md`、`README.md` 与包内 `skills/` 下的说明书**全是生成物，别手改**——
正本在 `docs-site/content/outputs/`，映射表在 `docs-site/docfirst.config.mjs` 的 `outputs`。
改完在 `docs-site` 跑 `pnpm doc:render` 重摆，mdx 源、生成物、`.ledger.json` 同一个提交。

六区各是什么：`content/docs` 现状（**钉码只在这一区**与 outputs）、`trajectory` 轨迹卡（只增
不改、**不钉活代码**）、`spec` 在途交接（有页就是有活在路上，做完拆解归梁后删页）、`future`
未来、`outputs` 生成正本、`feedback` 本仓孵化区。怎么写见 skill「docfirst-docs」。

## 门禁

```powershell
pnpm check          # = typecheck + vitest
pnpm build          # 只构建 plugins/* 与 packages/*，tsc 直出 dist/，没有打包器；文档站不在里面
```

**`pnpm check` 不构建。** 它吃的是源码，全绿只说明源码站得住，跟「装出来能不能跑」是两件事。

文档站的检查**不在 `pnpm check` 里**——它要起文档站的解析链，太慢。单独两条：
`docs-site` 里 `pnpm doc`（`docfirst check`）与 `pnpm doc:confirm`。

## 发版

抬哪一位、依赖怎么写、什么时候跟上游，照本包的说明书「gwb-release」——全生态同一套，本仓不另立。

1. **先抬 `package.json` 的版本号。** 同一个版本号永不重发；要发新的一版，先抬号、提交，再调
2. 发版走 `devkit.release {"dir":"<本仓根>","packages":["plugins/devkit"]}`（repo-kit 也改了就
   `["packages/repo-kit","plugins/devkit"]`，按依赖序）——仓根 git 树不干净就拒、构建之后上车检票（规矩见「gwb-release」）没过就拒、
   staging 发 latest、不改仓里任何文件。**手工那条不检票**，检票是 `devkit.release` 的事。**它不跑 `prepublishOnly`**（staging 分发形态里没有 `scripts`，产物靠
   仓根构建加 `files` 白名单守卫）；真要走仓里钩子的场景才用手工那条：在包目录里
   `pnpm publish --no-git-checks`（scope 路由住用户级 `~/.npmrc`，**别手写 `--registry`**）——那时
   `prepublishOnly` **别删**，少了它会把上一版的 `dist/` 原样发出去而且一声不吭（现象是
   「插件挂上了但新写的东西全没生效」）

**发版前先在隔离 home 装一遍验完**——`plugin-manager.update-all`（插件窗格那颗「全部更新」）
直接升日常那份 home，跳过了隔离验证；人点那颗键是最后一步，不是验证的一步。

**发完就去升 default，别攒着。** 手册与命令都随包走，不升＝ agent 读到的还是上一版，
而它照着过期手册干活**不报错**。新插件第一次装走 `plugin-manager.install`，装完下一次调门的
`index` 现拼就有它的命令。

**`files` 白名单五项，一项都不能少**：`dist`、`src`、`template`、`skills`、`bin`。

| 少了哪项       | 什么当场坏掉                                                   |
| ---------- | -------------------------------------------------------- |
| `dist`     | 插件根本挂不上                                                  |
| `template` | `devkit.scaffold` 回「包内 template/ 不在」                     |
| `skills`   | 写插件手册与发版规则装不进 home，agent 那边少两份说明书                        |
| `bin`      | `devkit.cdp` 的 entry 指向一个不存在的文件，`devkit.dev` 的重挂与取证三步一起废 |
| `src`      | 类型跳转与读源码断掉（不影响运行）                                        |

## 模板

**只有一种仓形**：薄壳 workspace——根是 private 壳，件住 `plugins/<短名>/`，非件包住
`packages/`（按需）。「单件仓」只是 plugins/ 下恰好一个目录。模板分两区：`template/repo/`
铺仓根（薄壳半），`template/pkg/` 铺件包（**唯一正本**——建仓 `devkit.scaffold` 与加件
`devkit.scaffold.plugin` 落的是同一份，单多格式统一靠这个，不靠纪律）。件包自足：tsconfig /
vitest / oxlint 配置全在包内，搬到哪个仓形状不变（oxlint 认 cwd 命中，所以 `.oxlintrc.json`
跟件包走、不住仓根）。在役的老裸根单件仓随触随迁，不专门迁。

`template/` 下的文件一律带 `.tpl`，落盘时脱后缀（`npm pack` 不打 `.gitignore` 是硬行为，
一条规则管所有文件）；**每个文件都得声明住哪一区**——`landRel` 对区外文件当场抛，
没声明的落下去就是一棵没人认领的树。

**模板里的 `@godcreator` 钉版跟源走**：dev 钉＝源上 `dist-tags.latest`，peer 写 `^<dev 钉>`。
钉旧了新仓开箱就是火车债、第一次发版就被检票拦下，钉了源上没有的号新仓 `pnpm install` 当场炸——
动模板钉版之前 `pnpm view <包> dist-tags.latest` 现查。模板起始号 0.1.0（0.0.x 过不了检票）。

**占位符集合就这六个**：`{{name}}`、`{{title}}`、`{{pkg}}`、`{{pkgName}}`、`{{cssPrefix}}`、`{{docsBlock}}`。
**认不出的占位符当场抛**——给模板加了新占位符，`src/scaffold.ts` 的 `placeholders()`
必须同时加一条，否则下一次建仓整个失败（而不是留一个 `{{typo}}` 活到别人的 package.json 里）。

两条落盘纪律，都是「没有干净回滚点」推出来的：**整套先在内存里渲染完再碰盘**；
**目标目录必须还不存在**（建仓是仓根，加件是 `plugins/<短名>/`），存在就拒，不覆盖任何东西。
加件另有一条读盘的前置：repo 的 `pnpm-workspace.yaml` 里得有 `plugins/` 那条——老裸根单件仓
当场拒，报错里带迁移的路，而不是把件铺进一个长不成的形状。

## 没有设置项

起 home 拉宿主自己那个 exe，不认内核仓；`devkit.audit-deps` 的容器根缺省现问总线上的
`unit-folder.list`。所以本插件一项设置都不 `define`。

**将来真要加，配置一律走 `gwbSettings.define`，不吃 `cordis.yml` 的 `config`。** 新加一项可改的东西就
`define` 一项（类型 `string` / `number` / `boolean` / `secret`），别在条目上开
config 面——写在 yml 里的那份界面看不见、agent 也不知道有它。

## 命令的 description 必须带参数形状

命令总线不带参数 schema，调用方（多数是 agent）看得见的只有 description 那一句：它得**只看
它就知道参数怎么给**。所以每条 `register` 的 description 里写出形状（`{ lines?: number }`、
`{ name, force? }`），**无参数的明写「无参数」**。参数复杂的，回执里再带完整说明
（`devkit.scaffold` / home 那几条就是这么干的），但 description 里那句形状仍然要有。

**命令没有「露到顶层」这回事**：MCP 门的工具面封顶 `index` / `search` / `run` 三枚，agent
经 `index` 看到一句话 description、经 `search` 看到 usage、经 `run` 按名调。所以 description
写一句话、参数形状写进 `usage`，两样都是 agent 唯一的说明。

## 建站是两步，两条都不是本包的命令

`devkit.scaffold` 的站那半**经命令总线按名字转出去**，本包不依赖那两个插件的任何包：

1. `docs-site.create`（站点插件 `@godcreator/gwb-docs-site`）铺 fumadocs 骨架
2. `docfirst.attach`（docfirst 插件 `@godcreator/gwb-docfirst-workflow`）在**刚铺好的**骨架上装六区

两条都认**站目录**（`<仓>\docs-site`），不是仓根。**哪个插件没装就跳过那一步**——回执里
说清怎么补、README 那段话改口，插件那半照样落盘，**不报错终止建仓**。回执里
`docs.built`（骨架）与 `docs.attached`（六区）两个字段才是真相，`nextSteps` 按它俩分三支。

`docfirst.attach` **只在还没写过内容的骨架上装得了**（它自己守着这条），所以补建的两条
要连着敲。`devkit.livedoc` 与 `@godcreator/live-doc-cli` 那条依赖 0.3.0 起都没了。

## 改一版看一版：换插件的工具不许住在被换的进程里

`devkit.dev` **住控制台那个 home、操作另一个 home**：盘那半（构建、发版、装进目标 home）在本进程做，
页那半（重挂、刷新、取证）经 CDP 送到目标页去。换插件那一步要把条目停用再启用，工具自己跑在目标里
就会把正在跑的它自己停掉。**目标是 `default` 或本插件自己所在的 home，两种都当场拒**。

**重挂一条条目只发一条 `plugin-manager.remount`，不许拆回 `disable` 加 `enable` 两条**：被换的是
plugin-manager 自己或命令总线时，第二条没人接，条目卡在 `disabled: true`。回执 `deferred`
（plugin-manager 重挂自己，回执之后才动手）就轮询 `plugin-manager.list` 到它回来，带超时。

**目标那份运行时记录（`<home>/runtime.json`）本包只读不写。** 写它的是内核（开机整份重写 pid /
startedAt / appDir / cdp）与 mcp 插件（绑上端口之后补 `mcp` 那个字段）。所以本包里**不许再出现写这份
文件的代码**——两个写者已经够多了，第三个只会带来一份谁也说不清的真相。读它的规矩有两条：
**验活**（pid 还在、且那个 pid 真的持着记录里那个端口），以及**记录不删**（进程退了也留着，
下一次开机内核会整份重写）。

**够一个 home 只有一条路：说出它的名字。** `devkit.dev` 与 `bin/cdp.mjs` 两处**都不收端口**，
给了当场拒；起 home 的那两条也不收，端口由 `pickCdpPort` 自动挑。端口是查出来的，连上之后还要拿
页面自报的名字核对一次：
记录回答「你要的是哪个」，页面回答「你连上的实际是哪个」。理由是端口没有语义，敲错一位就落在
另一个现场，而那个现场会老老实实收下这一趟改动。**所以本包里不许再长出「给个端口就连」的旁路**，
包括图省事的内部调用：链里那七步也是按名字调驱动的，为的就是每一步都白得一次核对。

**不许把产物覆盖进 home 的 `node_modules`**：home 里那些文件是硬链接到 pnpm 全局仓的，覆盖写会
写穿它；而且 ESM 模块图按 URL 缓存，不换版本号就换不动 node 那半。**装上的版本号变了路径才变**
（pnpm 虚拟仓目录名超长时截成前段加全名哈希，预发布段在哈希里，同 patch 的两个 dev 号目录也不同），
重挂那一下才真的重新求值。

**装进目标 home 不许走 `pnpm add <包>@<号>`**：home 清单里已有 `^` 声明时 pnpm 12 写回去的是
`^<号>`，锁里已解析的同 patch 旧预发布号会被当成满足、不重解析，退出码照样 0。所以是**清单里写死
准确号再 `pnpm install`**，装完读 `node_modules/<包>/package.json` 核对版本，对不上当场
`ok: false`、不重挂。

**收尾是取证不是刷新**：装上的是这一趟的号、条目要真 ACTIVE、日志增量里不许有 error，取不到就回
`ok: false&#x60;。**`devkit.home.rm` 同一个规矩**：回「已删」之前目录必须真不在（删的调用不报错不算数）。

`bin/cdp.mjs` 是**零依赖单文件纯 JS，不进 typecheck**——它得在工作台起不来时也能直接跑，
那是它的另一个身份。**它的路径一概不看工作目录**：截图缺省落被截那个 home 自己的 `out\cdp\`，
给输出与 `eval` 的文件都只收绝对路径；写盘落点不许在本包目录与任何 `node_modules` 里
（`tests/cdp.test.ts` 钉着，文件里出现 `process.cwd()` 也当场红）。

## 说明书只挂自己那份

本包挂三份说明书，正本都在 `docs-site/content/outputs/skills/`，随包发、经 `gwbSkills` 挂给 agent：

| 说明书           | 正本                                                                                    | 管什么                            |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------ |
| `gwb-devkit`  | `gwb-devkit.mdx`，附件 `gwb-devkit-evidence.mdx` / `gwb-devkit-ui.mdx`（摆成 `references/`） | 写插件的路、内循环、测试 home、验机、红线、能力面    |
| `gwb-release` | `gwb-release.mdx`                                                                     | 全生态的发版规则：抬哪一位、依赖怎么写、什么时候跟、发版流程 |
| `fresh-eyes`  | 包内 `skills/fresh-eyes/SKILL.md`（手写）                                                   | 生态自举验收                         |

主文件只放每次写插件都要的；只有部分场景用得上的放附件，经 `skill.read {name, file}` 读。
这份 AGENTS 不复述说明书，说明书也不往这儿搬。

**别替别的插件代挂说明书。** 说明书是全局单一命名空间，撞名的那份直接不挂、只留一行
警告，而被撞掉的常常是新那份——症状是 agent 读到旧的、照着做但做错了，最难查。
知识随插件走，别人的说明书由那个插件自己挂。

## 钉码与确认

`docfirst check` 守着现状区与生成正本区的论断跟源码一致，也守着生成物跟 mdx 源一致，红了就是
漂了或者没重摆。

被钉住的源码改动过要**先 commit 再 `pnpm doc:confirm`**——git 比较器只对已提交、
工作区干净的内容钉。轨迹区（`content/trajectory/`）**不钉活代码**：它冻结历史，
钉了就变成一份会变黄的现状文档。
