# gwb-devkit

**定位**：写插件工具链——建仓（模板即插件）、测试 home 开收、改一版看一版内循环、发正式版；随包发两份说明书（写插件手册 `gwb-devkit`、全生态发版规则 `gwb-release`）；外加一支包内 CLI（devkit.cdp 的身体 bin/cdp.mjs）。

## 提供

无服务——命令与手册就是它的产品；模板（scaffold 落「你好+计数」完整形状）与 instructions（门规）随包发。

## 依赖

`gwbCommands`（硬依赖，inject）、`gwbSettings`、`gwbNodeCli`、`gwbShell`、`gwbSkills`（后四样局部注入）

<!-- 来源 ../plugins/devkit/src/index.ts:39-39 · 新鲜 -->

```ts
export const inject = ['gwbCommands']
```

## 命令

命令清单不存卡——**现扫门的 `index`**（回执的命令行自带 plugin 包名归属）。
