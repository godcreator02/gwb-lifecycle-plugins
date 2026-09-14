# gwb-devkit

开发套件，**一个普通的 gwb 插件**：一仓一包一插件，仓根即包根。发团队源（NAS registry），装进 home。
它管建仓 / 手册 / 测试 home / 改一版看一版四件事，外加一支包内 CLI——`bin/cdp.mjs`（经 `gwbNodeCli` 登记成 `devkit.cdp`）。
**本插件没有浏览器半**：它的使用者是 agent，读的是回执。设计与原理在文档站（`docs-site/`，
六区），这份只装**不知道就会做错事**的硬约束。

## 文档站是正本，六区

`AGENTS.md` 与 `README.md` 与包内 `skills/gwb-devkit/SKILL.md` **三份都是生成物，别手改**——
正本分别是 `docs-site/content/outputs/` 下的 `agents.mdx` / `readme.mdx` /
`skills/gwb-devkit.mdx`。改完在 `docs-site` 跑 `pnpm doc:render` 重摆，mdx 源、生成物、
`.ledger.json` 同一个提交。

六区各是什么：`content/docs` 现状（**钉码只在这一区**与 outputs）、`trajectory` 轨迹卡（只增
不改、**不钉活代码**）、`spec` 在途交接（有页就是有活在路上，做完拆解归梁后删页）、`future`
未来、`outputs` 生成正本、`feedback` 本仓孵化区。怎么写见 skill「docfirst-docs」。

## 门禁

```powershell
pnpm check          # = typecheck + vitest
pnpm build          # tsc 直出 dist/，没有打包器
```

**`pnpm check` 不构建。** 它吃的是源码，全绿只说明源码站得住，跟「装出来能不能跑」是两件事。

文档站的检查**不在 `pnpm check` 里**——它要起文档站的解析链，太慢。单独两条：
`docs-site` 里 `pnpm doc`（`docfirst check`）与 `pnpm doc:confirm`。

## 发版

1. **先抬 `package.json` 的版本号。** 同一个版本号永不重发；发之前先问一句这个号在不在源上
   （`npm view @godcreator02/gwb-devkit versions --registry https://npm.tianshen02.online:28377/`）
2. `prepublishOnly` **别删**。少了它 publish 会把上一版的 `dist/` 原样发出去而且一声不吭
   ——现象是「插件挂上了但新写的东西全没生效」
3. `pnpm publish --registry https://npm.tianshen02.online:28377/ --no-git-checks`

**发版前先在隔离 home 装一遍验完**——`plugins.update-all`（插件窗格那颗「全部更新」）
直接升日常那份 home，跳过了隔离验证；人点那颗键是最后一步，不是验证的一步。

**发完就去升 default，别攒着。** 手册与命令都随包走，不升＝ agent 读到的还是上一版，
而它照着过期手册干活**不报错**。新插件第一次装走 `plugins.install`，装完 `/mcp` 重连。

**`files` 白名单五项，一项都不能少**：`dist`、`src`、`template`、`skills`、`bin`。

| 少了哪项       | 什么当场坏掉                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| `dist`     | 插件根本挂不上                                                                  |
| `template` | `devkit.scaffold` 回「包内 template/ 不在」                                     |
| `skills`   | 写插件手册装不进 home，agent 那边少一份说明书                                             |
| `bin`      | `devkit.cdp` 的 entry 指向一个不存在的文件，`devkit.dev` 的重挂与取证三步一起废；工作台没起时起停源那条路也没了 |
| `src`      | 类型跳转与读源码断掉（不影响运行）                                                        |

## 模板

`template/` 下十个 `.tpl`，落盘时脱后缀（`npm pack` 不打 `.gitignore` 是硬行为，
一条规则管所有文件）。

**占位符集合就这五个**：`{{name}}`、`{{title}}`、`{{pkg}}`、`{{pkgName}}`、`{{docsBlock}}`。
**认不出的占位符当场抛**——给模板加了新占位符，`src/scaffold.ts` 的 `placeholders()`
必须同时加一条，否则下一次建仓整个失败（而不是留一个 `{{typo}}` 活到别人的 package.json 里）。

两条落盘纪律，都是「没有干净回滚点」推出来的：**整套先在内存里渲染完再碰盘**；
**目标目录必须还不存在**，存在就拒，不覆盖任何东西。

## 两个设置项

| key          | 填什么                    | 不填的后果                                             |
| ------------ | ---------------------- | ------------------------------------------------- |
| `kernel-dir` | 内核仓根（含 `apps/desktop`） | `devkit.home.new` / `open` 不工作；`list` / `rm` 不受影响 |

**两个都不给默认值。** 目录是这台机器的事实，编一个只会得到「配置了但不在」的假象。

**配置一律走 `gwbSettings.define`，不吃 `cordis.yml` 的 `config`。** 新加一项可改的东西就
`define` 一项（类型 `string` / `number` / `boolean` / `secret`），别在条目上开
config 面——写在 yml 里的那份界面看不见、agent 也不知道有它。

## 命令的 description 必须带参数形状

命令总线不带参数 schema，调用方（多数是 agent）看得见的只有 description 那一句：它得**只看
它就知道参数怎么给**。所以每条 `register` 的 description 里写出形状（`{ lines?: number }`、
`{ name, force? }`），**无参数的明写「无参数」**。参数复杂的，回执里再带完整说明
（`devkit.scaffold` / home 那几条就是这么干的），但 description 里那句形状仍然要有。

要让一条命令在 agent 那边直接露到顶层，登记时标 `top: true`：**标了就是顶层，桥照它渲染，
没有运行时名单**——MCP 桥固定开 `gwb_command_list` / `gwb_command_run` 两个，外加所有标了
`top: true` 的命令。顶层是写插件时定下来的，不是装进软件之后再批的，所以默认不标，
**标之前先问人**。

## 建站是两步，两条都不是本包的命令

`devkit.scaffold` 的站那半**经命令总线按名字转出去**，本包不依赖那两个插件的任何包：

1. `docs-site.create`（站点插件 `@godcreator02/gwb-docs-site`）铺 fumadocs 骨架
2. `docfirst.attach`（docfirst 插件 `@godcreator02/gwb-docfirst-workflow`）在**刚铺好的**骨架上装六区

两条都认**站目录**（`<仓>\docs-site`），不是仓根。**哪个插件没装就跳过那一步**——回执里
说清怎么补、README 那段话改口，插件那半照样落盘，**不报错终止建仓**。回执里
`docs.built`（骨架）与 `docs.attached`（六区）两个字段才是真相，`nextSteps` 按它俩分三支。

`docfirst.attach` **只在还没写过内容的骨架上装得了**（它自己守着这条），所以补建的两条
要连着敲。`devkit.livedoc` 与 `@godcreator02/live-doc-cli` 那条依赖 0.3.0 起都没了。

## 改一版看一版：换插件的工具不许住在被换的进程里

`devkit.dev` **住控制台那个 home、操作另一个 home**：盘那半（构建、发版、`pnpm add`）在本进程做，
页那半（重挂、刷新、取证）经 CDP 送到目标页去。换插件那一步要把条目停用再启用，工具自己跑在目标里
就会把正在跑的它自己停掉。**目标是 `default` 或本插件自己所在的 home，两种都当场拒**。

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
写穿它；而且 ESM 模块图按 URL 缓存，不换版本号就换不动 node 那半。**版本号变了路径才变**，
重挂那一下才真的重新求值。

**收尾是取证不是刷新**：条目要真 ACTIVE、日志增量里不许有 error，取不到就回 `ok: false`。

`bin/cdp.mjs` 是**零依赖单文件纯 JS，不进 typecheck**——它得在工作台起不来时也能直接跑，
那是它的另一个身份。`eval` 那个文件的相对路径与截图落点按**工作目录**算，不按它装在哪算。

## 说明书只挂自己那份

**手册正本是 `docs-site/content/outputs/skills/gwb-devkit.mdx`**（render 摆成包内
`skills/gwb-devkit/SKILL.md`），随包发、经 `gwbSkills` 挂给 agent。八条红线、能力面菜单、
发版装机、实机验机全在那儿——**这份不复述，那份也不往这儿搬**。

**别替别的插件代挂说明书。** 说明书是全局单一命名空间，撞名的那份直接不挂、只留一行
警告，而被撞掉的常常是新那份——症状是 agent 读到旧的、照着做但做错了，最难查。
知识随插件走，别人的说明书由那个插件自己挂。

## 钉码与确认

`docfirst check` 守着现状区与生成正本区的论断跟源码一致，也守着生成物跟 mdx 源一致，红了就是
漂了或者没重摆。

被钉住的源码改动过要**先 commit 再 `pnpm doc:confirm`**——git 比较器只对已提交、
工作区干净的内容钉。轨迹区（`content/docs/trajectory/`）**不钉活代码**：它冻结历史，
钉了就变成一份会变黄的现状文档。
