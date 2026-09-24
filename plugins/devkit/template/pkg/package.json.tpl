{
  "name": "{{pkg}}",
  "version": "0.1.0",
  "author": {"name": "godcreator"},
  "description": "{{title}}：devkit 生成的模板插件，一个窗格与一条 ping 命令（改成真插件时换成一句话说它做什么）",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist", "src"],
  "gwb": {
    "title": "{{title}}"
  },
  "keywords": ["gwb", "gwb-plugin"],
  "//repository": "发到 gitea 后补上这一条：{ type: git, url: https://git.tianshen02.online:28377/godcreator/<仓>.git }——gitea 发布时读它把包关联到仓（2026-09-18 实测：整个包关联到仓，仓与包不在同一个 owner 下也关联得上）",
  "scripts": {
    "//build": "三步：node 侧 tsc、浏览器侧 esbuild（外壳 gwb.shared 里的包名不打包，由页面的 importmap 提供）、样式 tailwindcss 按类名前缀输出",
    "build": "tsc -p tsconfig.build.json && node build.ts && tailwindcss -i src/client/styles.css -o dist/style.css",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p src/client/tsconfig.json",
    "lint": "oxlint . --deny-warnings",
    "test": "vitest run --passWithNoTests --tags-filter=!slow",
    "test:all": "vitest run --passWithNoTests",
    "check": "pnpm run typecheck && pnpm run lint && pnpm run test",
    "//prepublishOnly": "发版前强制构建一次。pnpm check 不构建，少了这条会把上一版的 dist 原样发出去，而且不报错",
    "prepublishOnly": "pnpm build"
  },
  "engines": { "node": ">=24" },
  "//peerDependencies": "peer 里的内核包声明这个插件兼容哪些内核：范围写 ^<验证时那个内核的版本号>，插件管理拿它和 home 里装的内核比。node 侧构建产物里没有按值 import cordis（只 import type），所以 peer 里没有 cordis。规矩见 devkit 文档站「兼容哪个内核」与「依赖怎么写」",
  "peerDependencies": {
    "@godcreator/gwb-kernel-desktop": "^{{kernelVersion}}"
  },
  "//devDependencies": "cordis 只写 dev（给本地构建与类型检查）。命令总线、外壳、词汇表包只取类型，运行时经 inject 使用；react 由页面的 importmap 提供，构建时不打包",
  "devDependencies": {
    "@godcreator/gwb-commands": "^0.4.5",
    "@godcreator/gwb-plugin-api": "^0.4.0",
    "@godcreator/gwb-shell": "^0.13.5",
    "@tailwindcss/cli": "^4.3.0",
    "@tailwindcss/node": "^4.3.0",
    "@types/node": "^24.0.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "cordis": "4.0.0-rc.10",
    "esbuild": "^0.27.0",
    "oxlint": "1.76.0",
    "oxlint-tsgolint": "7.0.2001",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "tailwindcss": "^4.3.0",
    "tw-animate-css": "^1.4.0",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
