---
name: gwb-devkit
description: 写或改 gwb 插件时读——建仓、改一版看一版（devkit.dev）、测试 home、验机取证；说「验过了」之前也读。
---

# 写 gwb 插件

`@godcreator/gwb-devkit` 是个普通插件，管六件事：建仓（`devkit.scaffold`）、往薄壳仓加件
（`devkit.scaffold.plugin`）、结构体检（`devkit.audit-structure`）、测试 home 的开收
（`devkit.home.*`）、改一版看一版（`devkit.dev`）、发正式版（`devkit.release`）；外加一支 CLI
`devkit.cdp`，在工作台页面里动手取证。全部命令与
参数形状：`search {"plugin":"@godcreator/gwb-devkit"}`——usage 是正本，参数给错时回执会把完整
说明回给你。

按活找说明书：

| 要干什么                    | 读哪                                                                           |
| ----------------------- | ---------------------------------------------------------------------------- |
| 发版、抬版本号、改依赖版本号          | skill「gwb-release」                                                           |
| 看一个仓（或全生态）离标准形多远、裸根仓怎么迁 | `devkit.audit-structure`——只读，findings 分级，裸根仓的 info 就是迁移清单；usage 在 `search` 里 |
| 写带窗格、带界面的插件             | 先读 shell 随包发布的 `skill.read {"name":"gwb-shell"}`，再用本件脚手架                     |
| 在页面里取证（点、量、截图、跑脚本）      | 附件 `references/evidence.md`                                                  |
| 写文档站、记轨迹卡               | skill「docfirst-docs」「trajectory」；铺站与起停读「docs-site」                           |
| 改内核本身                   | 内核仓 AGENTS「怎么跑」                                                              |

## 写一个插件的路

写插件只有一条路：**独立一个仓，发进团队源，装进 home**。装这个动作本身就在验：`exports`
漏一个子路径、`files` 少带一个目录，只有装出来才现形。

**名字与身份**（2026-09-18 起）：是不是「件」**不看名字**——包在 manifest 的 `keywords` 里
自报家门：件写 `["gwb", "gwb-plugin"]`（`devkit.scaffold` 的模板已带上；lib / 共享包这类
只写 `["gwb"]` 标生态归属）。`plugin-manager` 的「可装」表按 `gwb-plugin` 这枚词筛，
**没有名字回退**——没写这枚词的包不进表。这一格**只有 registry 的搜索回执（`/-/v1/search`）
带**——packument 连 keywords 一起裁掉（2026-09-18 实测），所以判据在 registry 侧读得到，且只有一处。
包名与 scope 因此是自由的——第三方可以用自己的 scope 发件。清单里另有一条 `repository`
（模板里留了注释）：填 gitea 上那个仓的地址，发布时 gitea 读它把包链到仓。

1. **建仓**：`devkit.scaffold {"name":"<kebab 短名>","dir":"<还不存在的绝对路径>","title":"<显示名>"}`。
   默认连文档站一起铺（`docs-site.create` 再 `docfirst.attach`，两条连着跑）。回执的
   `docs.built` / `docs.attached` 是真相，照 `nextSteps` 做到底。第一次 `pnpm doc:render`
   之前，先把手写 README 里要留的内容搬进 `content/outputs/readme.mdx`——render 会覆盖它

   **只有一种仓形**：薄壳 workspace——根是 private 壳（`pnpm build` / `pnpm check` 在仓根递归），
   件住 `plugins/<短名>/`，包内自足：

   ```
   repo/
   ├── package.json            # 薄壳：gwb-<名>-workspace，private，无代码
   ├── pnpm-workspace.yaml     # plugins/*（长出非件包再加 packages/*）；docs-site 不收
   ├── AGENTS.md / README.md   # 仓级，住根
   ├── plugins/<短名>/         # 件包：src/ tests/ tsconfig* vitest oxlint 全在包内
   └── docs-site/              # 一份站盖全仓，自己一套依赖
   ```

   加第二个件：`devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"}`——落的是同一份件包
   模板，不碰根壳与站；老裸根单件仓（仓根即包根）会被它当场拒，先迁成薄壳再来
2. **先写测试**：能不起进程、不开窗、只喂输入看输出的逻辑，抽成纯函数写进 `tests/`；
   要起子进程、要 Electron 的，走下面的验机。node 半的测试只 import `.ts`（node 半的 tsc 没开 jsx）；
   真起子进程的用例打 `slow` 标签
3. **写 node 半**（`src/index.ts`）：`export const name = 'gwb-<短名>'` 加 `apply(ctx)`。能力挂到命令总线：

   ```ts
   ctx.inject(['gwbCommands'], (c) => {
     c.effect(() => c.gwbCommands.register(
       { name: '<短名>.<动作>', plugin: '@godcreator/gwb-<短名>', description: '一句话', usage: '{ entryId, enabled? }' },
       handler))
   })
   ```

   `plugin` 写包名。`usage` 写出一眼能抄的参数形状，无参数就写「无参数」——agent 只看得见这一句。
   handler 的参数是 `unknown`，用词汇表包的 `isRecord` 收窄
4. **内循环**：`devkit.dev` 进隔离 home，见下一节。完成＝回执 `ok: true`
5. **验机**：见「验机」一节。完成＝四种假验收一条不沾
6. **发版**：照 skill「gwb-release」。`devkit.release` 构建之后先上车检票（自己不在 0.0.x、`@godcreator`
   的 peer 写 `^<dev 下限>`、dev 范围罩得住源上 latest——范围内不追、出范围必追），没过一个都不发、回执一次列全；发之前想看全生态谁欠着，
   `devkit.audit-deps`（`out-of-range` 必须追，`behind` 范围内落后，`peer-not-caret` 还没迁 `^`）

**改既有仓（加件、迁移、重构）前后各跑一次 `devkit.audit-structure`**：error 级清零再动手，
收工时零 error 才算完；裸根仓收到的 info 迁移清单照着迁，迁完应零 findings。它只读、不管版本
（那是 audit-deps 与检票）、不管自述三格（repo-kit 守卫）、不管产物（artifact 测试）。

## 改一版看一版：`devkit.dev`

```
devkit.dev {"home":"<home 名>","dir":"<仓根>","packages":["plugins/demo"]}
```

一趟七步：核对目标页是哪个 home → 仓根 `pnpm build` → 逐包发开发版（`<patch+1>-dev.<戳>`，
tag `dev`，不动 `latest`）→ 目标 home 清单写准确号再 `pnpm install`，读回装上的号 → 逐条
`plugin-manager.remount` 重挂 → 整页重载 → 取证。回执 `ok: true` 才算换上了：装上的是这一趟的号
（`evidence.installed`）、条目真 ACTIVE、日志增量里没有 error。

* **第一次**：目标 home 还没有这个件的条目时，`devkit.dev` 照样发出开发版、装进去，回执 note 说没有条目可挂；
  再调 `plugin-manager.install {"pkg":"<包名>","spec":"<回执里那个 dev 号>"}` 建条目，之后每趟 `devkit.dev`
* **`packages`** 相对仓根、按依赖序；**薄壳仓必给**（新仓都是薄壳，单件也写
  `["plugins/<短名>"]`）——不给就是仓根自己，那是老裸根单件仓的语义。同一趟互相依赖的包，
  依赖钉成这一趟的准确号
* **目标只说 home 名**：端口从那个 home 的 `runtime.json` 查、验活，连上后再拿页面自报的名字核对
* **开发版只进隔离 home**：目标是 `default` 或 devkit 自己所在的 home，当场拒。换 devkit 自己走发版加一键更新
* **构建与取证都不可跳过**：`files` 白名单里有通配正条目时这条链拒发，走 `devkit.release`
* 想现看某个 home 的条目表：`devkit.cdp {"args":["<名>","cmd","plugin-manager.list"]}`——那是看，
  不是验；验只发生在 `devkit.dev` 里，它手上有「这一趟之前」的日志基线

## 测试 home

一次验证开一个新 home：`devkit.home.new {"short":"<被测插件短名或这次验什么>"}`，名字长成
`<short>-<yyMMddHHmm>`。它起的是安装版宿主，自动挑调试端口，自动铺底座（命令总线、外壳、数据、
设置、说明书、插件管理、基础窗格，加三个共享包），其余件自己 `plugin-manager.install`。

* 重开已有的：`devkit.home.open {"name"}`；列全部：`devkit.home.list`
* 删：`devkit.home.rm {"name","force?"}`——还在跑的要 `force`；回「已删」时目录已经真不在了
* **清理放在开新的那一刻**：验完的 home 留给人看，`home.new` 回执里带着现有清单，那时再删旧的
* 日志在 `%APPDATA%\gwb-kernel\homes\<名>\gwb.log`，内核、插件、渲染层三路都在这一份里
* 任何 `pnpm-workspace.yaml` 里都别写 `minimumReleaseAgeExclude`——它逐项盖掉用户级同名那项

## 验机

typecheck 与 vitest 吃源码，全绿只说明源码站得住；装出来能不能跑，靠隔离 home 里的这一步。

**开验之前，产物是新的**：改了插件 → build 再发（模板带 `prepublishOnly`，别删）；
改了共享包（tokens、shared-react）→ 重发再装；改了内核 → 走内核仓自己的验机路子。

**四种「看着成了」**，一条都别沾：

1. **拿 `default` 验**——它是日常那份，验一次就不干净了
2. **只看「挂上了」**——`挂上 xxx` 只说明 import 成功、`apply` 被调了；`apply` 里的 async 自己 catch
   并打日志，再看它真干了活。谁挂上了看 `plugin-manager.list` 的 `active`（判的是 fiber 真 ACTIVE）
3. **量颜色时读到过渡中的值**——先注 `transition: none` 再读；读到 `oklab(…)` 就是还在过渡
4. **验的是上一版**——上面「产物是新的」那三条漏一条，界面全对、验的却是旧代码

## 红线

1. **源码里没有指回别的仓的路径**：没有 tsconfig `paths`、`link:`、跨仓 `workspace:`
2. **cordis 写在 dev**：写进 dependencies，home 里就有第二份实例，Service 身份对不上、挂不上，报错不指根因
3. **依赖三档**：运行时真 import → peer；只 import type 但出现在导出的类型面 → peer；只在实现内部用类型 → dev
4. **产物给 node 直接加载**：相对 import 带 `.js`；每个裸名 import 都在 `dependencies` / `peerDependencies` 里
5. **`requireKernel(ctx)` 直接取**：`gwbKernel` 在根上下文、永不撤销，不写进 `inject`
6. **`prepublishOnly: pnpm build` 留着**：少了它 publish 会把上一版 `dist/` 原样发出去
7. **类的私有字段用 TS `private`**：cordis 派生 `Object.create(this)`，`#` 槽在派生对象上读就炸
8. **home 里的包只经安装换**：覆盖 `dist/` 进 `node_modules` 会写穿 pnpm 全局仓（硬链接），
   node 半也换不动（ESM 按 URL 缓存）——改一版看一版走 `devkit.dev`

## 能力面

**开发一个新插件能基于什么，先问 `devkit.capabilities`**——一站回三段，别孤零零从零做：

* `inject`：这台 home 现挂的 cordis 服务，各带 `{ summary, usage }`（各包 `package.json` 的
  `gwb.provides` 声明）——要接一面照 usage 写 `inject`
* `import`：home 已装包逐个列——身份（件 / 库 / 第三方）、import 时写的入口说明符、
  d.ts 路径（**符号级读原文**，命令不摘抄）、importmap 外置名（`shared`）与意图自述
* `commands`：件暴露的命令面指 `search {"plugin":"<包名>"}`——那是命令的家，不重复

事实现算不抄（`exports` / `keywords` / `gwb.shared` / d.ts 全部从包的 `package.json` 现读）；
意图才是声明的——**自己要提供新面时照同一口径写 `gwb.provides`**：件按服务名做键（repo-kit
的自述守卫钉着互为充要，漂了 `pnpm check` 红），包按 import 时写的模块说明符做键
（主入口=包名、子路径=`包名/子路径`）。

内核给的面在词汇表包 `@godcreator/gwb-plugin-api`：`gwbKernel` 上四样——`dataDir` /
`version` / `emit(payload)` / `setShell(url)`；页面上的 `window.gwb` 类型也在那儿。

| 面      | 服务                                    | 什么时候要                     |
| ------ | ------------------------------------- | ------------------------- |
| 命令总线   | `gwbCommands`                         | 能力要被调（几乎一定）               |
| 说明书    | `gwbSkills`                           | 有流程或坑要讲给 agent            |
| 设置     | `gwbSettings`                         | 插件的一切可配项                  |
| 数据     | `gwbData`                             | 要落盘状态                     |
| 窗格     | `gwbShell`                            | 要人看得见，先读 skill「gwb-shell」 |
| 外部 CLI | `gwbNodeCli` / `gwbPyCli`             | CLI 形态的东西，自动镜像成总线命令       |
| 日志     | `ctx.logger(name)`（cordis 面，不 inject） | 件说话的正规出口，进 gwb.log 与日志窗格  |

深一层的方法签名：`import type {} from '<那个包>'`，补全就是说明书（包都发 `src`，
读源码同效）。

* **inject 三种写法**：`export const inject = [...]` 硬依赖，服务不在插件就不挂；`static inject`（Service 类）；
  `ctx.inject([...], fn)` 局部可选，缺了主插件照挂
* **服务名** `gwb` 开头的小驼峰，跟插件名对应；provide 包在 `ctx.effect` 里（卸载时自动撤）。同名第二个 provide 挂不上
* **配置一律 `gwbSettings.define`**，条目上只写 `id`
* **重挂只重跑 `apply`**：该随重挂清掉的状态放 `apply` 里，该跨重挂留着的放模块顶层

## 说明书住哪个插件

知识跟着它描述的代码走——**会因为某行代码改动而过期的说明书，跟那段代码同仓同提交**，随那个包发。
不描述代码的通用纪律随 docfirst 插件发；点名宿主能力的纪律住宿主那边。说明书是全局单一命名空间，
每个插件只挂自己的那份。

## 原理与撞墙

为什么这么定、撞过什么，在 devkit 仓的文档站（`D:\unitfolders\s28bv-gwbbase\gwb-devkit\docs-site`）；
退役的命令与参数名在它的术语表。自己撞到的新墙记进自己仓的文档站。
