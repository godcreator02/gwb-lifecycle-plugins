---
name: gwb-devkit
description: 写或改 gwb 插件时读——建仓、写插件的红线、改一版看一版（devkit.dev）、测试 home、在隔离 home 里验证与取证；说「验过了」之前也读。
---

# 写 gwb 插件

`@godcreator/gwb-devkit` 是个普通插件，管六件事：建仓（`devkit.scaffold`）、往 workspace 仓加插件
（`devkit.scaffold.plugin`）、结构体检（`devkit.audit-structure`）、测试 home 的开关与删除
（`devkit.home.*`）、改一版看一版（`devkit.dev`）、发正式版（`devkit.release`）；外加一个 CLI
`devkit.cdp`，在工作台页面里操作、截图取证。全部命令与参数形状：
`search {"plugin":"@godcreator/gwb-devkit"}`——usage 是正本，参数给错时回执会把完整说明回给你。

按要做的事找说明：

| 要干什么                                                      | 读哪                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 写插件要守的规矩：依赖怎么写、服务怎么提供和使用、插件之间怎么交互、卸载清理、`gwb.testedKernel` | devkit 文档站「写插件的规矩」（`docs-site/content/docs/rules/`），每条规矩由哪道检查把关也在那儿            |
| 发版、升版本号、改依赖版本号                                            | skill「gwb-release」                                                             |
| 看一个仓（或全生态）离标准结构多远、老式单插件仓怎么迁                               | `devkit.audit-structure`——只读，findings 分级，老式仓收到的 info 就是迁移清单；usage 在 `search` 里 |
| 写带窗格、带界面的插件                                               | 先读 shell 随包发布的 `skill.read {"name":"gwb-shell"}`，再用 `devkit.scaffold` 建仓       |
| 在页面里取证（点、量、截图、跑脚本）                                        | 附件 `references/evidence.md`                                                    |
| 写文档站、记轨迹卡                                                 | skill「docfirst-docs」「trajectory」；建站与启动停止站点读「docs-site」                         |
| 改内核本身                                                     | 内核仓 AGENTS「怎么跑」                                                                |

## 写一个插件的路

写插件只有一条路：**独立一个仓，发进团队源，装进 home**。安装这一步本身就在验证：`exports`
漏一个子路径、`files` 少带一个目录，只有装出来才暴露。

**名字与身份**：是不是插件**不看名字**，看包清单 `keywords` 里的声明：插件写 `["gwb", "gwb-plugin"]`
（`devkit.scaffold` 的模板已带上），库、共享包只写 `["gwb"]` 表示属于这个生态。插件管理的「可装」表按
`gwb-plugin` 这个关键词筛，**不按名字补**，没写这个关键词的包不进表。这个关键词只有 registry 的搜索结果
（`/-/v1/search`）带着，packument 里连 keywords 一起裁掉了，所以判据只在 registry 搜索这一处读得到。
包名与 scope 因此是自由的，第三方可以用自己的 scope 发插件。清单里另有两项：`repository` 填 gitea 上那个仓的
地址（模板里留了注释），发布时 gitea 读它把包关联到仓；`gwb.testedKernel` 写这个插件验过的内核版本，模板写的是
建仓时运行命令的那个内核的版本号，换到别的内核上验过之后再改（见红线 7）。

1. **建仓**：`devkit.scaffold {"name":"<kebab 短名>","dir":"<还不存在的绝对路径>","title":"<显示名>"}`。
   默认连文档站一起建（`docs-site.create` 再 `docfirst.attach`，两条连着跑）。回执的
   `docs.built` / `docs.attached` 是实际结果，照 `nextSteps` 做完。第一次 `pnpm doc:render`
   之前，先把手写 README 里要留的内容搬进 `content/outputs/readme.mdx`——render 会覆盖它

   **只有一种仓结构**：workspace 仓——仓根是一个不发布的 private 包（`pnpm build` / `pnpm check` 在仓根递归到各包），
   插件放在 `plugins/<短名>/`，各自的配置都在包内：

   ```
   repo/
   ├── package.json            # 仓根：gwb-<名>-workspace，private，没有代码
   ├── pnpm-workspace.yaml     # plugins/*（有了不是插件的包再加 packages/*）；不含 docs-site
   ├── AGENTS.md / README.md   # 仓级文档，放在仓根
   ├── plugins/<短名>/         # 插件包：src/ tests/ tsconfig* vitest oxlint 全在包内
   └── docs-site/              # 整个仓一个文档站，自己一套依赖
   ```

   加第二个插件：`devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"}`——用的是同一份插件包
   模板，不改仓根；仓里有装好六区的文档站时，往现状区写一页插件页草稿（`plugins/<短名>.mdx`），
   建仓时站装好六区后也写一页。自述检查要求 `inject` 的服务名出现在现状区里，改插件时把这页跟着改；
   仓根就是插件包的老式单插件仓会被它当场拒，先迁成 workspace 仓再来
2. **先写测试**：能不启动进程、不开窗、只给输入看输出的逻辑，抽成纯函数写进 `tests/`；
   要启动子进程、要 Electron 的，放到下面「装出来验证」那一步。node 侧的测试只 import `.ts`（node 侧的 tsc 没开 jsx）；
   真的启动子进程的用例打 `slow` 标签
3. **写 node 侧**（`src/index.ts`）：`export const name = 'gwb-<短名>'` 加 `apply(ctx)`。能力登记到命令总线：

   ```ts
   ctx.inject(['gwbCommands'], (c) => {
     c.effect(() => c.gwbCommands.register(
       { name: '<短名>.<动作>', plugin: '@godcreator/gwb-<短名>', description: '一句话', usage: '{ entryId, enabled? }' },
       handler))
   })
   ```

   `plugin` 写包名。`usage` 写出一眼能抄的参数形状，无参数就写「无参数」——agent 只看得见这一句。
   handler 的参数是 `unknown`，用 `isRecord` 收窄。词汇表包只提供类型，`isRecord` 与 `requireKernel`
   这两个无状态小函数由插件自带一份（devkit 的 `src/vocab.ts` 就是这样）
4. **改一版看一版**：`devkit.dev` 装进隔离 home，见下一节。完成＝回执 `ok: true`
5. **装出来验证**：见「装出来验证」一节。完成＝四种「看着成了」一条都没犯
6. **发版**：照 skill「gwb-release」。`devkit.release` 构建之后先做发版前检查：自己的版本号不在 0.0.x；
   `@godcreator` 包的 dev 范围包含源上 latest（范围内落后放行，出范围必须先适配）；构建产物里没有空 import；
   包目录里按构建产物的 tsconfig 跑 `tsc --noEmit -p <tsconfig> --skipLibCheck false` 通过（node 侧有
   `tsconfig.build.json` 就用它、没有用 `tsconfig.json`，有 `src/client/tsconfig.json` 再查一次；测试不查）。插件包另查：peer 只有 `cordis`；
   node 侧产物的包名 import 只有 node 内置模块、`electron`、`cordis`，浏览器侧只有 importmap 里的名字；
   `gwb.testedKernel` 和运行中的内核在同一条版本线上（没写、不是版本号、不在同一条线都拒）。没过一个都不发，
   回执一次列全。发之前想看全生态谁落后，调 `devkit.audit-deps`（`out-of-range` 必须处理，`behind` 是范围内
   落后，`peer-not-cordis` 是插件包 peer 里 `cordis` 以外的包）

**改既有仓（加插件、迁移、重构）前后各跑一次 `devkit.audit-structure`**：error 级清零再动手，
收尾时零 error 才算完；老式单插件仓收到的 info 迁移清单照着迁，迁完应零 findings。它只读，不管版本
（那是 audit-deps 与发版前检查）、不管 `description` 的三项自述（repo-kit 守卫）、不管构建产物（产物测试）。

## 改一版看一版：`devkit.dev`

```
devkit.dev {"home":"<home 名>","dir":"<仓根>","packages":["plugins/demo"]}
```

一次七步：核对目标页是哪个 home → 仓根 `pnpm build` → 逐包发开发版（`<patch+1>-dev.<时间戳>`，
tag `dev`，不动 `latest`）→ 在目标 home 的清单里写准确的版本号再 `pnpm install`，读回装上的版本号 → 逐条
`plugin-manager.remount` 重新加载 → 整页重载 → 取证。回执 `ok: true` 才算换上了：装上的是这次发的版本号
（`evidence.installed`）、条目真在运行（ACTIVE）、日志新增的部分里没有 error。

* **第一次**：目标 home 还没有这个插件的条目时，`devkit.dev` 照样发出开发版、装进去，回执 note 说没有条目可重新加载；
  再调 `plugin-manager.install {"pkg":"<包名>","spec":"<回执里那个开发版号>"}` 建条目，之后每次用 `devkit.dev`
* **`packages`** 相对仓根、按依赖序；**workspace 仓必须给**（新仓都是 workspace 仓，只有一个插件也写
  `["plugins/<短名>"]`）——不给就是仓根自己，那是老式单插件仓的含义。同一次发的互相依赖的包，
  依赖写成这次发的准确版本号
* **目标只说 home 名**：端口从那个 home 的 `runtime.json` 查、确认进程还在，连上后再拿页面自报的名字核对
* **开发版只进隔离 home**：目标是 `default` 或 devkit 自己所在的 home，当场拒。换 devkit 自己走发版加一键更新
* **构建与取证都不能跳过**：`files` 白名单里有带通配符的条目时这条链拒发，走 `devkit.release`
* 想看一眼某个 home 的条目表：`devkit.cdp {"args":["<名>","cmd","plugin-manager.list"]}`——那是看，
  不是验证；验证只发生在 `devkit.dev` 里，它手上有「这次之前」的日志长度作基线

## 测试 home

一次验证开一个新 home：`devkit.home.new {"short":"<被测插件短名或这次验什么>"}`，名字是
`<short>-<yyMMddHHmm>`。它启动的是装好的宿主应用，自动挑调试端口，自动装一套基础插件（命令总线、外壳、数据、
设置、说明书、插件管理、基础窗格，加词汇表包；react 与令牌表随 shell 包来），别的插件自己
`plugin-manager.install`。

* 重开已有的：`devkit.home.open {"name"}`；列全部：`devkit.home.list`
* 删：`devkit.home.rm {"name","force?"}`——还在运行的要 `force`；回「已删」时目录已经真不在了
* **清理放在开新 home 的时候**：验完的 home 留给人看，`home.new` 回执里带着现有清单，那时再删旧的
* 日志在 `%APPDATA%\gwb-kernel\homes\<名>\gwb.log`，内核、插件、页面三方的日志都在这一个文件里
* 任何 `pnpm-workspace.yaml` 里都别写 `minimumReleaseAgeExclude`——它会逐项覆盖用户级配置里的同名项

## 装出来验证

typecheck 与 vitest 只检查源码，全绿只说明源码没问题；装出来能不能运行，靠隔离 home 里的这一步。

**验证之前，构建产物要是新的**：改了插件 → 构建再发（模板带 `prepublishOnly`，别删）；
改了 importmap 的提供方（带 `gwb.shared` 的插件，如 shell）→ 重新发版再装；
改了内核 → 走内核仓自己的验证方法。

**四种「看着成了」**，一条都别犯：

1. **拿 `default` 验证**——它是日常用的那个 home，验一次就不干净了
2. **只看「加载了」**——日志里那句加载成功只说明 import 成功、`apply` 被调了；`apply` 里的 async 要自己 catch
   并写日志，再确认它真干了活。哪些条目真在运行看 `plugin-manager.list` 的 `active`（判的是 fiber 真的 ACTIVE）
3. **量颜色时读到过渡中的值**——先加 `transition: none` 再读；读到 `oklab(…)` 就是还在过渡
4. **验证的是上一版**——上面「构建产物要是新的」那三条漏一条，界面全对、验证的却是旧代码

## 红线

每条的做法、例子和由哪道检查把关，见 devkit 文档站「写插件的规矩」里括号中的那一页。

1. **源码里不指回别的仓**：没有 tsconfig `paths`、`link:` / `file:`、跨仓 `workspace:`（「依赖怎么写」）
2. **依赖**：peer 只写宿主提供、构建产物里按值 import 的 `cordis`，其余写 dev；`cordis` 不写进 `dependencies`（「依赖怎么写」）
3. **构建产物里的包名 import** 只能是 node 内置模块、`electron`、`cordis` 与 importmap 里的名字；只引类型写 `import type`（「依赖怎么写」「页面代码与 importmap」）
4. **扩展点用服务、继承 cordis 的 `Service`，数据读写和动作用命令**，同一能力只提供一种调用方式（「cordis 服务怎么提供和使用」）
5. **插件之间只经服务和命令交互**，不 import 别的插件；共享数据格式按区间比对契约版本（「插件之间怎么交互」）
6. **留着 `prepublishOnly: pnpm build`**：少了它手工 publish 会把上一版 `dist/` 原样发出去（「依赖怎么写」）
7. **插件包写 `gwb.testedKernel`**（验过的内核版本），和运行中的内核在同一条版本线上才发得出去（「在哪个内核上测过」）
8. **`gwbKernel` 用 `requireKernel(ctx)` 取、不写进 `inject`；类的私有字段用 TS `private`，不用 `#`**（「cordis 服务怎么提供和使用」）
9. **自己启动或创建的一切，卸载时清理掉并返回 promise**（「卸载清理」）
10. **home 里的包只通过安装来换**：覆盖 `node_modules` 里的 `dist/` 会改到 pnpm 全局存储里的同一份文件（硬链接），node 侧也换不掉（ESM 按 URL 缓存）——改一版看一版走 `devkit.dev`

## 能用什么

**开发一个新插件能基于什么，先问 `devkit.capabilities`**——一次返回三部分，别从零做：

* `inject`：这个 home 此刻提供着的 cordis 服务，各带 `{ summary, usage }`（各包 `package.json` 的
  `gwb.provides` 声明）——要用哪个，照它的 usage 写 `inject`
* `import`：home 里已装的包逐个列出：是插件、库还是第三方包，import 时写的入口路径、
  d.ts 路径（要看具体符号就读 d.ts 原文，命令不摘抄）、importmap 外置名（`shared`）与包自己写的用途说明
* `commands`：插件的命令去 `search {"plugin":"<包名>"}` 里查，这里不重复

包的事实都从各包的 `package.json` 现读（`exports` / `keywords` / `gwb.shared` / d.ts），不另存一份；
只有用途是包自己声明的——**自己要提供新服务或新入口时，照同一口径写 `gwb.provides`**：插件按服务名做键（repo-kit
的自述守卫查它与源码提供的服务名一一对应，对不上 `pnpm check` 就红），库按 import 时写的模块路径做键
（主入口写包名，子路径写 `包名/子路径`）。

内核提供的接口，类型在词汇表包 `@godcreator/gwb-plugin-api`：`gwbKernel` 上四项——`dataDir` /
`version` / `emit(payload)` / `setShell(url)`；页面上的 `window.gwb` 类型也在那儿。

| 能力     | 服务                                      | 什么时候要                      |
| ------ | --------------------------------------- | -------------------------- |
| 命令总线   | `gwbCommands`                           | 能力要被调用（几乎一定）               |
| 说明书    | `gwbSkills`                             | 有流程或坑要讲给 agent             |
| 设置     | `gwbSettings`                           | 插件的一切可配项                   |
| 数据     | `gwbData`                               | 要把状态写到磁盘                   |
| 窗格     | `gwbShell`                              | 要人看得见，先读 skill「gwb-shell」  |
| 外部 CLI | `gwbNodeCli` / `gwbPyCli`               | CLI 形态的东西，登记后自动变成同名的总线命令   |
| 日志     | `ctx.logger(name)`（cordis 自带，不用 inject） | 插件写日志的正规方式，进 gwb.log 与日志窗格 |

方法签名：`import type {} from '<那个包>'` 之后看编辑器补全；包都随包发 `src`，读源码也行。

* **inject 三种写法**（`export const inject`、`static inject`、`ctx.inject([...], fn)`）各在什么时候用，见 devkit 文档站「写插件的规矩」的「cordis 服务怎么提供和使用」
* **服务名** `gwb` 开头的小驼峰，跟插件名对应；`ctx.provide` 包在 `ctx.effect` 里（卸载时自动撤销）。同名的第二个服务注册不上
* **配置一律 `gwbSettings.define`**，条目上只写 `id`
* **重新加载只重跑 `apply`**：每次重新加载都该清掉的状态放 `apply` 里，要跨越重新加载保留的放模块顶层

## 说明书放在哪个插件

知识跟着它描述的代码走——**会因为某行代码改动而过期的说明书，跟那段代码同仓同提交**，随那个包发。
不描述代码的通用纪律随 docfirst 插件发；点名宿主能力的纪律放在宿主那边。说明书是全局单一命名空间，
每个插件只登记自己的那份。

## 原理与踩过的坑

为什么这么定、踩过什么坑，在 devkit 仓的文档站（`D:\unitfolders\s28bv-gwbbase\gwb-devkit\docs-site`）；
退役的命令与参数名在它的术语表。自己踩到的新坑记进自己仓的文档站。
