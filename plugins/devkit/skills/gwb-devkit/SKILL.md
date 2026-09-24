---
name: gwb-devkit
description: 写新插件、改插件、在隔离 home 里验证改动时读；说「验过了」之前也读。
---

# 写 gwb 插件

## 新写一个插件

1. 调 `devkit.capabilities`：看这个 home 提供哪些服务（`inject` 段带各自的 usage）、已装的包有哪些 import 入口与类型文件。要用的能力已经有了就接上它
2. 带界面的插件，先读外壳的说明书 `skill.read {"name":"gwb-shell"}`
3. 建仓：`devkit.scaffold {"name":"<kebab 短名>","dir":"<还不存在的绝对路径>","title":"<显示名>"}`；往已有的 workspace 仓再加一个插件用 `devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"}`。照回执里的 `nextSteps` 做完（`docs.built` / `docs.attached` 是文档站实际建成没有）
4. 把模板改成真插件，每一处都守「写插件的规矩」：
   * `src/index.ts`：模板的 `<短名>.ping` 与窗格 `main` 换成真正的命令与窗格。命令照模板那条的写法登记：`plugin` 写包名，`description` 一句话说做什么，参数形状写进 `usage`，无参数写「无参数」
   * `tests/`：不启动进程、不开窗就能测的逻辑抽成纯函数来测；真要启动子进程的用例打 `slow` 标签。模板的 `tests/plugin.test.ts` 不用改：repo-kit 的插件守卫只查插件名与包名对得上、`apply` 在替身上能运行、每条命令的 `plugin` 与 `description`、`usage`、每个窗格的 `id` 与地址，不管有几个窗格、几条命令。`apply` 用到替身没有的成员（替身只有 logger、effect、inject、`gwbShell.registerPane`、`gwbCommands.register`）时守卫会失败，这时把 `tests/plugin.test.ts` 改成自己造替身写断言；本仓特有的断言用 repo-kit 的 `mountHarness` 写
   * `package.json`：`description` 里「服务 / skill / 命令」三项跟着实际数目改；提供服务就在 `gwb.provides` 里按服务名写一条；有了 `skills/` 目录就把 `skills` 加进 `files`
   * 文档站的插件页 `docs-site/content/docs/plugins/<短名>.mdx`：写出 `src/index.ts` 里 `inject` 的每个服务名
5. 仓根 `pnpm build`，再 `pnpm check`

**完成判据**：仓根 `pnpm check` 全绿。接着做「改一版看一版」。

## 改已有插件

1. 仓根调 `devkit.audit-structure {"dir":"<仓根>"}`：error 级先清零；仓根就是插件包的旧布局仓，照 findings 里那条 info 列好的 `git mv` 清单迁成 workspace 仓
2. 改代码，守「写插件的规矩」。加减了命令、服务、说明书，同步改 `description` 的三项、`gwb.provides` 与文档站插件页（同第一节第 4 步）
3. 仓根 `pnpm build`、`pnpm check`，再调一次 `devkit.audit-structure`

**完成判据**：`pnpm check` 全绿，`devkit.audit-structure` 零 error。接着做「改一版看一版」。

## 改一版看一版

1. 开一个隔离 home：`devkit.home.new {"short":"<插件短名或这次验什么>"}`，回执里是 home 名 `<short>-<yyMMddHHmm>`，自带一套基础插件。机器重启后回到已有的 home 用 `devkit.home.open {"name":"<名>"}`。回执里带着现有 home 清单，验完的旧 home 这时用 `devkit.home.rm {"name":"<名>","force":true}` 删掉
2. `devkit.dev {"home":"<home 名>","dir":"<仓根>","packages":["plugins/<短名>"]}`。`packages` 相对仓根、按依赖顺序（被依赖的在前），workspace 仓必须给
3. 目标 home 里还没有这个插件的条目时，回执的 note 说没有条目可重新加载。在那个 home 里建条目：
   `devkit.cdp {"args":["<home 名>","cmd","plugin-manager.install","{\"pkg\":\"<包名>\",\"spec\":\"<回执里的开发版号>\"}"]}`，再调一次第 2 步
4. 在那个 home 里调新写的命令看回执：`devkit.cdp {"args":["<home 名>","cmd","<命令名>","<JSON 参数>"]}`；界面上的效果按「在页面里取证」做

**完成判据**：`devkit.dev` 回执 `ok: true`（`evidence.installed` 是这次发的开发版号、条目 `ACTIVE`、日志新增部分没有 error）；`devkit.cdp … cmd plugin-manager.list` 里这个包的条目 `active` 为 true、版本是这次的开发版号；新命令的回执与预期一致。

## 在页面里取证

1. 读附件：`skill.read {"name":"gwb-devkit","file":"references/evidence.md"}`
2. 用 `devkit.cdp` 在隔离 home 的页面里点击、读数、截图，读数与截图文件路径都在回执里

**完成判据**：`eval` 的读数与预期一致；截图（回执 `file`）里看得到要验证的界面状态。

## 发版

照说明书 `gwb-release`（`skill.read {"name":"gwb-release"}`）做，完成判据也在那里。

## 写插件的规矩

规矩总表在附件 `references/rules.md`（`skill.read {"name":"gwb-devkit","file":"references/rules.md"}`），一条一行，写着每条由哪道检查把关。表里的链接 `/docs/rules/<页>` 对应 devkit 仓 `docs-site/content/docs/rules/<页>.mdx`（仓的位置用 `unit-folder.list` 查），每条的做法与例子在那一页。

## 参考：约定与坑

* **是不是插件看 `keywords`**：插件写 `["gwb", "gwb-plugin"]`（模板已带），库与共享包只写 `["gwb"]`。插件管理的「可装」列表按 `gwb-plugin` 筛
* **词汇表包 `@godcreator/gwb-plugin-api` 只有类型**：`isRecord`、`requireKernel` 这类无状态小函数由插件自带一份（devkit 的 `src/vocab.ts`）
* **node 侧的测试只 import `.ts`**：node 侧的 tsc 没开 jsx
* **`apply` 里的 async 自己 catch 并写日志**：reject 了不报错，现象是「加载了但什么都没发生」
* **重新加载只重跑 `apply`**：每次重新加载都该清掉的状态放在 `apply` 里，要跨重新加载保留的放在模块顶层
* **`gwb.provides` 的键**：插件按服务名，库按 import 时写的模块路径（主入口写包名，子路径写 `包名/子路径`）
* **说明书跟它描述的代码同仓同提交**，随那个包发布；每个插件只登记自己的说明书
* **文档站的 README**：第一次在站目录 `pnpm doc:render` 之前，把手写 README 里要留的内容搬进 `content/outputs/readme.mdx`，render 会整份覆盖 README
* **验证的必须是这一版**：改了 importmap 的提供方（带 `gwb.shared` 的插件，如外壳），它也要经 `devkit.dev` 装进同一个隔离 home；改了内核走内核仓自己的验证流程，隔离 home 运行的是装好的宿主应用
* **日志**：`%APPDATA%\gwb-kernel\homes\<home 名>\gwb.log`，内核、插件、页面三方的日志都在这一个文件里；哪些条目在运行看 `plugin-manager.list` 的 `active`
* **home 里的包只通过安装来换**：`devkit.dev` 每次发新的开发版号再装。覆盖 `node_modules` 里的 `dist/` 会改到 pnpm 全局存储里的同一份文件，node 侧也换不掉
