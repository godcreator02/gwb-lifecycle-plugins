跑法：`pwsh ./run.ps1`（零依赖，只要 pnpm 12.4.2 与 node；脚本里写死了 pnpm 的绝对路径，换机器先改 `run.ps1` 第 7 行。每次重建 `work/`、`vendor/`，结果写进 `runs/*.txt`）

# 插件 A 把插件 B 写进 peerDependencies 时，pnpm 在 home 里怎么装

## 问什么

插件 A 声明 `peerDependencies: { B: "^1.0.0" }`，B 同时也是 home 的直接依赖。热升级只对 B 执行一次安装、只重新加载 B 的条目——
这时 A 在磁盘上的真实路径会不会变、旧目录还在不在？缺 B 时 pnpm 会不会自动装、能不能按 home 关掉？B 的版本不满足 A 的范围时会怎样？

## 怎么做

- 造五个假包：`probe-b` 1.0.0 / 1.1.0 / 2.0.0，`probe-a` 1.0.0（peer `probe-b: ^1.0.0`），`probe-c` 1.0.0（没有 peer，对照），`pnpm pack` 进 `vendor/`
- 每个场景用一个新的 home 目录（`work/homes/<系列>-<场景>/`），自带 `pnpm-workspace.yaml`：pnpm 往上找 workspace 根时停在这里，
  不会找到 gwb-devkit 仓根那份（仓根 workspace 只收 `plugins/*` 与 `docs-site`，`runs/00-env.txt` 里 `pnpm ls -r` 列出的成员没有本目录）；
  `storeDir` / `cacheDir` 指到 `work/` 下，不动用户的全局存储
- 每个场景跑两个系列：
  - **file 系列**：依赖写 `file:../../../vendor/<包>-<版本>.tgz`
  - **registry 系列**：`registry.mjs` 在本机起一个零依赖的只读源，把 `vendor/` 里的 tgz 当成已发布版本提供，home 的 `.npmrc` 指向它，依赖写准确版本号。
    这个系列才和真 home（从团队源按版本号装）一致：`file:` 装的包，pnpm 判它不满足任何 peer 范围（连 1.0.0 对 `^1.0.0` 都报 unmet，
    见 `probes/2609181423_file-peer-and-prerelease`），所以 file 系列每个场景都有 peer 警告，**结论以 registry 系列为准**
- `inspect.cjs` 打印每个包的真实路径（`fs.realpathSync`）、`node_modules/.pnpm` 下的目录、A 同级的 `node_modules` 里链到哪个 B，
  以及从 A 的真实路径 `require.resolve('probe-b')` 得到的版本

## 结论

**(a) 升级 B，A 会换目录；旧目录默认还留在磁盘上。** A 的虚拟存储目录名带着它拿到的 peer 版本，B 一变 A 就被装进新目录，
没有 peer 的 C 不动。旧目录默认不删；home 设 `modulesCacheMaxAge: 0` 时，同一次 install 就删掉。
`pnpm add probe-b@1.1.0` 和「改清单写死版本号再 `pnpm install`」结果一样。pnpm 的输出里只列了 B（`- probe-b 1.0.0` / `+ probe-b 1.1.0`），看不出 A 也换了目录。

| | 升级前 | 升级后 | 旧目录还在 |
|---|---|---|---|
| A（`21-registry-upgrade-b-edit-manifest.txt`） | `probe-a@1.0.0_probe-b@1.0.0` | `probe-a@1.0.0_probe-b@1.1.0` | 是 |
| B | `probe-b@1.0.0` | `probe-b@1.1.0` | 是 |
| C | `probe-c@1.0.0` | `probe-c@1.0.0`（没变） | — |
| A，`modulesCacheMaxAge: 0`（`23-…`） | 同上 | 同上 | **否**（B 的旧目录也删了） |

对热升级的含义：只重新加载 B 的话，正在运行的 A 还是从旧目录加载的，经它同级的链接拿到的仍是 B 1.0.0；
新目录里的 A 要重新加载 A 才会用上。旧目录默认还在，所以 A 当下不会因为文件没了而出错；
但 home 如果设了 `modulesCacheMaxAge: 0`，A 之后再按需加载的文件会找不到。
（默认保留多久由 `modulesCacheMaxAge` 决定，pnpm 文档写的默认值是 10080 分钟，也就是 7 天；本探针只验证了「默认不删」与「设 0 立刻删」，没有等 7 天。）

**(b) 缺 peer 时默认自动装，可以按 home 关掉。**（`24-registry-missing-peer.txt`）

- 默认：home 只有 A，`pnpm install` exit=0、没有警告，装上了 B 1.1.0（满足 `^1.0.0` 的最高版本），目录名 `probe-a@1.0.0_probe-b@1.1.0`。
  B **不写进** home 的 `package.json`，**不出现在** `node_modules/probe-b`，只在 `.pnpm/probe-b@1.1.0` 与隐藏提升目录
  `.pnpm/node_modules/probe-b`。所以按 home 的直接依赖加载插件时，这个 B 不会被当成插件加载，只是 A 能 require 到它
- 能关掉的写法：home 的 `pnpm-workspace.yaml` 写 `autoInstallPeers: false`，或者设环境变量 `pnpm_config_auto_install_peers=false`。
  关掉后 exit=0，只有一行 `[WARN] Issues with peer dependencies found`，B 没装，从 A 解析 B 得到 `MODULE_NOT_FOUND`；
  `pnpm peers check` 报 `✕ missing peer probe-b`，exit=1
- 不起作用的写法：`--config.auto-install-peers=false` 和 `--config.autoInstallPeers=false` 都**被忽略**，照样自动装（exit=0）；
  `--auto-install-peers=false` 直接报参数不认识（exit=2）
- file 系列里自动安装去 npmjs 查 `probe-b`，得到 `ERR_PNPM_FETCH_404`，exit=1（`14-file-missing-peer.txt`）：自动安装一律从源上按版本范围解析，不会用 home 里别处的 `file:` 包

**(c) peer 范围不满足：默认只是警告，A 链到 home 里那个不满足范围的 B。**（`25-registry-peer-range-unmet.txt`）

- home 装的是 B 2.0.0、A 要 `^1.0.0`：`pnpm install` exit=0，只有一行 `[WARN] Issues with peer dependencies found`。
  A 的目录名是 `probe-a@1.0.0_probe-b@2.0.0`，同级链到 `probe-b@2.0.0`，从 A 解析 B 得到 2.0.0。**不会**给 A 另装一份 B 1.x，
  `autoInstallPeers` 开着关着都一样
- `pnpm peers check`：`✕ unmet peer probe-b / Installed: 2.0.0 / Wanted: ^1.0.0: probe-a@1.0.0`，exit=1
- `strictPeerDependencies: true`：`[ERR_PNPM_PEER_DEP_ISSUES] Unmet peer dependencies`，exit=1，但 `node_modules` 已经按上面同样的方式写完了
  （A 仍链到 B 2.0.0）。所以退出码非 0 不代表 home 的磁盘状态没变

## 跑那次的环境

2026-09-24，Windows 11 Pro 10.0.26200，pnpm 12.4.2（`C:\Users\godamericatb14\AppData\Roaming\npm\node_modules\pnpm\pnpm.exe`），
node v24.14.1，gwb-devkit 仓 commit `54c59ec`。完整输出见 `runs/`：`00-env.txt` 环境与 workspace 成员，`01-pack.txt` 打包，
`1x-file-*` 是 file 系列，`2x-registry-*` 是 registry 系列（x=1 改清单升级、2 用 `pnpm add` 升级、3 `modulesCacheMaxAge: 0` 升级、4 缺 peer、5 范围不满足）。

## 文件

- `run.ps1`：全部场景
- `inspect.cjs`：打印一个 home 里三个包的真实路径与解析结果
- `registry.mjs`：本机只读源（只实现 packument 与 tgz 两种请求；发布时间写成 2020-01-01，免得受 pnpm 的发布时间门槛影响）
- `runs/`：输出；`work/`、`vendor/` 每次重建，`.gitignore` 不收
