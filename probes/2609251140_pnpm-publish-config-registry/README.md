# pnpm 12 发包与查源时，publishConfig.registry、.npmrc 的范围行、命令行 --registry 谁说了算

## 问什么

1. `pnpm publish` 认不认包清单里的 `publishConfig.registry`；它和 `.npmrc` 的范围行（`@scope:registry=`）、
   命令行 `--registry` 同时出现时发到哪个源
2. `pnpm view` 不带 `--registry` 时是不是按范围行去问；带了 `--registry` 能不能改掉带范围的包名去问的源；
   有没有别的办法指定「这一次去问这个源」

## 怎么跑

```powershell
node --no-deprecation probes/2609251140_pnpm-publish-config-registry/run.mjs
```

零依赖。脚本在本机起两个假源 A、B（只记收到的请求；`PUT` 一律回 403，所以什么都不会真的发出去），用一份临时
userconfig（`NPM_CONFIG_USERCONFIG`）把 `@gwbprobe` 的范围行指向 B，按用例改包清单与命令行参数，看请求落在
哪个源上。`runs/` 下是依次跑的四次记录：`01` 只有发包的三种、`02` 补了「不写 publishConfig 但带 --registry」
与 view、`03` 补了指定源的几种写法、`04` 补了不带范围的包名。

## 结论

发包（`runs/04-all-cases.txt` 用例 1–4）：

* 写了 `publishConfig.registry` 就发到它：范围行指向别处、命令行再带 `--registry` 都盖不过它
* 没写 `publishConfig`：发到范围行指的源；命令行的 `--registry` 同样盖不过范围行

查源（用例 5–13）：

* `pnpm view` 不带 `--registry`：带范围的包名按范围行去问，不带范围的按 `registry=` 去问
* 带范围的包名：`--registry` 盖不过范围行（用例 6 仍去问 B）；`--config.@scope:registry=<地址>` 盖得过（用例 8 去问 A）；
  环境变量 `npm_config_@scope:registry`、`pnpm_config_@scope:registry` 都不生效；`--@scope:registry=` 是用法错误
* 不带范围的包名：`--registry` 生效（用例 12）
* `pnpm view <包>@<源上没有的号> version` 退出码 1（用例 11）

## 跑那次的环境

2026-09-25，Windows 11，Node 24.14.1，pnpm 12.4.2。
