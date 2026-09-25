# 写插件的规矩

**本页回答**：写一个 gwb 插件要守哪些规矩；每条由哪道检查负责、哪些只能靠人守；这个仓自己哪些还没照做。

规矩对新写的插件和这次改到的插件都生效。每条的做法、理由和例子在分页里，本页只列总表。这一页同时生成说明书 `gwb-devkit` 的附件 `references/rules.md`。

两件事不在这一组页里：

* **版本号升哪一位**：照说明书 `gwb-release`（`skill.read {"name":"gwb-release"}`），全生态一套
* **一件事该进内核还是做成插件**：判据在内核仓文档站的「关键设计」页——只有第一个插件运行之前必须完成的事才进内核，其余一律做成插件

写一个新插件，先读[依赖怎么写](/docs/rules/deps)和[cordis 服务怎么提供和使用](/docs/rules/services)，再读[卸载清理](/docs/rules/dispose)；要和别的插件打交道时读[插件之间怎么交互](/docs/rules/interaction)与[用到的插件写 peer](/docs/rules/plugin-peers)；带界面的读[页面代码与 importmap](/docs/rules/importmap)；发版之前读[兼容哪个内核](/docs/rules/kernel-compat)。

## 有哪些检查

| 检查                                  | 什么时候运行                                | 没过会怎样         |
| ----------------------------------- | ------------------------------------- | ------------- |
| `devkit.release` 的发版前检查             | 构建之后、发第一个包之前                          | 一个包都不发，回执按包列全 |
| 模板带的产物测试 `tests/artifact.test.ts`   | 构建之后运行 `pnpm check`（没有 `dist/` 时整组跳过） | 测试红           |
| 模板带的类名前缀测试 `tests/prefix.test.ts`   | 每次 `pnpm check`（当场编译样式入口，不用先构建）       | 测试红           |
| 命令总线登记命令时的检查（`gwbCommands` 0.5.0 起） | 插件的 `apply` 里调 `register` 时           | 抛错，插件加载失败     |
| 外壳登记窗格时的检查（`gwbShell` 0.13.6 起）     | 插件调 `registerPane` 时                  | 抛错，插件加载失败     |
| `plugin-manager.list` 的报告           | 在 home 里随时问                           | 只报告，不拦加载      |

两份模板测试由 `devkit.scaffold` 生成进每个插件包。发版前检查查什么、按什么判，见[发正式版](/docs/devkit/release)。

## 总表

「由谁检查」一栏写「没有工具检查」的，只靠写插件的人自己守。

| 规矩                                                                                                                      | 做法见                                     | 由谁检查                                                                                                                 | 查不到的部分                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| peer 只写运行时从 home 里得到的三类包——构建产物里按值 import 的 `cordis`、内核包 `@godcreator/gwb-kernel-desktop`、用到的别的插件，其余写 dev                | [依赖](/docs/rules/deps)                  | `devkit.release` 拒 peer 里 `cordis`、内核包、插件以外的包（是不是插件读包目录 `node_modules` 里它的清单，读不到也拒）；node 侧产物按值 import 了 peer 里没写的包也拒 | —                                                                          |
| `cordis` 不写进 `dependencies`                                                                                             | [依赖](/docs/rules/deps)                  | 没有专门的检查；按值 import 了 `cordis` 却没写进 peer 时，`devkit.release` 的 node 侧包名 import 检查会拒                                     | 同时写进 peer 与 `dependencies` 查不到                                             |
| `@godcreator` 包的 dev 写 `^` 范围或精确号，范围包含源上最新的正式版                                                                          | [依赖](/docs/rules/deps)                  | `devkit.release` 拒写法认不出、下限比源上 latest 新、latest 已出范围                                                                   | 别的包名范围下的库不查                                                                |
| 构建产物里的包名 import：node 侧只能是 node 内置模块、`electron` 与 peer 里写了的包，浏览器侧只能是页面 importmap 里的名字                                    | [依赖](/docs/rules/deps)                  | `devkit.release` 两侧都查（浏览器侧名单从包目录 `node_modules` 里装好的内核包页面入口读，读不到也拒）；模板带的产物测试同样查两侧                                    | 产物测试只认顶格的静态 import                                                         |
| 类型引用到的包由使用方在 dev 里列全，`skipLibCheck: false` 下类型检查通过                                                                      | [依赖](/docs/rules/deps)                  | 没有工具检查                                                                                                               | 全部                                                                         |
| 只引类型写 `import type`，不写 `import { type X }`                                                                              | [依赖](/docs/rules/deps)                  | `devkit.release` 拒构建产物里的空 import（`import { type X }` 编译后留下的 `import {} from`）                                        | —                                                                          |
| 源码里不指回别的仓：tsconfig `paths` 只有指向包内的 `@/*` 一项，没有 `link:` / `file:` 依赖                                                     | [依赖](/docs/rules/deps)                  | 没有工具检查                                                                                                               | 全部                                                                         |
| node 侧用 tsc 直接输出时，相对 import 带 `.js`                                                                                     | [依赖](/docs/rules/deps)                  | `devkit.release` 拒指向不存在文件的相对 import；模板带的产物测试                                                                         | —                                                                          |
| 留着 `prepublishOnly: pnpm build`，`files` 白名单列全                                                                           | [依赖](/docs/rules/deps)                  | `devkit.release` 照 `files` 验构建产物在不在                                                                                  | `prepublishOnly` 没有工具检查                                                    |
| 浏览器侧只外置页面 importmap 里的名字（react 的四个包名），其余依赖打包进构建产物；外置名单只从内核包页面入口 `dist/index.html` 的 importmap 读，不手抄                     | [importmap](/docs/rules/importmap)      | 外置了别的名字，`devkit.release` 的浏览器侧检查会拒；模板的 `build.ts` 从页面入口读名单                                                           | 手抄名单本身没有检查                                                                 |
| 带界面的插件，`style.css` 的颜色类只用主题令牌（外壳 `theme.reference.css` 与本插件 `@theme` 声明的 `--color-<名>`），不用 Tailwind 出厂调色板               | [importmap](/docs/rules/importmap)      | 模板带的产物测试                                                                                                             | 只查 `text-` / `bg-` / `border-` / `from-` / `via-` / `to-` / `divide-` 开头的类 |
| 带界面的插件，类名一律带本插件的前缀，前缀排在所有变体前面（`<前缀>:disabled:opacity-50`，不写 `disabled:<前缀>:opacity-50`）                                 | 说明书 `gwb-shell`                         | 模板带的类名前缀测试：没带前缀却编得出规则的类、带了前缀却编不出规则的类都报，前缀排在变体后面的单独报并写出改法                                                             | 只查 `src/client` 下 tsx 里的字符串字面量，模板字面量插值里的类名不查                               |
| 窗格的 `client` / `style` 从插件自己的模块地址算（`new URL('./client.js', import.meta.url).href`），是路径以 `.js` / `.css` 结尾的 `file://` 地址 | 说明书 `gwb-shell`                         | 外壳登记窗格时检查                                                                                                            | —                                                                          |
| 扩展点服务继承 cordis 的 `Service`，注册随调用方卸载自动撤销                                                                                 | [服务](/docs/rules/services)              | 没有工具检查                                                                                                               | 全部                                                                         |
| 扩展点用服务，数据读写和动作用命令，同一能力只提供一种调用方式                                                                                         | [服务](/docs/rules/services)              | 没有工具检查                                                                                                               | 全部                                                                         |
| 命令的 `name`、`description`、`usage` 都是非空字符串：`description` 一句话说做什么，参数形状写进 `usage`，无参数写「无参数」；`plugin` 可以不写，写了必须等于自己的完整包名     | [服务](/docs/rules/services)              | 命令总线登记时检查：缺字段、只有空白、`plugin` 与调用方的包名不同都抛错                                                                             | `usage` 写没写对参数形状                                                           |
| 提供服务的插件在自己的类型声明里给 cordis 的 `Context` 补上这一项，服务的类型定义在自己的声明里、带文档注释                                                         | [服务](/docs/rules/services)              | 没有工具检查；`devkit.services` 从各包的 `.d.ts` 读它，没写的服务不在回执里                                                                  | 全部                                                                         |
| `gwbKernel` 用 `requireKernel` 取、不写进 `inject`；不写 `instanceof Service`；类的私有字段用 TS `private`                               | [服务](/docs/rules/services)              | 没有工具检查                                                                                                               | 全部                                                                         |
| 插件之间只通过服务和命令交互，不 import 别的插件                                                                                            | [交互](/docs/rules/interaction)           | 没有工具检查：发版前检查放行 node 侧对 peer 里写了的包的 import，写进 peer 的插件也在其中                                                            | 全部                                                                         |
| 共享磁盘数据格式或命令结构时，按区间比对契约版本，区间外拒绝加载                                                                                        | [交互](/docs/rules/interaction)           | 没有工具检查                                                                                                               | 全部                                                                         |
| 谁提供接口谁定义类型：服务的类型由提供方导出，命令回执的类型有调用方要 import 时才导出（形状以 `usage` 为准）；调用方不手写、不用 `as` 强转成提供方的类型                                | [交互](/docs/rules/interaction)           | 没有工具检查                                                                                                               | 全部                                                                         |
| 插件的数据目录只由它自己读写                                                                                                          | [交互](/docs/rules/interaction)           | 没有工具检查                                                                                                               | 全部                                                                         |
| 自己启动或创建的一切，卸载时清理掉，并返回 promise                                                                                           | [卸载清理](/docs/rules/dispose)             | 没有工具检查                                                                                                               | 全部                                                                         |
| 插件包在 peer 里写内核包 `@godcreator/gwb-kernel-desktop`，范围 `^x.y.z` 包含运行中的内核                                                   | [兼容哪个内核](/docs/rules/kernel-compat)     | `devkit.release` 拒没写、写法不是 `^x.y.z`、范围不包含运行中的内核；`plugin-manager.list` 按包报范围不包含 home 里内核的插件                            | —                                                                          |
| 经 `ctx.inject` 用到、或 import 了类型的别的插件写进 peer，范围 `^x.y.z`，可选使用的在 `peerDependenciesMeta` 标 `optional: true`；不另写 dev         | [用到的插件写 peer](/docs/rules/plugin-peers) | `devkit.release` 拒 peer 里的 gwb 插件写法不是 `^x.y.z`、和源上 latest 不在同一条线；`plugin-manager.list` 按包报 `unmetPeers`              | 用到了却没写进 peer                                                               |
| 0.x 里只在破坏契约时升 x，其余升 y；同一个号不重发                                                                                           | 说明书 `gwb-release`                       | `devkit.release` 拒源上已有的号                                                                                             | 升哪一位                                                                       |

## 这个仓自己还没照做的

插件管理（`plugins/plugin-manager/`）与开发套件的清单都按上面的规矩写：peer 里是内核包与用到的插件。还差两处：

* **插件管理的 dev 暂时列着接口类型包 `@godcreator/gwb-plugin-api`**：命令总线 0.5.0 的类型声明还从它取 `GwbResult`，少了它 `commandBus.run` 的回执成了 error 类型、oxlint 不过。命令总线改成从内核包取类型之后删掉
* **模板的窗格入口手写了外壳传入的参数形状**：`template/pkg/src/client/index.tsx.tpl` 里的 `PaneArgs` 没从外壳 `import type`。外壳发出导出窗格入口类型的正式版之后，改成从外壳取、把模板里外壳的下限升上去

<!-- 来源 ../plugins/devkit/template/pkg/src/client/index.tsx.tpl · 有 interface PaneArgs { · 未确认 -->
