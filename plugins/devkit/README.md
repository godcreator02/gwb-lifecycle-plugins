# gwb-devkit

**本页回答**：`@godcreator/gwb-devkit` 是什么、怎么装、怎么确认它加载了、这个仓里还有什么、文档在哪。

## 是什么

god 工作台的开发套件，本身就是**一个普通的插件**：装进 home 才有它的命令，加载不了就什么都没有。它自己也照它教给别人的做法发布：发到团队源、装进 home。

它把「在一个新文件夹里开发一个新插件」这条路上的每一步都做成一个能被 agent 调用的命令：建仓、往仓里加插件、测试 home 的开与删、改一版看一版、发正式版，外加随包发布的写插件说明书与发版规则。**仓的布局只有一种**：pnpm workspace，插件放在 `plugins/<短名>/`，一个插件与多个插件的仓格式相同。

**使用者是 agent，所以它没有界面**：全部结果都在回执里。工作台没启动的时候，还有一个包内命令行脚本可用——`bin/cdp.mjs` 在一个页面里操作。

## 怎么装

```
plugin-manager.install {"pkg":"@godcreator/gwb-devkit"}
```

没有设置项，装完不用配置。确认它加载了，看 `<home>\gwb.log` 里有没有「开发套件就绪」那一行——安装命令回的「装完了」不算。

## 这个仓里还有什么

这个仓叫 `gwb-lifecycle-plugins`，是 pnpm workspace，开发套件在 `plugins/devkit/`，旁边还有一个包：

* `plugins/plugin-manager/`：插件管理 `@godcreator/gwb-plugin-manager`，home 里的一个普通插件，单独发版。两个包互相依赖的地方多（`devkit.dev` 经插件管理装开发版，peer 写法的判定与在 home 里启动 pnpm 的环境只在插件管理里写一份、开发套件 import 它），放在一个仓里，改这些地方一个提交就能改两边；细节见文档站「关键设计」

## 文档

`docs-site/` 是六区文档站：在仓根 `pnpm install` 之后，`cd docs-site && pnpm build && pnpm start`，看 `http://localhost:4322`。现状页的说法引用这个仓的真实源码，`pnpm doc` 核对，失败就是文档和代码不一致了。

从哪读起：入口页讲是什么、写一个插件从头走一遍、按来意读哪几页，末尾是模块索引与接缝表；开发套件看「gwb-devkit · 开发套件」那组页面，插件管理看「gwb-plugin-manager · 插件管理」那组；为什么这么切分看「关键设计」，改这个仓本身看「开发」；写插件的规矩在「写插件的规矩」那组页面；写插件、改插件、在隔离 home 里验证的步骤在随包发布的说明书 `gwb-devkit` 里。这份 README 是生成文件，正本是 `docs-site/content/outputs/readme.mdx`。
