# catalog · {{pkgName}}

插件的身份卡：是谁、提供什么、靠谁、有什么命令。改造成真插件时把这几格改掉；
登记面变了（加了命令、换了依赖），**这张卡要跟着改**——tests/catalog.test.ts 钉着命令那格不撒谎。

**定位**：模板插件——一格窗格（你好 + 计数）与一条 ping 命令，证明装配、窗格注册与命令面全通。

## 提供

（无服务——窗格与命令经总线直接面客；将来 provide 服务时写在这儿）

## 依赖

- `gwbCommands`、`gwbShell`（硬依赖，inject）
- `gwb-tokens`（样式映射面）、`gwb-shared-react`（页面共享 react，经 importmap）

## 命令

| 命令 | 形状 |
| --- | --- |
| `{{name}}.ping` | 无参数；回 `{ plugin, time }` |
