# {{title}}

`{{pkg}}` —— gwb 内核线的一个件。插件名 `{{pkgName}}`，命令名前缀 `{{name}}`。

一仓一包一插件，仓根即包根。发本机 registry，装进 home。

## 跑起来

```powershell
pnpm install
pnpm check          # typecheck + oxlint + vitest
pnpm build
```

{{docsBlock}}

## 发版与装机

```powershell
# 先抬 package.json 的版本号，同一个版本号永不重发
pnpm publish --registry http://127.0.0.1:4873/ --no-git-checks
```

再调 `plugins.install {"pkg":"{{pkg}}"}`，或者在 home 里手动 `pnpm add` 加一条
`cordis.yml` 条目（`id` 必须手写）。

本机源没起：调 `registry.up`（开发套件那条命令；源目录在它的设置项 `registry-dir` 里）。

## 规矩在哪

红线七条、能力面菜单、发版装机、实机验机——全在 skill「gwb-devkit」里（随
`@godcreator02/gwb-devkit` 分发），不在这儿复述。文档写什么见 skill「livedoc-docs」，
记轨迹卡见 skill「trajectory」——两份随 `@godcreator02/live-doc-cli` 分发，devkit 代为挂上。
