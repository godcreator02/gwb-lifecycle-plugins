跑法：`pwsh ./run.ps1`（零依赖，只要 pnpm 12 与 node；pnpm 按插件管理的两个固定位置找。每次重建 `%TEMP%\gwb-probe-2609250110`，结果写进 `runs/*.txt`）

# 两个 pnpm 同时改同一个 home 会怎样

## 问什么

pnpm 不给项目目录加锁（全局存储的操作是原子的，项目里的 `package.json`、锁文件、`node_modules` 没有锁）。
两个 pnpm 同时在同一个 home 里运行时：home 的 `package.json` 会不会丢依赖、锁文件和 `node_modules` 还对不对得上、
pnpm 报不报错？只读的 `pnpm outdated` 写不写文件、和 `pnpm add` 同时运行有没有问题？

## 怎么做

- 造四个假包 `probe-base` 1.0.0 / 1.1.0、`probe-x` 1.0.0、`probe-y` 1.0.0，`pnpm pack` 进 `vendor/`
- `registry.mjs` 在本机起一个零依赖的只读源提供这些包，回包信息前等 1000 ms。实际只有第一个 home 取元数据时等了：
  之后 pnpm 用元数据缓存，每次 `pnpm add` 约 100 ms 就结束（见 `runs/02-add-add.txt` 的时间段）。两个 pnpm 仍然每轮都重叠
- 每一轮一个新 home，放在 `%TEMP%` 下、不带 `pnpm-workspace.yaml`，和真 home 的布局一样；先装好 `probe-base` 1.0.0。
  环境变量与插件管理启动 pnpm 时一样带 `pnpm_config_auto_install_peers=false`，存储与缓存经环境变量指到临时目录，不动用户的全局存储
- 两个 pnpm 用 `Start-Process` 相隔约 30 ms 启动，都结束后用 `check.cjs` 对照三处记录：`package.json` 的 `dependencies`、
  锁文件根 importer 里的直接依赖、`node_modules` 里有没有这个包；再运行一次 `pnpm install --frozen-lockfile` 看能不能装、装完三处对不对得上
- 场景：01 先后运行两次 `add`（对照）；02 同时 `add probe-x` 与 `add probe-y`；03 同时 `add probe-x` 与 `remove probe-base`；
  04 单独运行 `outdated --json`，比对 home 里每个文件的大小与修改时间；05 同时 `add probe-x` 与 `outdated --json`。02、03、05 各 5 轮

## 结论

**同时运行两个会写 home 的 pnpm，每一轮都丢改动，两个 pnpm 都退出码 0、不报任何警告。**

| 场景 | 轮数 | 两者都 exit=0 | 丢了改动 | 之后 `--frozen-lockfile` |
| --- | --- | --- | --- | --- |
| 02 `add x` ∥ `add y` | 5 | 5 | 5：清单与锁文件只剩一个（4 轮剩 y、1 轮剩 x）；`node_modules` 里两个都在 | 4 轮「已是最新」、多出来的包留在 `node_modules`；1 轮（第 3 轮）清单剩 x、锁文件剩 y，`ERR_PNPM_OUTDATED_LOCKFILE`，exit=1 |
| 03 `add x` ∥ `remove base` | 5 | 5 | 5：清单与锁文件都成了空的，`x` 的添加丢了；`x` 留在 `node_modules` | 1 轮把 `x` 删掉、三处对上；4 轮「已是最新」，`x` 留在 `node_modules` |
| 05 `add x` ∥ `outdated` | 5 | add 5、outdated 5（exit=1 是「有过期」） | 0：三处都对 | 5 轮都通过 |

- **丢的是整份读改写**：两个 pnpm 各自读出同一份旧清单，各加各的，后写的覆盖先写的。锁文件也一样，而且清单与锁文件可以被不同的 pnpm 写赢，
  于是两者互相对不上（02 第 3 轮）
- **会留下清单里没有、`node_modules` 里有的包**：`pnpm install --frozen-lockfile` 多数时候认为已是最新、不清理它
- **`pnpm outdated` 不写文件**：单独运行前后 home 里 8 个文件的大小与修改时间全都没变（`runs/04-outdated-writes.txt`）；
  和 `pnpm add` 同时运行 5 轮都没有影响 `add` 的结果（`runs/05-add-outdated.txt`）
- 时间段是百毫秒级：从元数据缓存装一个小包也会撞上；真实源有网络延迟，读清单到写回清单之间的间隔只会更长

## 跑那次的环境

2026-09-25 01:13，Windows 11 Pro 10.0.26200，pnpm 12.4.2（`%APPDATA%\npm\node_modules\pnpm\pnpm.exe`），node v24.14.1。
被测的是 pnpm 本身；gwb-devkit 当时的 commit 是 `fe4f69e`（`runs/00-env.txt`）。
