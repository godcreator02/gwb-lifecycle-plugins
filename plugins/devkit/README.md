# gwb-devkit

**本页回答**：`@godcreator/gwb-devkit` 是什么、怎么装、怎么确认它在干活、文档在哪。

## 是什么

god 工作台的开发套件，本身就是**一个普通的插件**：装进 home 才有它的命令，挂不上就什么都没有。它走它教别人走的那条路：发团队源、装进 home；仓是双包 workspace（`plugins/devkit` 本体 + `packages/repo-kit` 仓侧守卫工具包）。

它把「在一个新文件夹里开发一个新插件」这条路上的每一步都开成一个能被 agent 调到的入口：建仓、往薄壳仓加件、测试 home 的开与收、改一版看一版、在页面里动手取证，外加一份随包发的写插件手册。**只有一种仓形**：薄壳 workspace，件住 `plugins/<短名>/`，单件多件同一格式。

**使用者是 agent，所以它没有界面那一半**：全部回执都是给读的人看的，不是给看的人看的。工作台没起的时候有一支包内 CLI 兜底——`bin/cdp.mjs` 在一张页面里动手。

## 怎么装

```
plugin-manager.install {"pkg":"@godcreator/gwb-devkit"}
```

装完不用配置——它没有设置项。下一次调门的 `index` 现拼，`devkit.*` 那几条就在地图上。

## 怎么确认它在干活

看 `<home>\gwb.log` 里那句「开发套件就绪」，它把这一版真登记上的命令逐条列了出来。那一行才是证据，「装完了」不是。

## 文档

`docs-site/` 是六区文档站：`cd docs-site && pnpm install && pnpm dev`，看 `http://localhost:4322`。现状区的论断钉在这个仓的真实源码上，`pnpm doc` 核对，红了就是文档漂了。

怎么用看现状区的「怎么用」那一页；写插件的整条路与七条红线在随包发的说明书 `gwb-devkit` 里。这份 README 是生成物，正本是 `docs-site/content/outputs/readme.mdx`。
