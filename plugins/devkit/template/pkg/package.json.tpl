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
  "keywords": ["gwb", "gwb-plugin"],
  "publishConfig": { "registry": "{{registry}}" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node build.ts && tailwindcss -i src/client/styles.css -o dist/style.css",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p src/client/tsconfig.json",
    "lint": "oxlint . --deny-warnings",
    "test": "vitest run --passWithNoTests",
    "check": "pnpm run typecheck && pnpm run lint && pnpm run test",
    "prepublishOnly": "pnpm build"
  },
  "engines": { "node": ">=24" },
  "peerDependencies": {
    "@godcreator/gwb-kernel-desktop": "^{{kernelVersion}}",
    "@godcreator/gwb-commands": "^0.5.0",
    "@godcreator/gwb-shell": "^0.13.7"
  },
  "devDependencies": {
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
