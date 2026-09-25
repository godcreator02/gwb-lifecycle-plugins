# 写插件的规矩

**本页回答**：写一个 gwb 插件要守哪些规矩；每条由哪道检查负责；哪些写法容易出错；这个仓自己哪些还没照做。

规矩对新写的插件和这次改到的插件都生效。总表只收两种：有工具查的，和没有工具查、但违反了一定出事的。别的写法建议在分页里，不进总表。这一页同时生成说明书 `gwb-devkit` 的附件 `references/rules.md`。

两件事不在这一组页里：

* **版本号升哪一位**：照说明书 `gwb-release`（`skill.read {"name":"gwb-release"}`），全生态一套
* **一件事该进内核还是做成插件**：判据在内核仓文档站的「关键设计」页——只有第一个插件运行之前必须完成的事才进内核，其余一律做成插件

写一个新插件，先读[依赖怎么写](/docs/rules/deps)与[用到的插件写 peer](/docs/rules/plugin-peers)，再读[卸载清理](/docs/rules/dispose)，发版之前在文档站写好[插件之间怎么连](/docs/rules/wiring)那一页；带界面的读[页面代码与 importmap](/docs/rules/importmap)；发版之前读[兼容哪个内核](/docs/rules/kernel-compat)。写法建议在[cordis 服务怎么提供和使用](/docs/rules/services)与[插件之间怎么交互](/docs/rules/interaction)。

## 有哪些检查

| 检查                        | 什么时候运行                            | 没过会怎样                   |
| ------------------------- | --------------------------------- | ----------------------- |
| `devkit.dev` 的样式检查        | 构建之后、打包之前（插件有 `dist/style.css` 时） | 回执 `ok: false`，不装进 home |
| `devkit.release` 的发版前检查   | 构建之后、发第一个包之前                      | 一个包都不发，回执按包列全           |
| `plugin-manager.list` 的报告 | 在 home 里随时问                       | 只报告，不拦加载                |

发版前检查查什么、按什么判，见[发正式版](/docs/devkit/release)。命令的字段由命令总线在登记时查，窗格的地址由外壳在登记时查，都是那两个插件自己的规矩，写错了插件加载失败（见说明书 `gwb-shell` 与[登记命令](/docs/rules/services#登记命令)）。

## 总表

| 规矩                                                                                                                                                  | 做法见                                                       | 由谁检查                                                                                                                                               | 查不到的部分                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| peer 只写运行时从 home 里得到的三类包：按值 import 的 `cordis`、内核包 `@godcreator/gwb-kernel-desktop`、用到的别的插件；其余写 dev                                                  | [依赖](/docs/rules/deps)                                    | `devkit.release` 拒 peer 里别的包（是不是插件读包目录 `node_modules` 里它的清单，`keywords` 含 `gwb-plugin` 才算，读不到也拒）                                                    | —                             |
| 构建产物里的包名 import：node 侧只能是 node 内置模块、`electron` 与 peer 里写了的包；浏览器侧只能是页面 importmap 里的名字（react 的四个包名，写死在内核包的页面入口里）。其余依赖打包进产物                            | [依赖](/docs/rules/deps)、[importmap](/docs/rules/importmap) | `devkit.release` 两侧都查，名单从包目录 `node_modules` 里装好的内核包读；模板的 `build.ts` 照这两份名单外置                                                                       | —                             |
| 插件包在 peer 里写内核包，范围 `^x.y.z`，x.y.z 是验证时那个内核的版本                                                                                                       | [兼容哪个内核](/docs/rules/kernel-compat)                       | `devkit.release` 拒没写、写法不是 `^x.y.z`；`plugin-manager.list` 按包报范围不包含 home 里内核的插件                                                                      | 范围包不包含验证时那个内核                 |
| 经 `ctx.inject` 用到、或 import 了类型的别的插件写进 peer，范围 `^x.y.z`；写在 `export const inject` 里的是普通 peer，只在 `ctx.inject([...], fn)` 里用的标 `optional: true`；不另写 dev | [用到的插件写 peer](/docs/rules/plugin-peers)                   | `devkit.release` 拒 peer 里的 gwb 插件写法不是 `^x.y.z`、和源上 latest 不在同一条线，拒源码注入的服务提供方不在 peer 里、必需注入的提供方标了 `optional`；`plugin-manager.list` 按包报 `unmetPeers` | 只用了类型、却没写进 peer；局部注入写成必需 peer |
| 每个插件仓的文档站有 `docs/wiring.mdx`「插件之间怎么连」，按插件写提供、注入、按名字调用与约定通道三张表，钉码按内容钉；源码注入与提供的服务名都在这一页里出现                                                            | [插件之间怎么连写成一页](/docs/rules/wiring)                         | `devkit.release` 拒仓里没有这一页、页里没写到的服务名；注入写法认不出也拒                                                                                                      | 表里写的对不对；按名字调用的命令与约定通道         |
| 带界面的插件：类名一律带本插件的前缀，前缀排在所有变体前面（`<前缀>:disabled:opacity-50`）；颜色类只用主题令牌；`var()` 的 fallback 不写死值                                                         | [importmap](/docs/rules/importmap)、说明书 `gwb-shell`        | `devkit.dev` 构建之后、`devkit.release` 发之前的样式检查                                                                                                        | 模板字面量插值里的类名                   |
| 自己启动或创建的一切，卸载时清理掉，并返回 promise                                                                                                                       | [卸载清理](/docs/rules/dispose)                               | 没有工具检查                                                                                                                                             | 全部                            |
| 0.x 里只在破坏契约时升 x，其余升 y；同一个号不重发                                                                                                                       | 说明书 `gwb-release`                                         | `devkit.release` 拒源上已有的号                                                                                                                           | 升哪一位                          |

## 容易出错的写法

没有工具查，写错了不报错，现象各写在后面：

* **`apply` 里的 async 自己 catch 并写日志**：reject 了不报错，现象是「加载了但什么都没发生」
* **每次重新加载都该清掉的状态放在 `apply` 里**：重新加载只重新运行 `apply`，模块顶层的状态不重置
* **类的私有字段用 TS 的 `private`，不用 `#`**：cordis 派生上下文用 `Object.create(this)`，`#` 字段在派生出来的对象上一读就抛错
* **不写 `instanceof Service`**：插件和宿主用的 cordis 可能是两份拷贝，跨拷贝判断为 false
* **`gwbKernel` 用 `requireKernel(ctx)` 取，不写进 `inject`**：内核接口在根上下文上、永不撤销

细节见[cordis 服务怎么提供和使用](/docs/rules/services#容易出错的几处)。

## 这个仓自己还没照做的

插件管理（`plugins/plugin-manager/`）与开发套件的清单都按上面的规矩写：peer 里是内核包与用到的插件，此刻没有没照做的。

总表只收有工具查的几条，取舍见轨迹卡[写插件的规矩只留有工具查的](/trajectory/2026-09-25-rules-only-checked-ones)。
