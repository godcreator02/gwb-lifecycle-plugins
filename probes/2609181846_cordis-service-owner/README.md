# cordis 的服务由谁提供——这条命令拿得到吗

## 问什么

`devkit.services` 想报「这台 home 里有哪些 cordis 服务、各是谁提供的」。问题是：**cordis
4.0.0-rc.9 的运行时里，服务 → 提供者这个映射能不能稳定读出来、读出来长什么形状。**

## 怎么跑

```bash
# devkit 先发进一个隔离 home（本仓的 devkit.dev 会构建 + 发 dev 版 + 装 + 重挂）
node <总控台>/out/upgrade/r4-light-up.cjs devkit
# 第一次要在那个 home 里建条目（之后每趟 devkit.dev 自己重挂）
node <总控台>/out/upgrade/r4-cdp.cjs <home 名> plugin-manager.install '{"pkg":"@godcreator/gwb-devkit","spec":"<回执里的 dev 号>"}'
# 问一次
node <总控台>/out/upgrade/r4-cdp.cjs <home 名> devkit.services
```

读数在 `runs/`：每趟一份原始回执。

## 结论

**能读到，形状是 per-fiber 的 `Fiber.store`（公开字段），不是 `ctx.reflect.store`。** 三段读数的经过：

1. `runs/01-reflect-store.txt`——按 `reflect.d.ts` 的 `store: Dict<Impl, symbol>` 读
   `ctx.reflect.store`：**空表**。rc.9 的类型声明里有这一格，运行时不在那儿。
2. `runs/02-attribution.txt`——改读 `ctx.fiber` 链 + `ctx.registry.entries()` 里各件
   `runtime.fibers` 的 `fiber.store`：服务全出来了，但**归属错**——`gwbShell` 被算到
   `home:baseui` 头上。原因：注入作用域的 fiber 里也放着一份解析来的 impl（那是它**消费**的）。
   判据是 cordis 自己那条：`impl.fiber === fiber` 才算本 fiber 提供的（`lib/index.js` 里
   服务解析就靠这句分辨归属）。加上这道过滤。
3. `runs/03-final.txt`——十条服务，条条对得上：`gwbShell → home:shell → @godcreator/gwb-shell`、
   `gwbData → home:data`、`gwbUnitFolder → home:unit-folder`，内核自己挂的 `gwbKernel` 没有条目
   （如实不写），cordis 的 loader 件退回自报名 `Loader`。

形状（条数：那台 home 十条）：

```json
{ "service": "gwbShell", "entryId": "home:shell", "pkg": "@godcreator/gwb-shell" }
{ "service": "gwbKernel" }
```

## 跑那次的环境

- 2026-09-18 18:46（+08:00），Windows 10.0.26200，node v24.14.1，pnpm 12.4.2
- 宿主：安装版内核 0.2.6；被测 `@godcreator/gwb-devkit@0.16.6-dev.202609181846`（devkit 仓 `ca2d647` 之后的树）
- 隔离 home：`lightup-2609181749`（条目：commands / data / settings / skills / shell / unit-folder /
  plugin-manager / baseui + 本探查用挂上的 devkit），cordis `4.0.0-rc.9`
- 依据（读的是装出来的编译产物，不是文档）：
  `~/.pnpm store` 里的 `cordis@4.0.0-rc.9/lib/fiber.d.ts`（`store: Dict<Impl> | undefined` 是公开字段）、
  `lib/index.js` 里服务解析那段 `const impl = fiber.store?.[prop]` 与 `if (impl.fiber !== this) continue`
