# {{name}}

`{{pkg}}` —— gwb 插件，由 devkit 的建仓模板生成。插件名 `{{pkgName}}`，命令名前缀 `{{name}}`。

仓是 pnpm workspace：**仓根是一个不发布的 private 包，自己没有代码**（`pnpm build` / `pnpm check` 都递归到各成员包），
插件放在 `plugins/{{name}}/`。加第二个插件用 `devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"}`，它在
`plugins/` 下再建一个插件包；不是插件的包（插件共用的库之类）放在 `packages/`，需要时再加。
包发到插件包 `package.json` 里 `publishConfig.registry` 写的源（建仓时的 `registry` 参数，不给是团队源），装进 home。
发布 token、各个包名范围从哪个源装（`@<范围>:registry=`）写在用户级 `~/.npmrc`，本仓不写 `.npmrc`。

## 插件包的结构（`plugins/{{name}}/`，配置都在包内）

- **node 侧**（`src/index.ts`）：`apply` 里注册一个窗格、登记一条 `{{name}}.ping` 命令，esbuild 打成一个 `dist/index.js`，
  用到的库打包进去。命令总线、外壳与内核包的接口类型都只 `import type`。peer 里写运行时从 home 里得到的三个包：内核包 `@godcreator/gwb-kernel-desktop`（范围 `^<版本号>`
  声明这个插件兼容哪些内核）、命令总线 `@godcreator/gwb-commands` 与外壳 `@godcreator/gwb-shell`，三个范围的下限都是建仓时
  那个 home 里的版本；以后用到别的插件也写进 peer：写在顶层 `inject` 里的写普通 peer，只在 `ctx.inject([...], cb)` 里用的
  在 `peerDependenciesMeta` 标 `optional: true`，都不另写 dev；`cordis` 只写 devDependencies（给本地构建与类型检查）；
- **浏览器侧**（`src/client/`）：窗格里显示「你好」和一个计数按钮。类名一律以 `{{cssPrefix}}:` 开头，样式只作用于本插件
  （cssPrefix 是短名去掉非小写字母，Tailwind 的 prefix 只收 a-z）；react 由页面的 importmap 提供（提供方是 shell），构建时不打包；
- **shadcn 组件**：按钮是 shadcn 官方的 `Button`，文件在 `src/client/components/ui/button.tsx`，建仓时由官方 CLI 添加。
  `components.json` 在插件包根（`tailwind.prefix` 就是 `{{cssPrefix}}`），`@/` 别名指向 `src/client`，写在包根 tsconfig、
  `src/client/tsconfig.json` 与 `build.ts` 三处；组件的依赖打包进 `client.js`，都在 devDependencies；
- **自述**（`package.json` 的 description）：一句话说这个插件做什么；
- **测试**：`tests/` 放自己的逻辑测试，模板不带。构建产物的包名 import、类名前缀、颜色只用主题令牌这些检查由 devkit 做：
  `devkit.dev` 构建之后查，`devkit.release` 发之前查；
- tsconfig / oxlint 配置全在包内——这个包以后搬到别的仓，配置不用改。

不要界面的插件，删掉 `src/client/`、`components.json`、`build.ts` 里浏览器侧那段（连同 `alias`）、包根 tsconfig 的 `paths`、
`build` 脚本里的 `tailwindcss` 一步与 `typecheck` 里浏览器侧那一步、`src/index.ts` 里注册窗格那几行与 `inject` 里的 `gwbShell`，
peer 里删外壳，dev 里删 `@tailwindcss/cli`、`tailwindcss`、`tw-animate-css`、`react`、`react-dom`、两个 `@types/react*`
与组件的依赖（`cn`、`radix-ui`、`class-variance-authority`）。

改成真插件：把窗格与 ping 换成你的东西，description 换成一句话说它做什么。
要提供扩展点服务就继承 cordis 的 `Service`：构建产物里有了按值 import 的 `cordis`，peer 里加上 `cordis`（别的包仍写 dev）。
用这个服务的插件要 `import type` 它的类型，这时再让构建输出类型声明（做法见说明书「gwb-devkit」第 4 步「提供服务」）；模板插件不提供服务，不输出。

开发界面前读 `skill.read {"name":"gwb-shell"}`：shadcn 官方组件、令牌、样式前缀、
多桌面浮层与视觉验收都以外壳的说明书为准。可点的控件一律用 shadcn 官方组件，不手写 `<button>`、`<input>`：
要别的组件在插件包目录运行 `pnpm dlx shadcn@latest add <组件…>`，再照那份说明书「接入 shadcn 组件」把 CLI 写进
`dependencies` 的包挪进 devDependencies、补装组件用到却没装的包。

## 构建与检查（仓根）

```powershell
pnpm install
pnpm build          # 递归构建 plugins/*：pnpm -r --filter "./plugins/*"（esbuild 打包 node 侧与浏览器侧、tailwindcss 生成样式）
pnpm check          # 递归检查：typecheck（node 侧 + 浏览器侧）+ oxlint + vitest
```

## 验收

模板插件装进隔离 home 后：命令 `{{name}}.ping` 回 `{ok:true, data:{plugin, time}}`；窗格里看见「你好」，点按钮计数加 1。

## 规矩在哪

- 写插件要守的规矩（依赖怎么写、服务怎么提供和使用、插件之间怎么交互、页面代码与 importmap、卸载清理、兼容哪个内核）与每条由哪道检查负责：gwb-lifecycle-plugins 仓（devkit 的源码仓）文档站的「写插件的规矩」一组页（`docs-site/content/docs/rules/`）
- 写插件的步骤、改一版看一版、测试 home、在隔离 home 里验证与取证、发版：说明书「gwb-devkit」
- 升版本号、依赖版本什么时候跟：说明书「gwb-release」
- 写文档站、记轨迹卡：说明书「docfirst-docs」「trajectory」

说明书用工作台命令 `skill.read {"name":"<名>"}` 读，这里不复述。
