{
  "name": "{{pkg}}",
  "version": "0.0.1",
  "description": "{{title}}：一个 gwb 件",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist", "src"],
  "gwb": { "title": "{{title}}" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "prepublishOnly": "pnpm build"
  },
  "engines": { "node": ">=24" },
  "peerDependencies": {
    "@godcreator02/gwb-plugin-api": ">=0.1.0"
  },
  "devDependencies": {
    "@godcreator02/gwb-plugin-api": "0.1.0",
    "@types/node": "^24.0.0",
    "cordis": "4.0.0-rc.9",
    "typescript": "^7.0.2"
  }
}
