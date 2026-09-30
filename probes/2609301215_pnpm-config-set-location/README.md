运行：`pwsh -NoProfile -File run.ps1`，输出与 `run-2609301215.txt` 对照。

问题：一台新机器上用 `pnpm config set @<scope>:registry …` 配了源，pnpm 装包正常，插件管理 0.14 的 `search` 却什么都搜不到——它只读 `~/.npmrc` 与 `<home>/.npmrc` 两份文件。pnpm 12 把这条配置写在哪、`pnpm config list --json` / `config get` 能不能读回来？

结论（pnpm 12.4.2）：

- `pnpm config set @probe:registry …` 写进 `%LOCALAPPDATA%\pnpm\config\auth.ini`，`~/.npmrc` 不生成
- `pnpm config list --json` 与 `pnpm config get @probe:registry` 都读得回这条
- `pnpm config get` 一个没配的键输出 `undefined`，退出码 0
