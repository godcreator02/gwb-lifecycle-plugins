---
title: "{{title}}"
description: 插件 {{pkgName}}（包 {{pkg}}）的功能、接口、依赖与不做的事
---

**本页回答**：插件 `{{pkgName}}` 做什么；对外提供哪些命令和窗格；依赖哪些服务；不做什么。

本页是 `devkit.scaffold` / `devkit.scaffold.plugin` 按模板插件生成的草稿。把模板改成真插件时，按实际情况改写每一节。

## 功能

一个窗格，显示「你好」和一个计数按钮；一条命令 `{{name}}.ping`，返回插件名与当前时间，用来确认插件已经加载。

## 接口

| 种类 | 名字 | 说明 |
| --- | --- | --- |
| 命令 | `{{name}}.ping` | 无参数。返回 `{ ok: true, data: { plugin, time } }` |
| 窗格 | `main` | 标题「{{title}}」 |

不提供服务。

## 依赖

| 服务 | 提供方 | 用来做什么 |
| --- | --- | --- |
| `gwbCommands` | 命令总线 `@godcreator/gwb-commands` | 登记命令 `{{name}}.ping` |
| `gwbShell` | 外壳 `@godcreator/gwb-shell` | 登记窗格 `main` |

两个服务都写在 `src/index.ts` 的 `inject` 里，缺一个插件就不加载。

浏览器侧的 react 由页面的 importmap 提供（提供方是外壳），构建时不打包。

## 不做的事

- 不保存数据：计数只在窗格的本地状态里，关掉窗格就没了
- 没有设置项
