{
  "name": "{{pkg}}",
  "version": "0.1.0",
  "description": "{{name}}：devkit 生成的模板插件，一个窗格与一条 ping 命令（改成真插件时换成一句话说它做什么）",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "keywords": ["gwb-plugin"],
  "publishConfig": { "registry": "{{registry}}", "access": "public" },
  "scripts": {
    "build": "node build.ts && tailwindcss -i src/client/styles.css -o dist/style.css",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p src/client/tsconfig.json",
    "lint": "oxlint . --deny-warnings",
    "test": "vitest run --passWithNoTests",
    "check": "pnpm run typecheck && pnpm run lint && pnpm run test"
  },
  "peerDependencies": {
    "@godcreator/gwb-kernel-desktop": "^{{kernelVersion}}",
    "@godcreator/gwb-commands": "^{{commandsVersion}}",
    "@godcreator/gwb-shell": "^{{shellVersion}}"
  },
  "devDependencies": {
    "@tailwindcss/cli": "^4.3.0",
    "@types/node": "^24.0.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "cordis": "4.0.0-rc.10",
    "esbuild": "^0.28.2",
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
