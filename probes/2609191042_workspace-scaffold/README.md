# 薄壳模板能不能在真实 pnpm 里站住

2026-09-19：scaffold 模板改成「只有一种仓形」——薄壳 workspace（根 private 壳 +
`plugins/<短名>/` 件包，两区装配 repo/ + pkg/）。单元测试钉的是装配输出的形状；
**新根形在真实 pnpm 里站不站得住**（`pnpm -r --filter "./plugins/*"` 单成员仓、
oxlint 从件包 cwd 找配置、根壳 check 递归）只有真装一次才知道。

## 跑了什么

`run.ps1`：`run.mjs` 用刚构建的 `dist/scaffold.js` 铺一个 `probe-hello` 仓到 `gen/ws-probe`
（不进 git），然后仓根 `pnpm install` → `pnpm build` → `pnpm check`，全程记 `results.txt`。

## 结论

- **install**：`Scope: all 2 workspace projects`，2 秒装完（root 壳无依赖，件包 devDeps 各自落位）
- **build**：根壳 `pnpm -r --filter "./plugins/*"` 单成员照跑——tsc + esbuild + tailwindcss 三步全过
- **check**：根壳 `pnpm -r --no-bail` 递归到件包；oxlint 从件包 cwd 命中包内 `.oxlintrc.json`
  （0 warnings 0 errors）；vitest 四份测试 15 条全绿
- **树形**：根上四件（薄壳 package.json / pnpm-workspace.yaml / README / .gitignore），
  件包全套在 `plugins/probe-hello/`

新模板的根形站得住。老裸根单件仓的存量不迁（随触随迁），见同日轨迹卡。
