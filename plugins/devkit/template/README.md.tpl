# {{title}}

`{{pkg}}` —— gwb 内核线的模板插件。插件名 `{{pkgName}}`，命令名前缀 `{{name}}`。

一仓一包一插件，仓根即包根。发团队源（NAS registry），装进 home。**scope 路由住用户级 pnpm 配置**
（`@godcreator:registry`），本仓不写 `.npmrc`。

## 这是什么形状

- **node 半**（`src/index.ts`）：挂载、注册一格窗格、登记一条 `{{name}}.ping` 命令；
- **浏览器半**（`src/client/`）：窗格里「你好 + 计数按钮」，Tailwind 前缀围栏（类名一律
  `{{cssPrefix}}:` 开头——cssPrefix 是短名剔除非小写字母，Tailwind 的 prefix 只收 a-z），react 走页面共享表；
- **身份卡**（`catalog.md`）：是谁、提供什么、靠谁、有什么命令；
- **四份测试**：身份与注册、catalog 不撒谎、类名前缀守卫、产物守卫。

改造成真插件：把窗格与 ping 换成你的东西——**可删可改，删了命令记得连 tests/catalog.test.ts 一起改**。

## 跑起来

```powershell
pnpm install
pnpm build          # tsc + esbuild + tailwindcss 三步——先 build：check 里的产物守卫吃 dist/
pnpm check          # typecheck（node 半 + 浏览器半）+ oxlint + vitest
```

{{docsBlock}}

## 发版与装机（六步验收）

```powershell
# 先抬 package.json 的版本号，同一个版本号永不重发
pnpm publish --no-git-checks   # scope 路由自动走对源，别手写 --registry
```

然后：

1. 装进隔离 home：`plugin-manager.install {"pkg":"{{pkg}}"}`（该进的 peer 会一并装上）；
2. 命令面验证：经 MCP 门的 `run` 调 `{"command":"{{name}}.ping"}` 回 `{ok:true, data:{plugin, time}}`；
3. 打开工作台那一格窗格：看见「你好」，点按钮计数 +1；
4. 发完就去升 default home（人点「全部更新」或 `plugin-manager.update-all`）——攒着不升，
   agent 读到的手册与命令都停在旧版。

源是 gitea 个人源（常驻，无需起停）；地址见用户级 `~/.npmrc` 的 `@godcreator` scope 行。

## 规矩在哪

红线七条、能力面菜单、发版装机、实机验机——全在 skill「gwb-devkit」里（随
`@godcreator/gwb-devkit` 分发），不在这儿复述。文档写什么见 skill「docfirst-docs」，
记轨迹卡见 skill「trajectory」——两份随 `@godcreator/gwb-docfirst-workflow` 件分发。
不描述任何代码的通用开发纪律（先盘问、并行派活、代码自解释）也随那个件发。
