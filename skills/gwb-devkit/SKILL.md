---
name: gwb-devkit
description: 动手写一个新 gwb 件之前读，打算说「验过了 / 跑通了 / 改动生效了」之前也读。开发套件的全部命令与设置项、建仓（devkit.scaffold，件模板随本包发，站那半调 livedoc）、从建仓到发版装机验完的整条路、七条红线、生态里每个件的服务什么时候用，以及改内核（不是改件）时验机怎么走。
---

# 这套东西是什么

`@godcreator02/gwb-devkit` 是个**普通的 gwb 件**，装进 home 才有它的命令。它自己就是
「独立起仓、发本机源、装进 home」这条路走出来的样例——住独立文件夹
`D:\unitfolders\260908dkv\gwb-devkit`，不在任何 monorepo 里。

它管四件事：**建仓**（`devkit.scaffold`）、**手册**（就是这一份，随件分发经 gwb-skills 挂载）、
**本机源的起停**（`registry.*`，另有一扇「插件源」窗格 10 秒一轮显示 status）、
**测试 home 的开收**（`devkit.home.*`）。外加两条经 `gwbNodeCli` 登记的外部 CLI：
`devkit.livedoc`（建站）与 `devkit.cdp-eval`（从页面取证）。

代码分层：`src/index.ts` 只剩接线；建仓的校验渲染落盘在 `scaffold.ts`，registry 起停时序在
`daemon.ts`，home 的在 `home.ts`（两处皆纯机、可单测），真机器的盘与进程在
`node-registry-deps.ts` / `node-home-deps.ts`。

**源码改了这份就过期**——对不上时以源码为准，回来改这儿。这份随包发：改一个字也要抬版本、
发版、`plugins.update`，`gwb-skills` 的「正文现读盘」只对装进 home 的那份生效。

## 两个设置项（不填对应的半边就不工作）

| key | 填什么 | 不填的后果 |
| --- | --- | --- |
| `registry-dir` | Verdaccio 目录，含 `config.yaml`、`storage`、`node_modules/verdaccio`。本机那份在 `D:\unitfolders\26090520zzv\registry` | `registry.*` 四条全回 "未配置 registry-dir" |
| `kernel-dir` | 内核仓根（含 `apps/desktop`），即 `D:\unitfolders\26090705ymz\gwb-kernel` | `devkit.home.new` / `open` 不工作 |

# 命令全表

**建仓**

| 命令 | 参数 |
| --- | --- |
| `devkit.scaffold` | `{ name, dir, title?, docs?, port? }`——`name` 必给（kebab-case 短名），`dir` 必给（绝对路径，**必须还不存在**），`title` 可选显示名，`docs` 缺省 `true`（连文档站一起建），`port` 可选站端口。**参数不对会把完整说明回给你**（错误即文档），不必背 |

**两条外部 CLI**（经 `gwbNodeCli` 登记，自动镜像成同名总线命令）

| 命令 | 参数 | 干什么 |
| --- | --- | --- |
| `devkit.livedoc` | `{ args?: string[], cwd?: string }` | livedoc 的命令行。`cwd` 按次给（必须是存在的绝对路径），所以 `check` / `confirm` / `render` 也走这条，见下面那节 |
| `devkit.cdp-eval` | `{ args: [<调试口>, <表达式文件>] }` | 从页面里取证，见「拿证据」 |

**本机源**（Verdaccio，`http://localhost:4873/`）

| 命令 | 参数 | 干什么 |
| --- | --- | --- |
| `registry.status` | — | `{running, url, pid, adopted, dir}`。端口从 url 看 |
| `registry.up` | — | 拉起；**已经在跑就直接接管**（`adopted`）。轮询 `/-/ping`，最多 30 秒（每 500ms 一次） |
| `registry.down` | — | 按 `verdaccio.pid` 停，核对映像名与端口持有者再杀。**这台机器上别的仓也在用它**，停之前想清楚 |
| `registry.log` | `{ lines? }` | 运行日志尾巴，默认最后 200 行 |

命令面起不来时，同一件事有个不依赖工作台的旁路：`D:\unitfolders\26090520zzv\registry.ps1 up`（`down` / `status`）。

**测试 home**

| 命令 | 参数 | 干什么 |
| --- | --- | --- |
| `devkit.home.new` | `{ short, cdp?, skipBuild? }` | 开一个新 home，名字长成 `<short>-<yyMMddHHmm>`。**默认先 build 内核**——产物不新就起等于验旧代码；赶时间才 `skipBuild: true`。`cdp: 9222` 顺带开调试口。**回执里带着现有 home 清单**，开新那一刻正好清旧的 |
| `devkit.home.list` | — | 列 home 根下全部：名字、谁还在跑、CDP 口 |
| `devkit.home.open` | `{ name, cdp? }` | 重开已有的，**不 build**。验完留给人亲自看那一眼走这条 |
| `devkit.home.stop` | `{ name }` | 停 devkit 起的那个：按 home 里 `devkit.json` 的 pid，核对映像名与记录过的 CDP 端口再杀 |
| `devkit.home.rm` | `{ name, force? }` | 删。还在跑的拒删（先 stop）；`default` 是日常那份，`force` 才删 |

启动记录落在每个 home 自己的 `devkit.json` 里，home 删了它自然也没了。**热重挂不换 pid**
——`plugins.update-all` 那套停用再启用只动条目，内核进程还是原来那个，`devkit.home.stop`
照常认得它。

**前提**：`devkit.home.*` 要 devkit 本身跑在一个活着的 home 里——它是个件，宿主不在它也起不了。
一个 home 都没活着的时候只能手工起，见末尾「你改的是内核，不是件」那四步（件作者同样能用）。

# 建仓：`devkit.scaffold` 一条命令

```
devkit.scaffold {"name":"hello","dir":"D:\\unitfolders\\<单元>\\gwb-hello","title":"打个招呼"}
```

校验：kebab-case 短名、**目标目录必须还不存在**、认不出的占位符当场抛、**整套先在内存渲染完
再碰盘**（目录一旦开始写就没有干净的回滚点）。

**默认连文档站一起建**：件那半落盘之后，本件经 node CLI `devkit.livedoc` 调
`livedoc init --dir <仓>`，端口由 livedoc 自己挑（扫仓的邻居已占的，从 4310 起找第一个空位；
`port` 参数手给的一律让给你）。`docs: false` 就只建件那半——但别轻易用：人记得事后补第二条
命令的概率，跟容器里那一堆仓至今没有站是同一个概率。

**站没建成不算建仓失败。** node-cli 件不在、或 `livedoc init` 自己失败，件那半照样在盘上；
回执里 `docs.note` 写明为什么、怎么补。**回执里 `docs.built` 才是站真的建起来了没有**——
`nextSteps` 按它分两支，不按你要不要建分。

## 建出来是什么

一个能直接开工的件仓，两半各有各的依赖：

| 半 | 装什么 | 模板归谁 |
| --- | --- | --- |
| 仓根 | `package.json`（build / typecheck / lint / test / check / prepublishOnly）、`tsconfig.json` 与 `tsconfig.build.json`（typecheck 带上 tests，构建只吃 src）、`.oxlintrc.json`（type-aware 那套规则）、`vitest.config.ts`（只认仓根 `tests/`，slow 标签留给真起子进程的用例）、`.npmrc`（scope 指本机源）、`src/index.ts`、`tests/plugin.test.ts`、`README.md` | **本包 `template/`**，10 个 `.tpl` |
| `docs-site/` | fumadocs 站接 livedoc | **livedoc 的站模板**，随 `@godcreator02/live-doc-cli` 发 |

**方向是单向的**：devkit 知道 livedoc，livedoc 不知道 devkit——它那个 `init` 只认「一个仓 +
一份模板」，不知道调它的人在写什么件。往**已有仓**里加站是同一条 `init`（前置条件正好相反：
建新仓要求目标目录还不存在，加站要求仓已经在、而 `<仓>/docs-site` 还不在）：

```
devkit.livedoc {"args":["init","--dir","D:\\unitfolders\\<单元>\\<已有仓>"]}
```

起手页里预置一条**草稿记号**钉着 `src/index.ts` 里 `export const name` 那一行（行号是现找的，
不写死）——`git init` 落第一个提交、在 `docs-site` 里 `pnpm doc:confirm`，它转成正式记号、
状态点变绿。这条闭环走一遍，这套机制就摸清了。

`livedoc init` **不跑 `pnpm install`**（替人装依赖，出错时现场在哪都不好找），也**不改仓里
任何已有文件**——仓根 `.gitignore` 缺哪几条只打印出来，自己加。

模板文件一律带 `.tpl` 后缀、落盘时脱掉：`npm pack` 不打 `.gitignore` 是硬行为，一条规则管
所有文件，不必记哪几个特殊。**这儿不抄模板正文**——抄一份就是第二份真相，要看就看
`<devkit 包>/template/` 本身。

**工作台起不来的时候**：件那半没有离线入口（模板在包里，但这个包是件、不是 CLI）——先按末尾
「你改的是内核，不是件」那四步把工作台起起来。站那半随时可以 `pnpm dlx
@godcreator02/live-doc-cli init --dir <仓>`。

## 两条从实跑里换来的

**一、`format-fumadocs` 不许进 `serverExternalPackages`。** 它的 `/pre` 是客户端组件，
跟着站一起打包才是同一个 React。外置它的现象是构建期报
`ERR_PACKAGE_IMPORT_NOT_DEFINED`（`#prehydration/...` 找不到，指着 `@base-ui/react`
里的文件）——**报错完全不指根因**，会把人引去查 base-ui 的版本，而那儿根本没问题。
`core` 与 `project` 要外置：它们读盘、调 git。

**二、`oxlint` 的 type-aware 要单独装 `oxlint-tsgolint`。** 少了它 `pnpm lint` 报
"Failed to find tsgolint executable"。模板里两个都钉了版本。

## 名字是怎么派生的

一个短名派生出全部：

| 占位符 | 值 | 例（`name: "hello"`） |
| --- | --- | --- |
| `{{name}}` | 短名本身 | `hello` |
| `{{pkg}}` | `@godcreator02/gwb-<短名>` | `@godcreator02/gwb-hello` |
| `{{pkgName}}` | 插件名 `gwb-<短名>`，即 `export const name` 的值 | `gwb-hello` |
| `{{title}}` | 显示名，缺省用短名 | `打个招呼` |
| `{{docsBlock}}` | README 里讲文档站的那一段：建了站讲怎么跑，没建讲怎么补 | — |

命令名 `<短名>.<动作>` 的前半也是它。短名的正则是
`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`——**段之间只许一个连字符、结尾不留**；松写法会放过
`x--`，那条尾巴会跟着包名过一辈子。scope 全仓统一是 `@godcreator02`，不做成参数。

两条落盘纪律，都是「没有干净回滚点」推出来的：整套模板**先在内存里渲染完**再碰盘
（占位符出错是最可能的失败）；**目标目录必须还不存在**，存在就拒，不覆盖任何东西。
模板里留一个认不出的 `{{typo}}` 会当场抛——不然它一路活到别人的 package.json 里，
那时已经没人知道它本来该是什么。**给模板加了新占位符，`scaffold.ts` 的 `placeholders()`
就得同时加一格**，不然下一次建仓当场抛。

## 建完之后

回执自带下一步，不用再问：

```
cd <dir>
pnpm install
pnpm check          # typecheck + oxlint + vitest，模板自带一条测试
pnpm build
文档站那半（自己一套依赖，跟件分开装）：cd <dir>\docs-site && pnpm install && pnpm doc
先 git init 落第一个提交，再在 docs-site 里 pnpm doc:confirm
发一版：先抬 package.json 的版本号，再 pnpm publish --registry http://127.0.0.1:4873/ --no-git-checks
装进 home：调 plugins.install {"pkg":"@godcreator02/gwb-<短名>"}，或手动 pnpm add + 在 cordis.yml 手写 id 条目
```

# livedoc 经本件登记成 node CLI `devkit.livedoc`

livedoc 是个 CLI 包、不是件，自己挂不上工作台。本件把它的可执行登记进 `gwbNodeCli`，于是
它自动镜像成总线命令、自动是 MCP 工具，回执自带 stdout 与退出码。

镜像出来的参数形状是 **`{ args?: string[], cwd?: string }`**——`cwd` **按次给**
（node-cli / py-cli 的 `run` 都认它），必须是**存在的绝对路径**，不给就落在 entry 自己旁边。

**建站**：`init` 的目标由 `--dir` 给，跟 cwd 无关，所以这条不用带 cwd：

```
devkit.livedoc {"args":["init","--dir","<仓的绝对路径>","--title","<显示名>"]}
```

**`check` / `confirm` / `render` 也走这条**：它们认的是 cwd 里那份 `livedoc.config.mjs`，
所以把 cwd 指到那个仓的 `docs-site`：

```
devkit.livedoc {"args":["check"],"cwd":"<仓>\\docs-site"}
devkit.livedoc {"args":["confirm"],"cwd":"<仓>\\docs-site"}
devkit.livedoc {"args":["render","--target","ai"],"cwd":"<仓>\\docs-site"}
```

（在终端里也一样跑得了：`cd <仓>\docs-site` 之后 `pnpm doc` / `pnpm doc:confirm` /
`pnpm livedoc render --target ai`。两条路等价，选手边那条。）

别在件里进程内 import livedoc——CLI 形态的东西一律经 `gwbNodeCli` / `gwbPyCli` 登记，
不做总线命令、不进程内调。

# 从哪儿起手

写一个 gwb 件，只有一条路：**独立起一个仓（或文件夹），发一版进本机 registry，装进
home**。不存在「把源码摆在内核仓旁边跑起来」的近路——近路绕过了安装这个动作，
`exports` 漏一个子路径、`files` 少带一个目录，近路上都不显形，装出来才炸。

# 七步

**一、建仓。** `devkit.scaffold`（见上面那节），接着 `pnpm install && pnpm build`。
装不上依赖不挡交货，仓已经在盘上了，依赖可以事后重来。

**二、写 node 半**（`src/index.ts`）：`export const name = 'gwb-<短名>'` + `apply(ctx)`。
**动手写逻辑之前先看下一节「先写测试」。** 每改一步就重启内核看一眼日志——
`[host] 挂上 gwb-<短名>` 出来再往下写。

**三、要给人或 agent 调的能力，挂到命令总线上。** 用**局部注入**（可选依赖写法——
总线件不在，你的件照常挂）：

```ts
ctx.inject(['gwbCommands'], (c) => {
  c.effect(() => c.gwbCommands.register(
    { name: '<短名>.<动作>', plugin: '<短名>', description: '干什么：{ entryId: string, enabled?: boolean }' },
    handler))
})
```

handler 参数是 `unknown`，自己收窄（词汇表包的 `isRecord`）。相对 import 带 `.js`。

**`description` 必须写出参数形状。** 命令总线不带参数 schema，agent 看得见的只有这一句：
它得只看它就知道参数怎么给。写成 `{ entryId }`、`{ name, force? }` 这种一眼能抄的形状，
**无参数就明写「无参数」**——省略等于让调用方去猜，猜的结果是先错一次再读回执。
参数复杂到一行写不下的，回执里带一份完整说明（错误即文档，`devkit.scaffold` 就是这么干的），
但 description 里那句形状仍然要有。

**要让 agent 在顶层直接看见这条命令，登记时标 `top: true`**（`GwbCommandDef` 的字段，
命令总线 0.2.0 起）。**标了就是顶层，桥照它渲染，没有运行时名单**：MCP 桥固定开两枚工具
`gwb_command_list` / `gwb_command_run`，外加所有标了 `top: true` 的命令。顶层是**写件时
定下来的一件事**，不是装进软件之后再批的——所以默认不标，**标之前先问人**。

**四、发一版。** 先抬 `package.json` 的版本号，再：

```
pnpm publish --registry http://127.0.0.1:4873/ --no-git-checks
```

**同一个版本号永不重发**；发之前先问一句这个号在不在源上。源没起就发不了也装不了
（`registry.up`，或那个 ps1 旁路）。

**五、装进 home 看真效果。** 两条路：

- **正路**：`plugins.install { "pkg": "@godcreator02/gwb-<短名>" }`（可选 `spec` 指定版本）
  ——真跑 pnpm add，**然后自动加一条条目（默认启用）**，回执带新条目的 `entryId`
- **手动路**：home 目录里 `pnpm add @godcreator02/gwb-<短名>@<版本>`，再在 `cordis.yml`
  手写一条条目。`id` **必须手写**：不写 loader 当场发 8 位随机 hex 且首挂不写回，身份一直漂

**六、全套验一遍**（见「验机」节）。

**七、上市场——不用做。** 市场页（`plugins` 件的市场标签）**直接搜本机源**
（`plugins.search`，基址由 node 半从 pnpm 配置解析：装从哪条源来，搜就到哪去），
发上去就搜得到。没有白名单要登记——早先手册写的 `market/src/catalog.ts` 是老写法，
那个文件不存在。

已装的件市场不给「再装一份」按钮：多数件是服务提供方，第二条条目会抛
`service ... has been registered` 根本挂不上。真要第二条走 `plugins.add-entry`。

# 先写测试

**动手写逻辑之前先写测试。** 判据只有一条：**这段逻辑能不能不起进程、不开窗、只喂输入
看输出**。能，就写成测试；不能（要起子进程、要 Electron、要真装进 home），那不是不测，
是走「验机」那条路——两者不互相替代。

写不出测试常常是形状的问题：把判断从副作用里抠出来做成纯函数，测试自然就写得出。
devkit 自己就是这么分的——`scaffold.ts` / `daemon.ts` / `home.ts` 纯机可单测，真机器的盘
与进程另起两个 `node-*-deps.ts`。

模板建出来的仓自带 `vitest` 与一条起手测试（`tests/plugin.test.ts`：件的身份对不对），
门禁是 `pnpm check`（typecheck + oxlint + vitest）。真起子进程的用例**必打 `slow` 标签**，
日常 `pnpm test` 用 `--tags-filter=!slow` 跳过它们。

# 红线

比代码风格都上位的几条：

**一、源码里不许有任何路径指回别的仓。** 没有 tsconfig `paths`，没有 `link:` /
`workspace:`。（本地包经 `file:` 装进 home 是**安装动作**，不算——但发版上架仍是正路。）

**二、cordis 不写进 dependencies，写 dev。** 它只在 `apply` 的参数类型里用到；写进
dependencies，装进 home 就是第二份实例，Service 身份对不上——件挂不上，报错完全不指根因。

**三、依赖三档。** 运行时真 import → `peer`；只 import type 但**出现在导出的类型面**
→ `peer`（消费方必须解析得到）；只在实现内部用类型、不占导出面 → `dev`。

**四、产物两条硬要求。** 产物给 node 直接加载（loader 不打包），所以：相对 import
必须带 `.js`；产物里不许有没有依赖兜底的裸名 import——每一条裸名都得是 `package.json`
里声明过的 `dependencies` / `peerDependencies`。

**五、`requireKernel(ctx)` 不写进 `inject`。** `gwbKernel` 在根上下文 provide、永不撤销；
写进去只多一处挂不上的可能。

**六、`prepublishOnly` 别漏。** `pnpm typecheck` 不构建；少了这条，publish 把上一版的
`dist/` 原样发出去而且一声不吭——现象是「件挂上了但新写的东西全没生效」。
（模板里已经有了，别删。）

**七、类的私有字段用 TS `private` 不用 `#`。** cordis 给消费者派生 `Object.create(this)`，
`#` 槽不在原型链上，派生对象上一读就炸。

# 能力面菜单

内核给的面就七个名字（`@godcreator02/gwb-plugin-api` 0.1）：`GwbContext` / `GwbKernelApi` /
`GwbResult` / `GwbWindowApi` / `ShellBoot` / `requireKernel` / `isRecord`。类型住词汇表包，
运行时值走服务。`gwbKernel` 上只有三样：`dataDir` / `emit(payload)` / `setShell(url)`。

生态里每个件的服务，**按需取**——不上的面就不写 inject，少一条依赖少一处挂不上的可能：

| 面 | 怎么拿 | 什么时候要 |
| --- | --- | --- |
| 命令总线 | `inject: ['gwbCommands']` → `register` | 能力要被调就要（几乎一定）。界面、agent 走的是同一张表 |
| 说明书 | `skills/` 目录 + `gwbSkills.register`（局部） | 有多步流程或坑要讲给 agent 就要。**本件把 livedoc 的两份也挂上来了**：文档写什么读 skill「livedoc-docs」，记轨迹卡读 skill「trajectory」 |
| 设置 | `gwbSettings.define`（局部）→ `get`/`set` | **件的配置一律走这里，不吃 `cordis.yml` 的 `config`**。类型 `string` / `number` / `boolean` / `secret`。值跟条目走（分区是条目 id 的末段），`shared: true` 才落公共区 |
| 数据 | `gwbData.readDoc/writeDoc`（局部） | 要落盘状态就要。存 `<home>/data/<条目末段>/` |
| 窗格 | `gwbShell.registerPane` + client 半 | 要人看得见就要 |
| 外部 CLI | `gwbNodeCli` / `gwbPyCli` register（局部） | 要给外部脚本一个稳定入口就要。**CLI 形态的东西一律走这儿**，不做总线命令、不进程内调 |
| agent 桥 | 不用做——gwb-mcp 把总线开出去：agent 经 `gwb_command_run` 调你的命令 | 顶层工具只有固定两枚（`gwb_command_list` / `gwb_command_run`）加标了 `top: true` 的，要上顶层见上面第三步 |

inject 三种写法：`export const inject = [...]` 硬依赖（缺了不挂）；`static inject = [...]`
（Service 类）；`ctx.inject([...], fn)` 局部可选（缺了主件照挂）。

只为拿到 `declare module 'cordis'` 里那几个名字的类型时，写空 import 就够：
`import type {} from '@godcreator02/gwb-commands'`。

**件不吃 `cordis.yml` 的 `config`。** 一条条目除了 `id` 就没别的要写的了——可改的东西一律
`gwbSettings.define` 出来，人在「设置」里改、`get` 现读。理由是一份配置只该有一个正本：
写在 yml 里的那份界面看不见、agent 也不知道有它，人只能靠记得。

条目重挂（cordis 的 reconfigure）时模块不重载、只重跑 `apply`：要「重挂就该清掉」的状态放
`apply` 里，要「只要没换代码就该留着」的放模块顶层——放错地方两种都不报错。

# 带界面的件：浏览器半与样式

样板是件仓的 `plugins/hello`（`D:\unitfolders\26090709qzp\gwb-base-plugins`，0.2.0 起），
新件照它抄。要点：

**浏览器半**：`src/client/index.tsx` 导出 `mountPane(args, container) => { dispose() }`；
esbuild 打成 `dist/client.js`，只把 `react` / `react/jsx-runtime` / `react-dom` /
`react-dom/client` 四个裸名 external（页面 importmap 解析到共享包），其余一律打进本束——
外置错一个就是运行期 `Failed to resolve module specifier`。node 半注册窗格时自报
`client` 与 `style` 的 `file://` 地址，从自己的 `import.meta.url` 算。

**样式围栏是 Tailwind 前缀，不是选择器 scope。** 件自己就是一个完整的 Tailwind 入口，
`src/client/styles.css` 五行：

```css
@import 'tailwindcss/theme.css' theme(reference) prefix(<短名>);
@import '@godcreator02/gwb-tokens/theme.reference.css' theme(reference);
@import 'tailwindcss/utilities.css' layer(utilities) source(none);
@import 'tw-animate-css';
@source "./";
```

产物 `tailwindcss -i src/client/styles.css -o dist/style.css`（`@tailwindcss/cli`）。类名一律
`<短名>:flex` 这种：规则全页有效但只匹配本件元素，围栏来自名字唯一，不靠 DOM 祖先关系。
所以弹层 portal 到 body 照样有样式（shadcn 组件**不打任何 Portal 补丁**），容器上的
`data-gwb-plugin` 只是身份标记。`components.json` 的 `tailwind.prefix` 填短名，
`shadcn add` 拉下来的组件类名自带前缀；`cn` 包默认就能正确合并带前缀的类，不用配。

五条会静默的事：不引令牌映射面颜色类全空；不引 `tw-animate-css` 则 `animate-in` 一族全部
不生成、菜单永不动画；**忘加前缀的类一个字节都不出**——把 hello 的 `tests/prefix.test.ts`
抄一份钉住；`group` / `peer` 这类**标记类也要带前缀**（`logger:group-hover:*` 编出的选择器认的
是 `.logger\:group`，标记不带前缀永远不命中，守卫抓不到它，因为它本来就编不出规则）；
Tailwind 会把内置主题变量名也改掉（`--<短名>-spacing`），令牌只能经映射面送值。
lucide 图标身上的 `lucide lucide-xxx` 是它烤进 SVG 的身份属性，不是类名泄漏，别去管。

**窗格不是视口**：响应式用容器查询变体 `@sm:` / `@md:`，不用 `sm:`。外壳给每格的容器是
容器查询根（shell 0.1.1 起）。

# 发版与装机

```
pnpm publish --registry http://127.0.0.1:4873/ --no-git-checks
```

（`.npmrc` 已把 `@godcreator02` 指过去。）

**刚发的包为什么装得进去。** pnpm 11 起 `minimumReleaseAge` 默认 1440 分钟——包发布后
要放够一天才准装，刚 publish 的包年龄是 0 分钟，本该每次都被拦。这台机器在**用户级配置**
里放行了整个 scope：

```yaml
# C:\Users\<你>\AppData\Local\pnpm\config\config.yaml
minimumReleaseAgeExclude:
  - '@godcreator02/*'
```

**这个文件不在任何仓里**，换机器或重装会丢。症状是「在新机器上突然装不上刚发的包」，
报错只说版本太新，不会提醒你少了这份配置。`pnpm config get globalconfig` 报的就是它的位置。

**坑：home 里的 `pnpm-workspace.yaml` 会整份盖掉全局，不合并。** 那批老 home 里留着的
逐版本 `minimumReleaseAgeExclude` 清单，正好把全局那条通配挡在门外——在那种 home 里
装新版本仍会被拦，还得手动补一条。**开新 home 时别建这个文件**，让它吃全局的。

装完看日志：`[host] 挂上 gwb-<短名>`；没挂上看 `[loader]` 那行——它带
`ERR_MODULE_NOT_FOUND` 之类带完整路径的原因。

## 一键更新：一批新版本发完之后

发完（可能是好几个件的好几版）之后，把 home 里那份升上来只有一个动作：人在插件窗格点
**「全部更新」**，或 agent 经 MCP 调 **`plugins.update-all`**（无参数）。它一条命令走完：
查新版本 → 一次 `pnpm` 全升 → 升了的条目**逐条停用再启用**（即热重挂，`plugins` 件自己
排最后）→ 调 `shell.reload` 整页重载。回执按包报 `from → to`，并逐条说挂上了没有。

**不重启工作台，也没有回退。** 升坏了就是升坏了，往前修（再发一版再升），别指望它退回去。

**升到 `gwb-mcp` 自己时，经 MCP 触发的那条回执会丢**——桥跟着它一起重挂，调用方等不到返回。
那不是失败：重连之后调 `plugins.list` 核对谁挂上了、版本对不对，别当它没升成又升一次。

**升级与重挂在同一条命令里，中间别插别的命令。** 那一段时间里件正一个个下线上线，
这时候调任何别的命令，看到的都是半截状态。

整页重载单独也能要：`shell.reload`（无参数）。

# 验机

`pnpm typecheck` / `vitest` 全绿只说明源码站得住——它们**不依赖 build 产物**，吃的都是源码。
装出来能不能跑是另一件事，这一节管后者。

**「一键更新」不替这一节。** `plugins.update-all` 直接升日常那份 home，**跳过了「先在隔离
home 里验」这一步**。所以**发版前**在一个测试 home 里装一遍、按下面几条验完，仍然是 agent
的责任；人点「全部更新」是最后一步，不是验证的一步。

## 一、每次验开自己的 home

**一次验证一个新 home，不复用上一次留下的。** home 建在
`%APPDATA%\gwb-kernel\homes\<名>\`，**不用先创建**；不给名字就是 `default`——那是日常
那份，**别拿它验东西**。

**命名 `<被测件短名>-<yyMMddHHmm>`**：`data-2609070700`、`shell-2609071130`。这样列目录时
同一个件的挨在一起、各自按时间排，正好是清理时要的顺序。**不冲着某个件的验证**
（验从零装机、验没有外壳时的留白）前缀用一个说清这次验什么的短词：`boot-2609070700`、
`empty-2609070700`。名字得是 kebab-case——内核会当场拒掉不合规的（`../../x` 那种能跳出
`homes/`）。

**为什么不许复用**：一个 home 用上两天，里面就是十几个不同时刻装进去的版本快照，外加几个
仓里已经删掉、home 里还跑着的件。那时你不知道自己在验什么。

## 二、开之前：产物是不是新的

三条，漏一条就是在验旧代码，**而且界面看着一切正常**：

1. **改了件** → 必须 `pnpm build` **再**发版。件如果没有 `prepublishOnly`，`pnpm publish`
   会把上一版的 `dist/` 原样发出去——**这个坑真撞过**：件挂上了、不报错、新写的东西全没
   生效，查了一圈才想起产物是旧的
2. **改了内核** → 必须在 `apps/desktop` 跑 `pnpm build`。不构建，起的是上一次的产物
   （`devkit.home.new` 默认帮你做了这一步，除非给了 `skipBuild`）
3. **改了共享包**（`gwb-tokens` / `gwb-shared-react`）→ 它们装在 home 里，得重发再装

## 三、件进 home 只有一条路

抬版本号 → 发本机 registry → 在那个 home 里装 → 落 `cordis.yml` 条目。细节与那两个坑在
「发版与装机」节，不重复。

**不许走「直接读仓内源码」的近路。** 近路绕开了安装这个动作，于是开发时跑通的和装出来的
不是同一条路：`exports` 漏一个子路径、`files` 少带一个目录，在近路上都不显形，装出来才炸。

## 四、几种「看着成了」其实什么都没验

1. **拿日常 `default` 验**。验完那个 home 里就多了几个只为验证装的件、改过的 `cordis.yml`、
   落下的 `data/`——下次再验时它已经不干净了
2. **只看「挂上了」不看件真干了活**。日志里 `[host] 挂上 xxx` 只说明模块 import 成功、
   `apply` 被调用了。`apply` 里的 async 一旦静默 reject，现象就是「挂上了但什么都没发生」——
   **件里那条链必须自己 catch 并打出来**
3. **量颜色靠「等过渡跑完」**。窗口最小化时 Chromium 节流后台动画，等多久都可能读到起点值。
   先注一条 `transition:none` 再读；返回 `oklab(…)` 格式就是「还在过渡中」的指纹
4. **改了件没重发 / 改了内核没重 build**。第二节那三条，最隐蔽的一种：界面全对，验的是上一版

谁挂上了看 `plugins.list`——它的 `active` 判的是 fiber 真 ACTIVE，不是 fiber 建出来了
（inject 永远等不到的件也有 fiber，但 `active: false`）。

## 五、清理放在开新的那一刻

验完的 home 留着——人要亲自看一眼。但每次一个，一周就是二十个。所以清理动作**放在开新的
那一刻**，不是验完就清：`devkit.home.new` 的回执里本来就带着现有清单，先看一眼再
`devkit.home.rm` 旧的（或 `Remove-Item %APPDATA%\gwb-kernel\homes\<旧的> -Recurse -Force`）。

这样人永远有机会看，也永远不会积压超过一轮。成本不在盘上（`.pnpm` 是硬链接到全局 store，
实际增量很小），在你自己看不过来。

## 六、拿证据

**日志在 `%APPDATA%\gwb-kernel\homes\<名>\gwb.log`**——跟着 home 走，所以测试 home 的
日志天然是分开的。内核自己的话、件的、渲染层 `console-message` 转来的，三路都汇在这一份里
（单进程内核之后没有宿主子进程，也就没有 `logs\` 子目录）。

**从页面里取证走 node CLI `devkit.cdp-eval`**：起内核时带 `--remote-debugging-port=<端口>`
（Chromium 开关在命令行上就生效，内核不管它；9222 是别的实例常用的，换一个；或者
`devkit.home.new` / `open` 给 `"cdp": <端口>`），然后

```
devkit.cdp-eval {"args":["<端口>","<表达式文件>"]}
```

工作台没起的时候它的身体也能直接跑：

```powershell
node <devkit 包根>\bin\cdp-eval.mjs <端口> <表达式文件>
```

表达式是一个 async IIFE，返回值即读数。**放文件不放命令行**——PowerShell 的引号会截断它；
文件落 scratchpad，用完即废。两条实机撞出来的规矩：dockview 只渲染激活的那格，取证前先在它的
`.dv-tab` 上 `dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`；量颜色前先注一条
`transition: none`，读到 `oklab(…)` 格式就是还在过渡中。

# 你改的是内核，不是件

上面整份以「你在写件」为主线。改内核（`D:\unitfolders\26090705ymz\gwb-kernel`）时不一样的
只有起法——**不发版、不装机，直接 build 了起**：

```powershell
$env:GWB_HOME = 'boot-2609070700'          # <这次验什么>-<yyMMddHHmm>
cd D:\unitfolders\26090705ymz\gwb-kernel\apps\desktop
pnpm build                                 # tsc 直出 dist/，没有打包器（electron-vite 已不在）
.\run.cmd --remote-debugging-port=9334     # 要取证就带端口
```

这四步同时是**所有人的兜底**：`devkit.home.*` 那套要 devkit 跑在一个活着的 home 里，
一个 home 都没活着的时候，命令化那半也起不来，只能走这里。

home 命名、不许复用、四种假验收、清理时机、拿证据——那几节两边通用，不另写一套。

# 撞墙记录不在这

手册随件分发，把别处的一手记录抄进来只会得到一份靠人记得重发版才更新的副本。正本：

- 本件自己的文档站 `<devkit 包根>/docs-site`（依赖方向、模板占位符、livedoc 那条命令的形状）
- 内核仓文档站 `D:\unitfolders\26090705ymz\gwb-kernel\docs-site`（`trajectory/`：baseUrl
  为什么挂根 ctx、热挂载的形态、装机口为什么拆、知识随件走）
- 件仓文档站 `D:\unitfolders\26090709qzp\gwb-base-plugins\docs-site`（walls 与各件页）

自己撞到新墙记进**自己仓**的文档。判据：每一次发现「不伸手进别的仓就做不下去」，
那就是一堵墙。文档怎么写见 skill「livedoc-docs」，记轨迹卡见 skill「trajectory」——
两份随 livedoc 发，本件代为挂上。
