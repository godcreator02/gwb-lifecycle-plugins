# 页面取证：`devkit.cdp`

`skill.read {"name":"gwb-devkit","file":"references/evidence.md"}` 读到的就是这一份，主文件是说明书 `gwb-devkit`。

`devkit.cdp {"args":[<home 名>, <动作>, …]}` 在一个工作台页面里操作。动作与开关的全表在包内 `bin/cdp.mjs` 的文件头：

* 浏览器输入：`move` / `click` / `rclick` / `drag` / `type` / `key` / `scroll` / `shot`
* 工作台动作：`cmd <命令名> [JSON]` / `reload [选择器]` / `home` / `eval <文件> [JSON]`

```
devkit.cdp {"args":["<home 名>","eval","D:\\…\\out\\量一下.js"]}
devkit.cdp {"args":["<home 名>","shot"]}
devkit.cdp {"args":["<home 名>","cmd","plugin-manager.list"]}
devkit.cdp {"args":["<home 名>","home"]}
devkit.cdp {"args":["<home 名>","click",".dv-tab@=日志"]}
```

**第一个位置只收 home 名**。端口从那个 home 的 `runtime.json` 查、确认进程还在，连上后拿页面自报的 home 名核对一次；记录坏了的 home 停掉重开一次就连得上。

**`cmd` 只用在隔离 home**：它经页面上的 `window.gwb.command` 调那个 home 的全部命令，发的是真操作。隔离 home 的基础插件里没有 MCP 入口，这就是在它里面调命令的方式。

## `eval`

* 文件里是**一个函数表达式** `(args) => 一张表`，要 await 就写 async；第二个参数是一段 JSON，不给按空对象调。返回值就是读数
* **文件只收绝对路径**：`devkit.cdp` 不看工作目录（经命令总线调用时，工作目录是 devkit 包自己的目录）。PowerShell 里用 `(Resolve-Path <文件>).Path` 拿绝对路径
* 表达式写在文件里：写在命令行上会被 PowerShell 的引号截断
* 一次性的读数脚本放在自己仓的 `out/`（gitignore）；提交进仓的脚本会随界面改动过时，而且不报错

## `shot`

* 缺省存到**被截的那个 home 自己的目录** `<home>\out\cdp\shot-<时刻>.png`，回执 `file` 是绝对路径。它是那个 home 的证据，`devkit.home.rm` 删 home 时一起删掉
* 存到别处：`shot <绝对路径.png> [选择器]`，只收绝对路径
* 存放位置要在 devkit 包目录与任何 `node_modules` 之外：那些是装好的包

## 两条取证规矩

* **先点标签再取证**：dockview 只渲染激活的那个窗格，取证前 `click` 它的 `.dv-tab`。用 `click` 发真实的输入事件——页面里自己构造的事件不做命中测试，被浮层盖住的目标照样点得中，而这套界面最常出的错正是遮挡
* **读颜色先关过渡**：注入一条 `transition: none` 再读；读到 `oklab(…)` 就是还在过渡中。窗口最小化时 Chromium 节流后台动画，等多久都可能读到起点值

## 工作台没启动的时候

命令行脚本本身零依赖，可以直接运行：

```powershell
node <devkit 包根>\bin\cdp.mjs <home 名> <动作> [参数…]
```

内核要带 `--remote-debugging-port=<端口>` 与 `--disable-backgrounding-occluded-windows` 启动才连得上；`devkit.home.new` / `open` 启动的都带着。后一个开关的作用：窗口被整个挡住时 Chromium 停止渲染新帧，截图拿到的是旧画面。
