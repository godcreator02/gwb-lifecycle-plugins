# pnpm 12 严格 peer 检查怎么开、怎么关

跑法：`pwsh -File run.ps1`（夹具现摆在 `%TEMP%\gwb-probes\pnpm-strict-peer`，跑完删掉）。

两个本地包：`aa` 声明 peer `bb`，项目同时装 `aa` 与 `bb`（`file:` 依赖）。第一组让 peer 真不匹配
（要 `^2.0.0`、装 `1.0.0`），逐个试命令行参数、环境变量、项目自己 `pnpm-workspace.yaml` 里的键；第二组
装一个开发版号（`1.0.1-dev.…`）对 `^1.0.0`。每行报退出码与 pnpm 的那一句。`results.txt` 是 2026-09-18
13:40 在 pnpm 12.4.2 上跑的输出。

夹具不能摆在仓里：pnpm 往上找最近的 `pnpm-workspace.yaml`，摆在仓里测的就成了仓根那份配置（第一次
就是这么跑歪的——默认一行连警告都没有）。
