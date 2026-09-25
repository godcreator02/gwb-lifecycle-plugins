# title 带特殊字符时，建仓生成的仓站不站得住

## 问什么

title 里有双引号、单引号、反斜杠、`{}`、`<>`、Markdown 标点、`${y}`、`*/` 时，`devkit.scaffold` 生成的仓
能不能 `pnpm install` / `build` / `check` 全过；`dir` 用正斜杠写时计划里的路径对不对。

## 怎么跑

```powershell
pwsh -NoProfile -File probes/2609251020_scaffold-hostile-title/run.ps1
```

先在仓根 `pnpm build`（`run.mjs` 读 `plugins/devkit/dist/scaffold.js`）。生成的仓在 `gen/hostile/`（不进 git），
输出记在 `runs/01-hostile-title.txt`；重跑前把 `gen/` 与 `runs/` 挪走。

## 结论

基线（改之前的纯字符串替换）：同一个 title 塞进插件包的 `package.json` 模板，`JSON.parse` 报
`Expected ',' or '}' after property value`。改之后：`gwb.title` 读回来与原文相同；插件页 frontmatter 写成
JSON 编码的双引号字符串；README 标题里的标点加了反斜杠；生成的仓 install、build（tsc + esbuild + tailwindcss）、
check（node 侧与浏览器侧 typecheck、oxlint、vitest 2 个文件 10 条）全过。`dir` 给
`D:/unitfolders/...`，计划里是 `D:\unitfolders\...`。

## 跑那次的环境

2026-09-25，Windows 11，Node 24.14.1，pnpm 12.4.2；devkit 在分支 `fix/scaffold-escape` 上、改动提交之前的工作区。
