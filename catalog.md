# gwb-devkit

**定位**：写插件工具链——建仓（模板即插件）、写插件手册（随包发）、本机源起停、测试 home 开收、改一版看一版内循环；外加两支包内 CLI（devkit.cdp 的身体 bin/cdp.mjs、起停源兜底 bin/registry.mjs）。

## 提供

无服务——命令与手册就是它的产品；模板（scaffold 落「你好+计数」完整形状）与 instructions（门规）随包发。

## 依赖

`gwbCommands`（硬依赖，inject）、`gwbSettings`、`gwbNodeCli`、`gwbShell`、`gwbSkills`（后四样局部注入）

<!-- 来源 ../src/index.ts:45-45 · 未确认 -->

```ts
export const inject = ['gwbCommands']
```

## 命令

命令清单不存卡——**现扫 /surface**（ 取这一组的形状）。
