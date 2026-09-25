{
  "name": "gwb-{{name}}-workspace",
  "private": true,
  "type": "module",
  "description": "{{name}} 的 pnpm workspace：插件放在 plugins/（装进 home、由 cordis 加载的包），不是插件的包放在 packages/（插件共用的库之类，需要时再加）。",
  "scripts": {
    "build": "pnpm -r --filter \"./plugins/*\" build",
    "check": "pnpm -r --no-bail check"
  },
  "engines": { "node": ">=24" }
}
