# gwb-devkit

**本页回答**：`@godcreator/gwb-devkit` 是什么、怎么装、怎么确认它在干活、这个仓里还有什么、文档在哪。

## 是什么

god 工作台的开发套件，本身就是**一个普通的插件**：装进 home 才有它的命令，加载不了就什么都没有。它走它教别人走的那条路：发到团队源、装进 home。

它把「在一个新文件夹里开发一个新插件」这条路上的每一步都做成一个能被 agent 调用的命令：建仓、往仓里加插件、结构体检、测试 home 的开与删、改一版看一版、在页面里操作并取证，外加一份随包发布的写插件手册。**仓的布局只有一种**：pnpm workspace，插件放在 `plugins/<短名>/`，一个插件与多个插件的仓格式相同。

**使用者是 agent，所以它没有界面**：全部回执都是给读的人看的。工作台没启动的时候，还有一个包内命令行工具可用——`bin/cdp.mjs` 在一个页面里操作。

## 怎么装

```
plugin-manager.install {"pkg":"@godcreator/gwb-devkit"}
```

装完不用配置——它没有设置项。下一次调 MCP 入口的 `index`，`devkit.*` 那几条命令就在清单里。

## 怎么确认它在干活

看 `<home>\gwb.log` 里那句「开发套件就绪」，它把这一版实际登记上的命令逐条列了出来。那一行才是证据，「装完了」不是。

## 这个仓里还有什么

这个仓是 pnpm workspace，开发套件在 `plugins/devkit/`，旁边还有两个包：

* `plugins/plugin-manager/`：插件管理 `@godcreator/gwb-plugin-manager`，home 里的一个普通插件，单独发版。它和开发套件一起开发，因为两边互相依赖：`devkit.dev` 装完开发版调 `plugin-manager.remount` 重新加载、用 `plugin-manager.list` 核对结果，`devkit.home.new` 把它装进新 home；插件在 `package.json` 里写的 `gwb.testedKernel`，插件管理在 `list` 里拿它和运行中的内核比对，`devkit.release` 发版前用同一条规则检查。放在一个仓里，改这些地方一个提交就能改两边
* `packages/repo-kit/`：仓里用的检查工具包 `@godcreator/gwb-repo-kit`

## 文档

`docs-site/` 是六区文档站：`cd docs-site && pnpm install && pnpm dev`，看 `http://localhost:4322`。现状区的论断引用这个仓的真实源码，`pnpm doc` 核对，失败就是文档和代码不一致了。

怎么用看现状区的「怎么用」那一页，插件管理看「gwb-plugin-manager · 插件管理」那组页面；写插件的整条路与七条红线在随包发布的说明书 `gwb-devkit` 里。这份 README 是生成物，正本是 `docs-site/content/outputs/readme.mdx`。
