跑法：`pwsh ./run.ps1`（装本目录的依赖、跑 `run.mjs`，输出写进 `runs/01.txt`；只要 node 24 与 pnpm）

# Tailwind 4 编样式入口时 @scope 留不留得下，当根用的前缀类编不编得出规则

## 问什么

devkit 的样式检查要放行「放进根带前缀的 `@scope` 块里的第三方 css」。两件事要先知道：Tailwind 4 编样式入口时
`@scope` 块会不会原样留进产物、压缩后是什么写法（检查要认得它）；元素上写的根类（`bn:render-root`）
在源码层检查里会不会被当成「带前缀却编不出规则」报出来。

## 怎么做

用 `@tailwindcss/node` 4.3.3 的 `compile` 编一份写了 `prefix(bn)`、两个 `@scope` 块（一个带 `to (…)` 界限、一个嵌在
`@media` 里）的样式入口；先交给编译器候选 `bn:flex`，再交 `bn:render-root`，比较两次输出变没变（devkit 源码层检查就是
这么判「编得出规则」的）；最后用同一个包的 `optimize({ minify: true })` 压缩，看构建产物里的写法。

## 结论

- `@scope` 块原样留进输出，嵌在 `@media` 里的也在
- 压缩后写成 `@scope(.bn\:render-root) to (.bn\:hole){…}`：`@scope` 与括号之间没有空格，检查的解析要认这种写法
- `bn:render-root` 单独编不出规则（输出没变）：只当 `@scope` 根用的类，源码层检查会报「带前缀却编不出规则」，
  要在检查里另外放行

## 跑那次的环境

2026-09-26，Windows 11 Pro 10.0.26200，node v24.14.1，pnpm 12.4.2，tailwindcss 与 @tailwindcss/node 4.3.3，
gwb-lifecycle-plugins commit `2e93397`。

## 文件

- `run.mjs`：编译、比较、压缩；`run.ps1`：装依赖加运行
- `runs/01.txt`：输出
