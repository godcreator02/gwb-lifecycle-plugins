跑法：`pwsh -File run.ps1`（pwsh 7、能访问个人源）；输出对照 `results.txt`（2026-09-17 23:16，pnpm 12.4.2）。

# pnpm 12 往已有 `^` 声明的项目里装一个准确的 dev 号，装上的是不是它

**问的是**：`devkit.dev` 在目标 home 里 `pnpm add <包>@<dev 号>`，同 patch 的第二趟没装上却退出码 0
（总控台 feedback，隔离 home `shell-swap-2609171833`）。根因在哪、哪种装法装得准、同 patch 两个 dev 号的
虚拟仓目录会不会撞。

**怎么测**：每个场景先让清单与锁停在「上一趟」的样子（清单写 `^x`、锁在 x），再用不同装法装目标号，
读 `node_modules/<包>/package.json` 的 `version`。S0 是正式版之间的对照；S1 是事故原型（锁在同 patch
旧 dev 号）；S2 是 `plugin-manager.install` 写的 `^正式版`、源上有更新的同 patch 号；S3 是锁在同号正式版
上装它的 dev 号。最后一段把同 patch 两个 dev 号先后装进一个项目，按 pnpm 的规则算虚拟仓目录名，对照盘上。

**结论**（数字见 `results.txt`）：

- `pnpm add <包>@<号>` 在清单已有 `^` 声明时写回 `^<号>`（`--save-exact` 改不掉），S1/S2/S3 全部装错、退出码 0：
  S1 锁里的同 patch 旧 dev 号被当成满足 `^新号`、不重解析；S2/S3 范围解析到源上号更大的同 patch 版本。
  S0 正式版之间重解析正常——病只在预发布号上
- `pnpm update <包>@<号>` 三个场景都装对，但清单仍写 `^<号>`
- 清单里写死准确号再 `pnpm install`，三个场景都装对，清单是准确号
- 虚拟仓目录名：超过 60 字符（Windows 缺省）时是「前 27 字符 + `_` + 全名 sha256 前 32 位」，全名含预发布段与
  peer 后缀——同 patch 两个 dev 号目录前段相同、哈希不同，不撞
