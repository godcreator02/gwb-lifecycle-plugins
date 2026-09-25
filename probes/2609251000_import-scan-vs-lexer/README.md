跑法：`pwsh ./run.ps1`（装本目录的依赖、跑 `run.mjs`，输出写进 `results.txt`；只要 node 24 与 pnpm）

# 手写的 import 词法扫描，和 es-module-lexer 在真实 ESM 上找到的一样吗

## 问什么

devkit 发版前检查改成按 JS 词法找产物里的 import（`import-scan.ts`，本目录是提交时的快照）。它是手写的，没有用解析器库：
正则与除号的区分、模板字面量里的插值、`}` 之后的 `/` 这几处是按上一个词猜的。要知道这种猜法在真实代码上错不错，
以及压成一行之后还对不对。另外看一眼块笔记 gwb-bn-core 的浏览器侧产物：旧的按行正则在它压成一行后找到了什么。

## 怎么做

- 语料：本目录装的 vitest、shiki、tailwindcss 及其依赖，`node_modules/.pnpm` 下 es-module-lexer 认作 ESM 的全部 `.js` / `.mjs`
- 答案：es-module-lexer 2.3.2（Vite 用的那个）找到的静态 import 与参数是字面量的动态 import
- 每个文件比两次：原样一次，esbuild 0.28.2 `minify: true` 压过之后再一次。比的是「static / dynamic + 说明符」的多重集合
- 块笔记：读 `D:\unitfolders\evew5-gwbapps\gwb-block-note\plugins\gwb-bn-core\dist\client.js`（仓里构建好的那份，
  块笔记 commit `1394025` 时的产物，不压行），原样与压成一行各跑一次旧写法（`old-regex.mjs`，devkit e71d842 的原样）与新写法

## 结论

- **语料 1243 个文件，原样与压成一行两轮，结果和 es-module-lexer 全部一致**（2753 条 import，不一致 0 个，扫描抛错 0 个）。
  语料里没有参数是无插值模板字面量的动态 import，这一类两边口径不同（es-module-lexer 记，新写法不记）没被检验到
- **块笔记产物压成一行后，旧写法错两头**：把代码生成器里 `t.write("import(")…t.write(")")` 之间那段文字当成了包名
  （`"),this[e.source.type](e.source,t),t.write("`），同时**漏掉了全部真实的 import**——这份产物是多个模块拼起来的，
  压行后 `import{…}from"react"` 落在行中间，旧写法的静态 import 正则锚在行首。新写法找到的是 react 的四个名字，和 es-module-lexer 一样
- 不压行的原样产物上，新旧写法找到的包名相同（react 的四个名字），不压行发的仓不会因为换写法被拦
- 速度：压成一行的 2.89 MB 产物扫一遍 177 ms

## 跑那次的环境

2026-09-25，Windows 11 Pro 10.0.26200，node v24.14.1，pnpm 12.4.2，gwb-devkit 分支 `fix/artifact-import-scan`。

## 文件

- `import-scan.ts`：被测的扫描，提交时 `plugins/devkit/src/import-scan.ts` 的快照（node 24 直接去类型运行）
- `old-regex.mjs`：旧的按行正则
- `run.mjs`：对照；`run.ps1`：装依赖加运行
- `results.txt`：输出
