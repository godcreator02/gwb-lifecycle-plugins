# {{title}}

`{{pkg}}` —— gwb 插件，由 devkit 的建仓模板生成。插件名 `{{pkgName}}`，命令名前缀 `{{name}}`。

仓是 pnpm workspace：**仓根是一个不发布的 private 包，自己没有代码**（`pnpm build` / `pnpm check` 都递归到各成员包），
插件放在 `plugins/{{name}}/`。加第二个插件用 `devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"}`，它在
`plugins/` 下再建一个插件包；不是插件的包（repo-kit 那类只在仓里用的测试工具）放在 `packages/`，需要时再加。
包发到团队源（gitea 个人源），装进 home。**`@godcreator` 对应哪个源写在用户级 `~/.npmrc`**（`@godcreator:registry`），本仓不写 `.npmrc`。

## 插件包的结构（`plugins/{{name}}/`，配置都在包内）

- **node 侧**（`src/index.ts`）：`apply` 里注册一个窗格、登记一条 `{{name}}.ping` 命令。命令总线、外壳、词汇表包都只 `import type`，
  构建产物里没有包名 import，所以清单里没有 peer，这几个包连同 `cordis` 都写在 devDependencies；
- **浏览器侧**（`src/client/`）：窗格里显示「你好」和一个计数按钮。类名一律以 `{{cssPrefix}}:` 开头，样式只作用于本插件
  （cssPrefix 是短名去掉非小写字母，Tailwind 的 prefix 只收 a-z）；react 由页面的 importmap 提供（提供方是外壳），构建时不打包；
- **自述**（`package.json` 的 description）：是什么、做什么，加上服务 / skill / 命令三项计数——`tests/self-report.test.ts` 检查它与源码对得上（检查逻辑在 @godcreator/gwb-repo-kit）；
- **四份测试**：插件名与注册、自述与源码一致、类名前缀、构建产物（node 侧的包名 import 只有 node 内置模块、`electron`、`cordis`，浏览器侧只有外壳 `gwb.shared` 里的名字）；
- tsconfig / vitest / oxlint 配置全在包内——这个包以后搬到别的仓，配置不用改。

改成真插件：把窗格与 ping 换成你的东西——**改了命令就同时改 description 的三项计数**（服务 / skill / 命令），不改自述测试会失败。
要提供扩展点服务就继承 cordis 的 `Service`：构建产物里有了按值 import 的 `cordis`，清单里加 peer `cordis`（别的包仍写 dev）。

开发界面前读 `skill.read {"name":"gwb-shell"}`：shadcn 官方组件配置、令牌、样式前缀、
多桌面浮层与视觉验收都以外壳的说明书为准。模板只带一个最简单的窗格，组件照那份说明书接入。

## 构建与检查（仓根）

```powershell
pnpm install
pnpm build          # 递归构建 plugins/*：pnpm -r --filter "./plugins/*"（tsc、esbuild、tailwindcss 三步）
pnpm check          # 递归检查：typecheck（node 侧 + 浏览器侧）+ oxlint + vitest；产物测试读 dist/，没构建时整组跳过，所以先 build
```

{{docsBlock}}

## 第一次装进工作台验证

1. `devkit.home.new {"short":"{{name}}"}` 开一个隔离 home，`devkit.dev {"home":"<名>","dir":"<仓根>","packages":["plugins/{{name}}"]}` 发出开发版并装进去（回执 note 说没有条目可重新加载）；
2. `plugin-manager.install {"pkg":"{{pkg}}","spec":"<回执里那个开发版号>"}` 建条目；
3. 命令：`{{name}}.ping` 回 `{ok:true, data:{plugin, time}}`；
4. 窗格：看见「你好」，点按钮计数加 1；
5. 之后每改一版都用 `devkit.dev` 在隔离 home 里验证，不拿 `default` 验证。

## 发版

1. 在隔离 home 里用 `devkit.dev` 验过；`gwb.testedKernel` 写验证时那个内核的版本号（建仓时写的是运行建仓命令的那个内核）；
2. 照说明书「gwb-release」升 `package.json` 的版本号并提交：0.x 里只有破坏契约（改名或删掉命令、服务、窗格 id，改参数或回执的形状，改磁盘上的数据格式）才升 x，其余升 y；同一个号不重发；
3. `devkit.release {"dir":"<仓根>","packages":["plugins/{{name}}"]}`：仓根 git 工作区不干净就拒；构建之后先做发版前检查（peer 只能是 `cordis`、构建产物里的包名 import、`@godcreator` 包的 dev 范围包含源上 latest、`gwb.testedKernel` 与运行中的内核在同一条版本线上等），没过一个都不发；
4. 发完当场升级 default：插件管理窗格点「全部更新」或调 `plugin-manager.update-all`；default 里还没有这个插件时用 `plugin-manager.install {"pkg":"{{pkg}}"}`。

## 规矩在哪

- 写插件要守的规矩（依赖怎么写、服务怎么提供和使用、插件之间怎么交互、页面代码与 importmap、卸载清理、`gwb.testedKernel`）与每条由哪道检查把关：gwb-devkit 仓文档站的「写插件的规矩」一组页（`docs-site/content/docs/rules/`）
- 写插件的步骤、改一版看一版、测试 home、在隔离 home 里验证与取证：说明书「gwb-devkit」
- 发版、升版本号、依赖版本什么时候跟：说明书「gwb-release」
- 写文档站、记轨迹卡：说明书「docfirst-docs」「trajectory」

说明书用工作台命令 `skill.read {"name":"<名>"}` 读，这里不复述。
