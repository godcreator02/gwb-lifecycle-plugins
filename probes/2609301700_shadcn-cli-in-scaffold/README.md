## 问什么

建仓命令写完插件文件后，能不能不经人手、在插件包目录直接运行 shadcn 官方 CLI 把 `button` 加进来？CLI 会不会提问、
用哪个包管理器装依赖、依赖写进哪张表、组件用到的包装没装全？装完能不能用一次 `pnpm add -D` 全部放进 devDependencies？

## 怎么运行

```powershell
pwsh -NoProfile -File run.ps1
```

要联网；用 PATH 上的 pnpm。CLI 钉在 4.21.0（建仓命令用的是 `shadcn@latest`）。输出与 `runs/02-workspace-and-alone.txt` 对照。
A 组：插件包在 workspace 仓的 `plugins/` 下，仓根有 `pnpm-workspace.yaml`，同建仓命令生成的仓；B 组：同一个包单独放，往上没有 pnpm 的任何文件。

## 结论

- 包根有 `components.json`、包根 tsconfig 有 `@/*` → `./src/client/*` 时，`pnpm dlx shadcn@4.21.0 add button --yes` 不提问，
  组件写到 `src/client/components/ui/button.tsx`，包根下没有名字叫 `@` 的目录；A 组 10–13 秒（pnpm store 里已有缓存）
- CLI 按仓里的文件选包管理器：A 组用 pnpm，锁文件写在仓根；B 组用 npm，写出 `package-lock.json`
- B 组第一次运行时包里只有 react 19.2.8、没有 react-dom，npm 取到 react-dom 19.3.0，它的 peer 要 react ^19.3.0，报 ERESOLVE、
  退出码 1（`runs/01-alone-without-react-dom-npm-eresolve.txt`）；补上同版本的 react-dom 后 npm 也装得上
- CLI 把 `cn ^0.4.0`、`radix-ui ^1.6.7` 写进 `dependencies`；`button.tsx` 还 import 了 `class-variance-authority`，CLI 没装
- `pnpm add -D cn@^0.4.0 radix-ui@^1.6.7 class-variance-authority` 一次做完：两项从 `dependencies` 挪进 devDependencies、
  范围照旧，`class-variance-authority` 补成 `^0.7.1`，`dependencies` 空了整项删掉

没进脚本、在会话的临时目录里做过的：用 devkit 源码里建仓命令的同一串函数（`planScaffold` → `renderTemplate` → `writeRepo` →
`pnpmForComponents` → `addTemplateComponents`）真生成一个仓，约 16 秒加完组件；插件包目录里 `pnpm run build`、`pnpm run check`
都通过，devkit 的样式检查（`styleProblems`）与产物检查（`artifactProblems`）都没有报问题。那个临时目录很深，仓根的
`pnpm build` / `pnpm check`（`pnpm -r`）写 `node_modules\.pnpm-task-run-state-v1\<64 位哈希>….jsonl` 时超过 Windows 260 字符的
路径上限，报「The system cannot find the path specified. (os error 3)」，与模板无关。

## 运行那次的环境

2026-09-30，Windows 11（10.0.26200），node v24.14.1，pnpm 12.4.2，shadcn 4.21.0（当天 npm 上的 latest）；
仓 gwb-lifecycle-plugins 在 555a327 之上、devkit 0.25.4 的改动还没提交时。脚本不读仓里的代码。
