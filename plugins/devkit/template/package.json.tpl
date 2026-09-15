{
  "name": "{{pkg}}",
  "version": "0.0.1",
  "author": {"name": "godcreator"},
  "description": "{{title}}：devkit 模板插件——一格窗格（你好 + 计数）与一条 ping 命令的最小完整形状",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist", "src", "catalog.md"],
  "scripts": {
    "//build": "三步：node 半 tsc、浏览器半 esbuild（react 外置走 importmap）、样式 tailwindcss 前缀直出",
    "build": "tsc -p tsconfig.build.json && node build.ts && tailwindcss -i src/client/styles.css -o dist/style.css",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p src/client/tsconfig.json",
    "lint": "oxlint . --deny-warnings",
    "test": "vitest run --passWithNoTests --tags-filter=!slow",
    "test:all": "vitest run --passWithNoTests",
    "check": "pnpm run typecheck && pnpm run lint && pnpm run test",
    "//prepublishOnly": "发版前强制构建一次。pnpm check 不构建，少了这条会把上一版的 dist 原样发出去——静默的",
    "prepublishOnly": "pnpm build"
  },
  "engines": { "node": ">=24" },
  "//peer": "硬依赖 gwbCommands 与 gwbShell（inject）；tokens 供样式映射面（≥0.1.1 零字面 fallback），shared-react 供页面 importmap。写 >= 不写 ^：caret 在 0.0.x 锁死 patch",
  "peerDependencies": {
    "@godcreator/gwb-plugin-api": ">=0.1.0",
    "@godcreator/gwb-commands": ">=0.2.0",
    "@godcreator/gwb-shell": ">=0.1.0",
    "@godcreator/gwb-tokens": ">=0.1.1",
    "@godcreator/gwb-shared-react": ">=0.0.2"
  },
  "devDependencies": {
    "@godcreator/gwb-plugin-api": "0.1.1",
    "@godcreator/gwb-repo-kit": "0.1.0",
    "@godcreator/gwb-commands": "0.4.0",
    "@godcreator/gwb-shell": "0.7.0",
    "@godcreator/gwb-tokens": "0.1.2",
    "@godcreator/gwb-shared-react": "0.0.4",
    "@tailwindcss/cli": "^4.3.0",
    "@tailwindcss/node": "^4.3.0",
    "@types/node": "^24.0.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "cordis": "4.0.0-rc.9",
    "esbuild": "^0.27.0",
    "oxlint": "1.76.0",
    "oxlint-tsgolint": "7.0.2001",
    "tailwindcss": "^4.3.0",
    "tw-animate-css": "^1.4.0",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
