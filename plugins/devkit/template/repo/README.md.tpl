# {{title}}

`{{pkg}}` —— gwb 内核线的模板插件。插件名 `{{pkgName}}`，命令名前缀 `{{name}}`。

仓是薄壳 workspace：**根壳自己没有代码**（`pnpm build` / `pnpm check` 都递归到成员包），件住
`plugins/{{name}}/`。加第二个件就是 `devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"}` 往
`plugins/` 再铺一个；非件包（repo-kit 那类仓侧工具）住 `packages/`，按需长。发团队源（gitea
个人源），装进 home。**scope 路由住用户级配置**（`@godcreator:registry`），本仓不写 `.npmrc`。

## 件包长什么样（`plugins/{{name}}/`，包内自足）

- **node 半**（`src/index.ts`）：挂载、注册一格窗格、登记一条 `{{name}}.ping` 命令；
- **浏览器半**（`src/client/`）：窗格里「你好 + 计数按钮」，Tailwind 前缀围栏（类名一律
  `{{cssPrefix}}:` 开头——cssPrefix 是短名剔除非小写字母，Tailwind 的 prefix 只收 a-z），react 走页面共享表；
- **自述**（`package.json` 的 description）：是什么、干什么 + 服务 / skill / 命令三格——`tests/self-report.test.ts` 钉着防漏（正本住 @godcreator/gwb-repo-kit）；
- **四份测试**：身份与注册、自述不撒谎、类名前缀守卫、产物守卫；
- tsconfig / vitest / oxlint 配置全在包内——不管这个包将来搬到哪个仓，形状不变。

改造成真插件：把窗格与 ping 换成你的东西——**改掉命令就顺手改 description 的三格**（服务 / skill / 命令），守卫会红。

## 跑起来（仓根）

```powershell
pnpm install
pnpm build          # 根壳递归：pnpm -r --filter "./plugins/*"（tsc + esbuild + tailwindcss 三步）——先 build：check 里的产物守卫吃 dist/
pnpm check          # 根壳递归：typecheck（node 半 + 浏览器半）+ oxlint + vitest
```

{{docsBlock}}

## 第一次装进工作台（验收）

1. `devkit.home.new` 开一个隔离 home，`devkit.dev {"home":"<名>","dir":"<仓根>","packages":["plugins/{{name}}"]}` 发出开发版并装进去（回执说没有条目可挂）；
2. `plugin-manager.install {"pkg":"{{pkg}}","spec":"<回执里那个 dev 号>"}` 建条目；
3. 命令面：`{{name}}.ping` 回 `{ok:true, data:{plugin, time}}`；
4. 窗格：看见「你好」，点按钮计数 +1；
5. 之后每改一版走 `devkit.dev`，发正式版走 `devkit.release {"dir":"<仓根>","packages":["plugins/{{name}}"]}`，发完当场升 default。

## 规矩在哪

- 写插件的路、内循环、验机、红线、能力面：说明书「gwb-devkit」
- 发版、抬版本号、依赖版本怎么写：说明书「gwb-release」
- 文档站怎么写、记轨迹卡：说明书「docfirst-docs」「trajectory」

说明书经工作台 `skill.read {"name":"<名>"}` 读，这儿不复述。
