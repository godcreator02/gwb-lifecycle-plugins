# pnpm add 点名一个精确版本，清单里原来的写法会不会让它装错

## 问什么

插件管理的 `plugin-manager.update-kernel` 要把 home 根上的 `cordis` 对齐到内核包 `peerDependencies.cordis` 写的精确版本号。
用 `pnpm add cordis@<号> --save-exact` 够不够？清单里原来写 `^`、写精确版本号、或者没有这一项，结果有没有差别？

## 怎么跑

前提：pwsh 7、pnpm 12、能访问 npm 源。

```powershell
pwsh -File .\run.ps1
```

每种情况在系统临时目录下新建一个项目，按起点写清单（有依赖就先 `pnpm install`），再 `pnpm add`，打印写进清单的写法与 `node_modules` 里装上的版本。
上一次的输出在 `results.txt`。

## 结论

**清单里原来写 `^4.0.0-rc.9` 时，`pnpm add cordis@4.0.0-rc.9 --save-exact` 退出码 0，清单还是 `^4.0.0-rc.9`，装上的是 rc.10。**
原来写精确版本号、或者原来没有这一项时，写进清单的是精确版本号、装上的就是点名的版本；没有这一项时带不带 `--save-exact` 都一样（点名的是预发布版）。

所以只看退出码不够，装完要读 `node_modules/<包>/package.json` 核对版本。

## 跑那次的环境

- 日期：2026-09-24
- 平台：Windows 11 Pro 10.0.26200，pwsh 7
- pnpm 12.4.2；源上 cordis 最新是 4.0.0-rc.10
