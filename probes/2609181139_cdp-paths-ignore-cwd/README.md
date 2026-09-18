# cdp.mjs 的路径不看工作目录

跑法：`pwsh -File run.ps1 -Cdp <home>\node_modules\.pnpm\@godcreator+gwb-devkit@…\node_modules\@godcreator\gwb-devkit\bin\cdp.mjs -Target <开着调试口的隔离 home 名>`。

照 `gwbNodeCli` 运行器的样子起那支驱动（工作目录是 cdp.mjs 自己所在的 `bin/`，运行器不给按次 cwd 时就是它），
跑六个场景，报每一趟的落点或错话，再数包目录里多没多文件。`results.txt` 是 2026-09-18 11:43 对同一个隔离 home
（`cdpshot-2609181138`）里装的两版各跑一趟：`0.14.1`（基线）与 `0.15.1-dev.202609181139`（改后），截的是另一个
隔离 home `cdpshot-260918113836`。

同一台机器上经总线那条路也跑过：default → `devkit.cdp` 的 `cmd` → `cdpshot-2609181138` 的总线 → 它装的
`devkit.cdp`（改后那版，node-cli 运行器起进程）→ 截 `cdpshot-260918113836`，回执 `file` 是
`…\homes\cdpshot-260918113836\out\cdp\shot-2026-09-18T03-39-18.png`，`cdpshot-2609181138` 里两版 devkit 包目录合计前后都是 126 个文件（经总线那几趟在基线那一趟之前跑）。
