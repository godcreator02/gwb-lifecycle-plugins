---
name: gwb-devkit
description: 写新插件、改插件、在隔离 home 里验证改动时读；说「验过了」之前也读。
---

# 写 gwb 插件

## 新写一个插件

1. 看提供方插件的类型声明：它导出的类型、给 cordis 的 `Context` 补的项（包里 `.d.ts` 的 `declare module 'cordis' { interface Context { … } }`），方法签名与文档注释就在那里。要用的能力已经有了就直接用它：peer 里写上提供方，`import type` 它的类型，`ctx.inject` 取用
2. 带界面的插件，先读外壳的说明书 `skill.read {"name":"gwb-shell"}`
3. 建仓：`devkit.scaffold {"name":"<kebab 短名>","dir":"<还不存在的绝对路径>"}`；往已有的 workspace 仓再加一个插件用 `devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"}`。回执 `nextSteps` 里是这个仓特有的：仓与插件包在哪。建仓只写插件的文件，不建文档站；模板里要显示名的地方（README 标题、`description`、窗格标题）都是短名，要中文名自己改。没有团队源（`@godcreator`）发布权限就两条都加 `"scope":"@<你的范围>","registry":"<你的源的地址，如 http://localhost:4873/>"`：包名成了 `<scope>/gwb-<短名>`，`registry` 写进插件包的 `publishConfig.registry`，`devkit.release` 发到那里；发布 token 写在用户级 `~/.npmrc`。同一个仓里的插件用同一套
4. 把模板改成真插件，每一处都守「写插件的规矩」：
   * `src/index.ts`：模板的 `<短名>.ping` 与窗格 `main` 换成真正的命令与窗格。命令照模板那条的写法登记：`name`、`description`、`usage` 都是非空字符串，`description` 一句话说做什么，参数形状写进 `usage`，无参数写「无参数」；不写 `plugin`，命令总线从调用方取包名。缺字段时命令总线在登记时抛错，插件加载失败
   * `tests/`：不启动进程、不开窗口就能测的逻辑抽成纯函数来测。模板带的 `tests/prefix.test.ts`（类名前缀）与 `tests/artifact.test.ts`（构建产物）不用改。`prefix.test.ts` 报「前缀要排在最前」时照它写的改法改：前缀排在所有变体前面（`<前缀>:disabled:opacity-50`），写反了 Tailwind 不报错、只是一条规则都不出
   * `package.json`：peer 里内核包 `@godcreator/gwb-kernel-desktop` 的范围 `^x.y.z` 要包含验证时用的内核（模板写的是运行建仓命令的那个 home 里的内核）；用到的别的插件（经 `ctx.inject` 用它的服务、import 它的类型）写进 peer，范围 `^x.y.z`，不另写 dev：写在 `export const inject` 里的是普通 peer，只在 `ctx.inject([...], fn)` 里用的在 `peerDependenciesMeta` 标 `optional: true`。模板已写命令总线与外壳，下限是建仓那个 home 里装着的版本；不用外壳就删掉那一项；`description` 改成一句话说这个插件做什么；有了 `skills/` 目录就把 `skills` 加进 `files`
   * 提供服务：在源码里给 cordis 的 `Context` 补上这一项（`declare module 'cordis' { interface Context { gwbExample: GwbExample } }`），`GwbExample` 定义在本包里、写文档注释说清怎么用；用它的插件从你发布的 `.d.ts` 读到这些
   * 仓里有文档站的，在它的现状区写这个插件的页：功能、接口、依赖、不做的事四节
5. 仓根 `pnpm build`，再 `pnpm check`

**完成判据**：仓根 `pnpm check` 全绿。接着做「改一版看一版」。

## 改已有插件

1. 仓得是 workspace 布局：仓根是 `private: true` 的 `package.json`，`pnpm-workspace.yaml` 的 `packages` 里有 `plugins/*`，插件包在 `plugins/<短名>/`。不是的先照 `devkit.scaffold` 生成的仓迁过来——`devkit.dev`、`devkit.release` 只收 `packages` 里列出的包目录，`devkit.scaffold.plugin` 也只认这种仓
2. 改代码，守「写插件的规矩」。加减了服务，同步改类型声明里给 `Context` 补的那几项；加减了命令、服务、说明书，仓里有文档站的同步改那个插件的页（同第一节第 4 步）
3. 仓根 `pnpm build`、`pnpm check`

**完成判据**：`pnpm check` 全绿。接着做「改一版看一版」。

## 改一版看一版

1. 开一个隔离 home：`devkit.home.new {"short":"<插件短名或这次验什么>"}`，回执里是 home 名 `<short>-<yyMMddHHmm>`，自带内核包（运行这条命令的内核那个版本）、`cordis` 与一套基础插件。机器重启后回到已有的 home 用 `devkit.home.open {"name":"<名>"}`。现有的 home 用 `devkit.home.list` 列出，验完的旧 home 用 `devkit.home.rm {"name":"<名>","force":true}` 删掉
2. `devkit.dev {"home":"<home 名>","dir":"<仓根>","packages":["plugins/<短名>"]}`。`packages` 必给，相对仓根，只给插件与内核包的目录（库打包进用它的插件，给了直接拒）。它把每个包打成包文件放进那个 home 的 `dev-packs`，经那个 home 的插件管理装：已装的包走 `plugin-manager.update`，还没装的插件走 `plugin-manager.install` 新建条目，不用自己建
3. 在那个 home 里调新写的命令看回执：`devkit.cdp {"args":["<home 名>","cmd","<命令名>","<JSON 参数>"]}`；界面上的效果按「在页面里取证」做

**完成判据**：`devkit.dev` 回执 `ok: true`（`evidence.installed` 是这次打包的开发版号、条目 `ACTIVE`、日志新增部分没有 error）；`devkit.cdp … cmd plugin-manager.list` 里这个包的条目 `active` 为 true、版本是这次的开发版号；新命令的回执与预期一致。

## 在页面里取证

1. 读附件：`skill.read {"name":"gwb-devkit","file":"references/evidence.md"}`
2. 用 `devkit.cdp` 在隔离 home 的页面里点击、读数、截图，读数与截图文件路径都在回执里

**完成判据**：`eval` 的读数与预期一致；截图（回执 `file`）里看得到要验证的界面状态。

## 发版

照说明书 `gwb-release`（`skill.read {"name":"gwb-release"}`）做，完成判据也在那里。

## 写插件的规矩

规矩总表在附件 `references/rules.md`（`skill.read {"name":"gwb-devkit","file":"references/rules.md"}`），一条一行，写着每条由哪道检查负责。表里的链接 `/docs/rules/<页>` 对应 `gwb-lifecycle-plugins` 仓（包 `@godcreator/gwb-devkit` 的源码仓）`docs-site/content/docs/rules/<页>.mdx`（仓的位置用 `unit-folder.list` 查），每条的做法与例子在那一页。

## 参考：约定与容易出错的地方

* **是不是插件看 `keywords`**：插件写 `["gwb", "gwb-plugin"]`（模板已带），库只写 `["gwb"]`。`plugin-manager.search`（插件管理窗格的「可装」列表就是它）按 `gwb-plugin` 筛，不看包名范围
* **包名与发到哪用 npm 的标准字段**：包的身份是 `package.json` 的 `name`，发到哪是 `publishConfig.registry`（每个要发的包都得写，没写 `devkit.release` 就拒发；模板已写）。别的包名范围的插件要装进 home，那个范围的源得先配进 `~/.npmrc`（照说明书 `gwb-plugin-manager` 的「配第三方包源」）
* **内核的接口类型从内核包的包根 `import type`**：`import type { GwbContext } from '@godcreator/gwb-kernel-desktop'`，peer 里写着内核包，不另写 dev。包根只导出类型，`isRecord`、`requireKernel` 这类无状态小函数由插件自带一份（devkit 的 `src/vocab.ts`）
* **node 侧的测试只 import `.ts`**：node 侧的 tsc 没开 jsx
* **`apply` 里的 async 自己 catch 并写日志**：reject 了不报错，现象是「加载了但什么都没发生」
* **重新加载只重新运行 `apply`**：每次重新加载都该清掉的状态放在 `apply` 里，要跨重新加载保留的放在模块顶层
* **说明书跟它描述的代码同仓同提交**，随那个包发布；每个插件只登记自己的说明书
* **文档站的 README**：第一次在站目录 `pnpm doc:render` 之前，把手写 README 里要留的内容搬进 `content/outputs/readme.mdx`，render 会整份覆盖 README
* **页面 importmap 里只有 react 的四个包名**，写死在内核包的页面入口 `dist/index.html` 里，别的包加不进名字：别的依赖一律打包进浏览器侧产物；模板的 `build.ts` 从那段 importmap 读外置名单，不手抄
* **验证的必须是这一版**：改了内核（页面 importmap 里的 react 也由它提供）同样用 `devkit.dev`：`dir` 给内核仓根、`packages` 给 `["apps/desktop"]`，它把内核开发版装进隔离 home（`cordis` 由那个 home 的插件管理照内核包 peer 里写的版本对齐），再重启那个 home（主进程里的内核换不掉），回执 `kernel.version` 就是页面上运行的内核版本；没装过内核开发版的隔离 home 里运行的是 `devkit.home.new` 装进去的内核包
* **日志**：`%APPDATA%\gwb-kernel\homes\<home 名>\gwb.log`，内核、插件、页面三方的日志都在这一个文件里；哪些条目在运行看 `plugin-manager.list` 的 `active`
* **一个隔离 home 同一时间只给一个会话用**：每个会话用自己的 `short`，不拿别的会话开的 home 来验。`devkit.dev` 经那个 home 的插件管理装包，同时来的第二个改动回 `BUSY`
* **home 里的包只通过安装来换**：`devkit.dev` 每次换一个新的开发版号、打一个新的包文件再装。覆盖 `node_modules` 里的 `dist/` 会改到 pnpm 全局存储里的同一份文件，node 侧也换不掉
* **别动隔离 home 里的 `dev-packs` 目录**：home 清单引用着那里的包文件，删了之后这个 home 里的 `pnpm add`（插件管理的安装与升级）全部失败；覆盖写同一个包文件，pnpm 照样装着旧代码
