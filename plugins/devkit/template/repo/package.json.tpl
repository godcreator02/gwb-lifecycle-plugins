{
  "name": "gwb-{{name}}-workspace",
  "private": true,
  "type": "module",
  "description": "{{title}} 的 pnpm workspace：插件放在 plugins/（装进 home、由 cordis 加载的包），不是插件的包放在 packages/（插件共用的库之类，需要时再加）。文档站 docs-site/ 自己一套依赖，不在 workspace 里。",
  "//scripts": "仓根自己没有代码，build/check 都递归到各成员包；pnpm -r 不含仓根，不会递归调用自己",
  "scripts": {
    "build": "pnpm -r --filter \"./plugins/*\" build",
    "check": "pnpm -r --no-bail check"
  },
  "engines": { "node": ">=24" }
}
