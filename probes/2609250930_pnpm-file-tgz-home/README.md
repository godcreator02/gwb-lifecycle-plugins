跑法：`pwsh ./run.ps1`（零依赖，只要 pnpm 12 与 node；pnpm 按插件管理的两个固定位置找。每次重建 `%TEMP%\gwb-probe-2609250930`，结果写进 `runs/*.txt`）

# 开发版改成「pnpm pack 出 tgz、存进 home、pnpm add <包>@file:<tgz>」装进 home，pnpm 12 怎么表现

## 问什么

`devkit.dev` 现在把开发版发到团队源、再装进隔离 home。计划改成：在临时目录里把版本号改成 `<patch+1>-dev.<时间戳>`，
`pnpm pack` 出 tgz，存到目标 home 目录下，在 home 里 `pnpm add <包>@file:<tgz 绝对路径>`。改之前要知道：

1. 清单与锁文件里记成什么
2. 换一个 tgz 之后包的真实目录变不变（决定 Node 会不会重新执行新代码），版本号相同、内容不同时呢
3. peer 写了这个包的插件，真实目录变不变（插件管理靠它找跟着重新加载的插件）
4. 装完删掉 tgz，之后在这个 home 里再运行 pnpm 会不会失败
5. 一次 `pnpm add` 同时给两个 file: tgz 行不行
6. home 里有 file: 依赖时 `pnpm outdated --json` 的退出码与输出
7. 已经以 `^0.1.0` 装着这个包，再 `pnpm add <包>@file:<tgz>`，清单改成什么

## 怎么做

- home 放在 `%TEMP%` 下、不带 `pnpm-workspace.yaml`，和真 home 的布局一样；每个场景一个新 home。环境变量与插件管理、devkit 在 home 里
  启动 pnpm 时一样带 `pnpm_config_auto_install_peers=false`，存储与元数据缓存也经环境变量指到临时目录，不动用户的全局存储
- `%TEMP%` 是 8.3 短路径（`GODAME~1`），脚本先展开成长路径，因为真 home 在 `%APPDATA%` 下是长路径
- 假插件包：`@probe/a`，`@probe/b`（peer `@probe/a: ^0.1.0`），`@probe/c`（对照），都带 `keywords: ["gwb-plugin"]` 与一个 `index.js`，
  导出 `{ name, version, marker }`；`marker` 区分版本号相同、内容不同的两个包。每个 tgz 都从新的源目录 `pnpm pack` 出来，
  开发版的 tgz 放在 `<home>\dev-packs\` 下（计划里的做法）
- `registry.mjs` 在本机起一个零依赖的只读源，提供「从源装」的包：`@probe/a` 0.1.0 / 0.2.0（开发版装之前 home 里那一版）、
  `@probe/r` 0.1.0 / 0.2.0（别的插件，看 outdated 用）、`@probe/rb` 0.1.0（从源装、peer 写 `@probe/a ^0.1.0` 的插件）。
  每个 home 的 `.npmrc` 指向它，整个实验不访问任何网络上的源
- `inspect.cjs` 在新起的 node 进程里打印：清单写法、`node_modules/<包>` 的真实目录落在 `.pnpm` 下哪个目录、从真实目录加载出来的
  `version` 与 `marker`，以及从写了 peer 的包的真实目录解析 `@probe/a` 得到谁

## 结论

**1. 清单照原样写 `file:` 加传入的路径，锁文件记相对 home 的路径，不会写成 `^`。**（`runs/11-q1-spec-and-lock.txt`）

| 传入的写法 | 清单 | 锁文件 `version` / `packages` 键 | `.pnpm` 目录 |
| --- | --- | --- | --- |
| 1a 反斜杠绝对路径，tgz 在 home 下 | `file:C:\\Users\\…\\dev-packs\\probe-a-0.1.1-dev.1.tgz` | `file:dev-packs/probe-a-0.1.1-dev.1.tgz` | `@probe+a@file+dev-packs+probe-a-0.1.1-dev.1.tgz` |
| 1b 反斜杠绝对路径，tgz 在 home 外 | 同上，绝对路径 | `file:../../vendor/…/probe-a-0.1.1-dev.1.tgz` | 名字超长，截成前段加哈希 `@probe+a@file+..+..+vendor+_3fd5bb…` |
| 1c 正斜杠绝对路径 | `file:C:/Users/…`（照传入的写） | 与 1a 相同 | 与 1a 相同 |
| 1d 相对路径 `./dev-packs/…` | `file:./dev-packs/probe-a-0.1.1-dev.1.tgz` | 与 1a 相同 | 与 1a 相同 |

锁文件里 `resolution` 是 `{integrity: sha512-…, tarball: file:dev-packs/…}`，`version: 0.1.1-dev.1`。所有写法 exit=0。

**2. `.pnpm` 目录名由 tgz 的路径决定，不看内容：路径变了真实目录就变，路径不变内容换了也不变。**（`runs/21-…`、`22-…`、`23-…`）

- 2a 0.1.1-dev.1 → 0.1.1-dev.2（文件名不同）：真实目录从 `@probe+a@file+dev-packs+probe-a-0.1.1-dev.1.tgz` 换到 `…-dev.2.tgz`，加载出 `marker=two`；旧目录还在
- 2b 版本号都是 0.1.1-dev.3、放在 `dev-packs\x\` 与 `dev-packs\y\` 两个路径：真实目录从 `…+x+…` 换到 `…+y+…`，加载出新内容
- 2c 版本号都是 0.1.1-dev.4、新 tgz **覆盖写到同一个路径**：`pnpm add` 同一条 file: 回 `Lockfile is up to date, resolution step is skipped`，
  `pnpm install`、`pnpm install --force` 也一样，全部 exit=0，真实目录不变，加载出来的仍是旧的 `marker=four-old`。
  **新内容静默没装上，读 `version` 核对也看不出来**（版本号相同）
- 2a 续：清单已换成 tgz2 之后删掉 tgz1，再 `pnpm add` 别的包 exit=0。不再被清单引用的旧 tgz 可以删

**3. peer 写了 a 的插件，a 换 tgz 时真实目录跟着变，不管它自己是 file: 装的还是从源装的。**（`runs/31-q3-dependent-realpath.txt`）

b 用 file: tgz 装、rb 从本机只读源按版本号装，peer 都写 `@probe/a ^0.1.0`。a 从 tgz1 换到 tgz2：
b `@probe+b@file+dev-packs+pro_571340…` → `…_cf9db8…`，rb `@probe+rb@0.1.0_@probe+a@fi_94043a…` → `…_c31352…`，
两者从新目录解析 a 都得到 `marker=two`。再把 a 换成同版本号、另一路径的 tgz，b 与 rb 又各换一次目录。
pnpm 的输出里列出了 b（`- @probe/b file:…(@probe/a@file:…)` / `+ @probe/b 0.1.0`），没列 rb，但 rb 的目录同样换了。
插件管理「装之前与装之后比真实目录」能找到这两个。

另外：a 是 file: 装的，`pnpm peers check` 报 `✕ unmet peer @probe/a / Installed: file:dev-packs/probe-a-0.1.1-dev.1.tgz`，exit=1；
每次 `pnpm add` 打一行 `[WARN] Issues with peer dependencies found`，exit 仍是 0。和 `probes/2609181423_file-peer-and-prerelease` 的结论一致：
file: 装的包满足不了任何 peer 范围。

**4. 装完把 tgz 删掉：之后这个 home 里任何 `pnpm add` 都 exit=1；`pnpm install` 仍然成功。**（`runs/41-q4-tgz-deleted.txt`、`42-q4-tgz-deleted-peer-moves.txt`）

| 删了 a 的 tgz 之后运行 | 不删（对照） | 删了 |
| --- | --- | --- |
| `pnpm add @probe/c@file:<c 的 tgz>` | exit=0 | **exit=1** |
| `pnpm add @probe/r@0.2.0`（从源装别的插件） | exit=0 | **exit=1** |
| `pnpm install` | exit=0 | exit=0 |
| `pnpm install --frozen-lockfile` | exit=0 | exit=0 |
| 删掉整个 `node_modules` 再 `pnpm install` | exit=0 | exit=0（从存储里取） |
| b 是 file: 装的、删了 b 的 tgz，`pnpm add @probe/a@0.2.0` 逼 b 换目录 | exit=0，b 换了目录 | **exit=1** |

失败时的报错：`Failed to resolve dependency tree: Failed to resolve dependency: Could not install from "C:/…/dev-packs/probe-a-0.1.1-dev.1.tgz" as it does not exist.`。
`pnpm add` 会重新解析清单里每一条 file: 依赖，所以只要清单还引用那个 tgz，它就得在；只按锁文件装的 `pnpm install` 不需要它。
插件管理的 `install`、`update`、`update-all` 走的都是 `pnpm add`。

**5. 一次 `pnpm add` 同时给两个 file: tgz 可以。**（`runs/51-q5-two-tgz-one-add.txt`）

`pnpm add @probe/a@file:<A> @probe/b@file:<B>` exit=0，清单两条都写上，b 从真实目录解析到同一次装进来的 a（`marker=one`）。
参数顺序换成 b、a，结果完全一样（b 的目录 `…_e264e1…` 相同）。只有那一行 peer 警告。

**6. `pnpm outdated --json` 完全不列 file: 依赖。**（`runs/61-q6-outdated.txt`；源上 `@probe/a` 的 latest 是 0.2.0）

- 6a 只有从源装的 `@probe/r ^0.1.0`：输出 `@probe/r` 一条（current 0.1.0、latest 0.2.0），exit=1
- 6b 再加一个 file: 装的 `@probe/a`：输出与 6a 完全一样，没有 `@probe/a`，exit=1
- 6c 只有 file: 装的 `@probe/a`：输出 `{}`，exit=0
- 6d 6b 的 home 删掉 a 的 tgz：输出与退出码不变（outdated 不需要 tgz）

所以一键升级不会把开发版换成源上的版本；但 6b 那种 home 里 `update-all` 升 `@probe/r` 时，要是 a 的 tgz 已被删掉，就撞上第 4 条。

**7. 已经以 `^0.1.0` 装着，`pnpm add @probe/a@file:<tgz>` 把清单整条换成 `file:<传入的路径>`，不留 `^`。**（`runs/71-q7-caret-then-file.txt`）

7a 清单原来 `^0.1.0`、7b 原来 `0.1.0`：add 之后都是 `"@probe/a": "file:C:\\…\\probe-a-0.1.1-dev.1.tgz"`，锁文件里没有 0.1.0 的痕迹，
装上的是 `0.1.1-dev.1`、`marker=one`，exit=0。`^` 沿用只发生在给版本号的时候（见 `probes/2609241510_pnpm-add-exact-prefix`），file: 不受影响。

**附带：从 file: 回到源上的版本，必须写明版本号。**（`runs/81-extra-back-to-registry.txt`）

- 8a `pnpm add @probe/a`（不带版本）：`Lockfile is up to date, resolution step is skipped`，exit=0，清单仍是 file:、装的仍是开发版。**静默什么都没做**
- 8b `pnpm add @probe/a@0.2.0`：清单写成 `"0.2.0"`，装上源上的 0.2.0

另外 `pnpm pack` 的产物是确定的：同一份内容打两次 tgz，sha256 相同（`runs/01-pack.txt`）。

## 对「devkit.dev 改用 pack + file: 装进 home」的判断

**成立，带四个条件：**

1. **每一版的 tgz 路径必须不同。** 目录名只看路径（第 2 条），覆盖写同一路径会静默装旧内容、退出码 0、版本号核对也发现不了。
   版本号带时间戳、用 `pnpm pack` 的默认文件名（`<作用域>-<名>-<版本>.tgz`）就自然满足；装完读 `node_modules/<包>/package.json` 核对版本号仍然有用
2. **清单还在引用的 tgz 不能删。** 删了之后这个 home 里任何 `pnpm add` 都失败（第 4 条），插件管理的安装与升级都会坏掉。
   换成新的 tgz 之后，不再被引用的旧 tgz 可以删（第 2 条 2a 续）
3. **跟着重新加载的插件要照「装前装后比真实目录」来找。** a 换 tgz 时，peer 写了 a 的插件都会换目录（第 3 条），只重新加载 a 不够
4. **file: 装的包在 pnpm 眼里满足不了任何 peer 范围。** 每次安装都有一行 peer 警告、`pnpm peers check` 退出码 1；装进隔离 home 可以接受，
   但凡有一步把 peer 警告当失败就会挡住

好处：不再发到团队源，不再需要「清单写准确号再 `pnpm install`」那套绕法（`pnpm add <包>@file:` 直接把清单整条换掉，第 7 条）；
多个包一次 `pnpm add` 装齐（第 5 条）；`outdated` 不列 file: 依赖，一键升级不会把开发版换掉（第 6 条）。

要留意的：从开发版回到源上的版本要写明版本号，`pnpm add <包>` 不带版本是静默空操作（附带那条）；清单里写绝对路径还是
`file:./dev-packs/…` 相对路径都能装，相对路径不把 home 所在位置写进清单（第 1 条 1d）。

## 跑那次的环境

2026-09-25 09:39，Windows 11 Pro 10.0.26200，pnpm 12.4.2（`%LOCALAPPDATA%\pnpm\bin\pnpm.exe` 不存在，用的是 `%APPDATA%\npm\node_modules\pnpm\pnpm.exe`），
node v24.14.1。被测的是 pnpm 本身；gwb-devkit 当时的 commit 是 `e71d842`（`runs/00-env.txt`）。脚本当天跑了三次，后两次各加了几个场景（1d、第 3 条的 `peers check`、2a 续、附带那条），
三次都有的场景结论与 `.pnpm` 目录名都相同；`runs/` 里是最后一次。

## 文件

- `run.ps1`：全部场景
- `inspect.cjs`：打印一个 home 里几个包的清单写法、真实目录、加载结果与 peer 解析结果
- `registry.mjs`：本机只读源（支持带作用域的包名；发布时间写成 2020-01-01，免得受 pnpm 的发布时间门槛影响）
- `runs/`：输出。`00-env` 环境，`01-pack` 每个 tgz 的来源与 sha256，`1x` 到 `7x` 对应上面七个问题，`81` 是附带的「回到源上的版本」
