---
name: gwb-devkit
description: 动手写一个新 gwb 件之前读。从建仓到装进 home 的整条路、红线是哪几条、生态里每个件的服务什么时候用。devkit.scaffold 建出来的仓怎么用也在里面。
---

# 从哪儿起手

写一个 gwb 件，只有一条路：**独立起一个仓（或文件夹），发一版进本机 registry，装进
home**。不存在「把源码摆在工作台仓旁边跑起来」的近路——近路绕过了安装这个动作，
exports 漏一个子路径、files 少带一个目录，近路上都不显形，装出来才炸。

一条命令：

**`devkit.scaffold`** —— 建仓。参数 `{ name, dir, title? }`：

- `name`：短名，kebab-case。它同时是包名 `@godcreator02/gwb-<短名>` 的尾巴、插件名
  （`export const name`）`gwb-<短名>`、命令名 `<短名>.<动作>` 的前半
- `dir`：目标目录的绝对路径，**必须还不存在**（存在就拒，不覆盖任何东西）
- `title`：显示名，缺省用 name

落盘四件（`package.json` / `tsconfig.json` / `src/index.ts` / `.gitignore`），接着：

    cd <dir>
    pnpm install
    pnpm build

先让骨架立住，再写自己的东西。devkit 自己就是这条路走出来的：它住一个独立文件夹，经
同一条路发版上架。看它就是看样例。

# 七步

**一、建仓。** 上一节那条命令。装不上依赖不挡交货，仓已经在盘上了，依赖可以事后
`cd <仓> && pnpm install` 重来。

**二、写 node 半**（`src/index.ts`）：`export const name = 'gwb-<短名>'` + `apply(ctx)`。
每改一步就重启内核看一眼 `<home>\gwb.log`——自己 `apply` 里那句日志出来再往下写。

**三、要给人或 agent 调的能力，挂到命令总线上。** 用**局部注入**（可选依赖写法——
总线件不在，你的件照常挂）：

    ctx.inject(['gwbCommands'], (c) => {
      c.effect(() => c.gwbCommands.register(
        { name: '<短名>.<动作>', plugin: '<短名>' }, handler))
    })

handler 参数是 `unknown`，自己收窄（词汇表包的 `isRecord`）。相对 import 带 `.js`。

**四、发一版。** 先抬 `package.json` 的版本号，再：

    pnpm publish --registry http://127.0.0.1:4873/ --no-git-checks

**同一个版本号永不重发**；发之前先问一句这个号在不在源上。

**五、装进 home 看真效果。** 两条路：

- **正路**：调 `plugins.install { "pkg": "@godcreator02/gwb-<短名>" }`——装机件真跑
  pnpm add，且自动往 cordis.yml 落条目（默认启用）
- **手动路**：home 目录里 `pnpm add @godcreator02/gwb-<短名>@<版本>`，再在 cordis.yml
  手写一条条目。`id` **必须手写**：不写 loader 当场发 8 位随机 hex 且首挂不写回，身份一直漂

**六、全套验一遍**（见「验机」节）。

**七、上新线市场**：往件仓 `gwb-base-plugins` 的 `market/src/catalog.ts` 白名单加一条，
抬测试里的数量断言。那是发现入口，装不装仍由人挑。

# 红线

比代码风格都上位的几条：

**一、源码里不许有任何路径指回别的仓。** 没有 tsconfig `paths`，没有 `link:` /
`workspace:`。（本地包经 `file:` 装进 home 是**安装动作**，不算——但发版上架仍是正路。）

**二、cordis 不写进 dependencies，写 dev。** 它只在 `apply` 的参数类型里用到；写进
dependencies，装进 home 就是第二份实例，Service 身份对不上——件挂不上，报错完全不指根因。

**三、依赖三档。** 运行时真 import → `peer`；只 import type 但**出现在导出的类型面**
→ `peer`（消费方必须解析得到）；只在实现内部用类型、不占导出面 → `dev`。

**四、产物两条硬要求。** 产物给 node 直接加载（loader 不打包），所以：相对 import
必须带 `.js`；产物里不许有没有依赖兜底的裸名 import——每一条裸名都得是 package.json
里声明过的 `dependencies`/`peerDependencies`。

**五、`requireKernel(ctx)` 不写进 `inject`。** `gwbKernel` 在根上下文 provide、永不撤销；
写进去只多一处挂不上的可能。

**六、`prepublishOnly` 别漏。** `pnpm check` 不构建；少了这条，publish 把上一版的
`dist/` 原样发出去而且一声不吭——现象是「件挂上了但新写的东西全没生效」。

**七、类的私有字段用 TS `private` 不用 `#`。** cordis 给消费者派生 `Object.create(this)`，
`#` 槽不在原型链上，派生对象上一读就炸。

# 能力面菜单

内核给的面就七个名字（`@godcreator02/gwb-plugin-api` 0.1）：`GwbContext` / `GwbKernelApi` /
`GwbResult` / `GwbWindowApi` / `ShellBoot` / `requireKernel` / `isRecord`。类型住词汇表包，
运行时值走服务。`gwbKernel` 上只有三样：`dataDir` / `emit(payload)` / `setShell(url)`——
**没有 `kernel.info`、没有 `appVersion`、没有 `install`**，要版本号读自己包的
`package.json`。页面那面是 `window.gwb`：`command` / `on` / `onShell`。

生态里每个件的服务，**按需取**——不上的面就不写 inject，少一条依赖少一处挂不上的可能：

| 面 | 怎么拿 | 什么时候要 |
| --- | --- | --- |
| 命令总线 | `inject: ['gwbCommands']` → `register` | 能力要被调就要（几乎一定）。界面、agent 走的是同一张表 |
| 说明书 | `skills/` 目录 + `gwbSkills.register`（局部） | 有多步流程或坑要讲给 agent 就要 |
| 设置 | `gwbSettings.define`（局部）→ `get`/`set` | 要可改配置就要。home 级跟条目走，machine 级跨 home |
| 数据 | `gwbData.readDoc/writeDoc`（局部） | 要落盘状态就要。存 `<home>/data/<条目末段>/` |
| 窗格 | `gwbShell.registerPane` + client 半 | 要人看得见就要。**注册时自报地址**：`client`（与可选 `style`）从自己的 `import.meta.url` 算成 `file://`——内核不替件取货 |
| 外部 CLI | `gwbNodeCli`/`gwbPyCli` register（局部） | 要给外部脚本一个稳定入口就要 |
| agent 桥 | 不用做——gwb-mcp 把总线与 skill 自动开出去 | — |

inject 三种写法：`export const inject = [...]` 硬依赖（缺了不挂）；`static inject = [...]`
（Service 类）；`ctx.inject([...], fn)` 局部可选（缺了主件照挂）。

改条目 config 走 cordis 的 reconfigure：模块不重载，只重跑 `apply`。要「改配置就该清掉」
的状态放 `apply` 里，要「只要没换代码就该留着」的放模块顶层——放错地方两种都不报错。

# 发版与装机

    pnpm publish --registry http://127.0.0.1:4873/ --no-git-checks

（.npmrc 已把 `@godcreator02` 指过去。）**刚发的包为什么装得进去**：pnpm 11 起
`minimumReleaseAge` 缺省一天，这台机器在**用户级配置**里放行了整个 scope——那份配置
不在任何仓里，换机器要补，症状是「突然装不上刚发的包」。

装进 home 用 `plugins.install`（正路，自动落条目）或手动 `pnpm add` + 手写 id 条目。
装完看 `<home>\gwb.log`：件自己那句 `apply` 里的日志出来就是挂上了；没挂上看
`[loader]` 那行——它带 `ERR_MODULE_NOT_FOUND` 之类带完整路径的原因。

# 测试 home 的开与收

实机验证那几步已经命令化。前提两条：**设置里配好 `kernel-dir`**（内核仓根，含
apps/desktop 的那个），以及 devkit 本身跑在一个活着的 home 里——它是个件，宿主不在
它也起不了；那时退回手工四步（见「验机」节）。

| 命令 | 干什么 |
| --- | --- |
| `devkit.home.new { "short": "data" }` | 开 `<short>-<yyMMddHHmm>` 的新 home。**默认先 build 内核**——产物不新就起，验的是旧代码；赶时间才 `skipBuild: true`。带 `"cdp": 9222` 顺带把调试口开了 |
| `devkit.home.list {}` | 列出全部 home 与谁在跑——「清理放在开新那一刻」的先看一眼就在这条 |
| `devkit.home.open { "name": "data-2609081430" }` | 重开已有的 home，不 build。验完留给人看的那一眼走这条 |
| `devkit.home.stop { "name": "…" }` | 停 devkit 起的那个（按 home 里 devkit.json 的 pid，核对映像名、记录过的 CDP 端口再杀） |
| `devkit.home.rm { "name": "…" }` | 删一个 home。还在跑的拒删（先 stop）；`default` 是日常那份，force 才删 |

纪律不变：一次验开一个新 home，不复用上一次留下的；名字是 `<被测短名>-<yyMMddHHmm>`。
启动记录落在每个 home 自己的 `devkit.json` 里，home 删了它自然也没了。

# 验机

**一次验证一个干净 home**：`$env:GWB_HOME = '<被测短名>-<yyMMddHHmm>'`（kebab-case）。
别拿日常 `default` 验——里面躺着十几个不同时刻的版本快照，验什么都不算数。

**开之前确认产物是新的**：`check` 不构建；件没有 `prepublishOnly` 发的是旧 dist；
改了内核要在 `apps/desktop` 跑 `pnpm build`（tsc 直出 `dist/`，没有打包器）。三种漏法
都是「界面看着一切正常，验的是旧代码」。

日志在 `homes/<名>/gwb.log`——内核自己的话、件的、渲染层 console 转来的全在这一份里。
**没有自省命令**（`kernel.info` 那类 0.1 起就不在了）：谁挂上了看 `plugins.list`，
它的 `active` 判的是 fiber 真 ACTIVE，不是 fiber 建出来了（inject 永远等不到的件也有
fiber，但 `active: false`）。

四种「看着成了其实什么都没验」：拿 `default` 验；只看「挂上了」不看件真干了活（`apply`
里 async 静默 reject，现象就是挂上了但什么都没发生——链路必须自己 catch 并打出来）；
改了件没重发；改了内核没重 build。

清理放在下次开新 home 那一刻：先列再删，人永远有机会看。

# 撞墙记录不在这

手册随件分发，把别处的一手记录抄进来只会得到一份靠人记得重发版才更新的副本。正本：

- 内核仓文档站 `trajectory/`（baseUrl 为什么挂根 ctx、热挂载的形态、装机口为什么拆）
- 件仓 `gwb-base-plugins` 的文档站（walls 与各件页）

自己撞到新墙记进**自己仓**的文档。判据：每一次发现「不伸手进别的仓就做不下去」，
那就是一堵墙。
