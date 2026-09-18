# pnpm 12 的 peer 检查里，file: 装进来的包满足不了任何范围

跑法：`pwsh -File run.ps1 > results.txt`（夹具现摆在 `%TEMP%\gwb-probes\file-peer-and-prerelease`，跑完删掉）。

问：`probes/2609181310_pnpm-strict-peer/` 第二组说开发版 `1.0.1-dev.…` 满足不了 `^1.0.0`，而 base-plugins 仓
`probes/2609181305_strict-peer/` 的 k 场景（registry 上的 `@godcreator/gwb-shell@0.9.1-dev.202609181108` 对
`^0.9.0`）严格下照过、不严格下连警告都没有。两份哪份对？

做法：本地包 `aa` 声明 peer `bb`，`bb` 以 `file:` 目录或 `file:` 打好的 tgz 装进项目，严格 peer 下
`pnpm install`，记退出码与 pnpm 报的 `Installed:`。

结论（`results.txt`，2026-09-18 14:23，pnpm 12.4.2）：

- `file:` 装的包，pnpm 报的 `Installed:` 是那条 `file:` 说明符、不是版本号，**连 `1.0.0` 对 `^1.0.0` 都判不满足**，
  目录与 tgz 两种形态都一样
- 所以 2609181310 第二组的「开发版满足不了 `^`」是夹具造成的，不是预发布号的性质；base-plugins 那份 n 场景
  （`0.10.0-dev.1` 对 `^0.9.0`，也是 `file:`）同理只证明了 `file:` 不满足
- 预发布号对 `^` 的结论只能看 registry 来源的场景：同一线开发版满足（base-plugins k）；破坏线开发版不满足
  是按 semver 推的——`^0.9.0` 的上界是 `<0.10.0-0`，`0.10.0-dev.1` 在它之上；本探针与 base-plugins 那份都没有
  registry 来源的破坏线场景
