{
  "name": "gwb-{{name}}-workspace",
  "private": true,
  "type": "module",
  "description": "{{title}} 的工作区：件住 plugins/（装进 home 的 cordis 件），非件包住 packages/（repo-kit 那类仓侧工具，按需）。文档站 docs-site/ 自己一套依赖，不进 workspace。",
  "//scripts": "根壳自己没有代码，build/check 都递归到成员包；pnpm -r 不含根，不会自递归",
  "scripts": {
    "build": "pnpm -r --filter \"./plugins/*\" build",
    "check": "pnpm -r --no-bail check"
  },
  "engines": { "node": ">=24" }
}
