跑法：`pwsh ./run.ps1 -Scenario kill -Run 01`（要本机装了 gwb-kernel 安装版、pnpm 12、node；不碰 default，跑完两个 home 目录留着，看完自己删）。事发时段的时间线：`pwsh ./timeline.ps1`

# 结束 devkit.home.new 开出的实例，开它的那个 home 会不会跟着退出

## 问什么

总控台记下一件事：default 里的 devkit 用 `devkit.home.new {"short":"static-importmap"}` 开了一个实例（detached 子进程），
用 `Stop-Process` 结束它约 2 秒后，default 自己走了一遍正常退出（gwb.log 最后一行 `info kernel 清理完成，退出`）。
问题是：结束 devkit 开出的子实例，会不会让开它的那个 home 退出？

## 怎么做

- `run.ps1`：用 pnpm 在一个新的隔离 home A 里装内核包 0.6.1、cordis 与基础插件，再加 devkit；本脚本直接用安装版
  `gwb-kernel.exe` 启动 A（A 的父进程是脚本，不是 default）。经 `bin/cdp.mjs` 在 A 里调 `devkit.home.new`，由 A 里的 devkit
  开隔离 home B（和事发时同一条路：detached、`stdio: 'ignore'`、`unref`，用宿主安装版启动）。等 5 秒后
  `Stop-Process -Id <B 的 pid> -Force`，再等 20 秒，看 A 的进程还在不在、A 的 gwb.log 在结束 B 之后新增了什么
- `timeline.ps1`：从每个 home 的 gwb.log 里摘出事发时段（2026-09-24T17:00 到 17:16，UTC）的启动与正常退出，按时间排序

## 结论

**两个隔离 home 之间复现不出来；default 那次退出与结束子实例无关。**

- `runs/01-kill.txt`：结束 B 之后 20 秒，A 的进程还在，A 的 gwb.log 一行都没新增（没有「清理完成」）
- `runs/02-timeline.txt`：事发的 35 秒里，**7 个实例先后走了正常退出**——17:07:44 base-plugins-k04、17:07:46 default、
  17:08:06 bn-release、17:08:08 kernel05、17:08:11 bn-answers、17:08:14 launcher-version、17:08:19 bn-editor。
  这几个都是安装版 `gwb-kernel.exe` 启动的，除了 default 是它的父进程，别的都跟 static-importmap 没有父子关系；
  同一时段用源码 electron（`electron.exe`）启动的 static-importmap 第二个实例（17:07:52 起）没有退出。
  正常退出只有一条路：窗口关了（`window-all-closed` → `app.quit()`）或有人调了 `app.quit()`，
  插件里没有调 `app.quit()` 的代码。所以是有东西按映像名给所有 `gwb-kernel.exe` 实例发了关窗口（不带 `/F` 的
  `taskkill /IM gwb-kernel.exe`、安装包检查到应用在运行时关闭它、或人手工关），`Stop-Process` 是强制结束、不留日志
- 机制上也没有牵连的路：devkit 启动子实例用 `detached` + `stdio: 'ignore'` + `unref`，没有管道、没有 IPC，
  子进程退出在父进程里只触发 libuv 的退出回调（devkit 没挂处理）；内核的单实例锁按 `<home>\electron`（userData）区分，
  `second-instance` 只把窗口提到前面

发出那次关窗口的是谁，事后查不到：Windows 的应用与系统事件日志在 01:07:30–01:08:30（本地时间）之间没有记录，
会话记录里也没搜到 `taskkill /IM`、`Stop-Process -Name` 或 `CloseMainWindow` 的调用。

## 跑那次的环境

2026-09-25 10:04（本地时间），Windows 11 Pro 10.0.26200，安装版 gwb-kernel（启动器），home 里内核包
`@godcreator/gwb-kernel-desktop@0.6.1`、cordis 4.0.0-rc.10、devkit 0.19.1（源上的正式版），pnpm 12.4.2。
devkit 仓当时的 commit：`e71d842`（分支 `fix/runner-tree-kill` 的起点）。
