import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import path from 'node:path'
import type { PackageTypeDeclarations } from './services.js'

// 读 home 的 node_modules，没有单元测试；从 .d.ts 原文里认服务在 services.ts

/** home 顶层 node_modules 里的包目录：`name` 与 `@scope/name` 两层，跳过 `.pnpm`、`.bin` 这类点开头的 */
function packageDirsOf(homeDir: string): string[] {
  const modulesDir = path.join(homeDir, 'node_modules')
  const packageDirs: string[] = []
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !isDirectoryLike(entry)) continue
    const full = path.join(modulesDir, entry.name)
    if (!entry.name.startsWith('@')) {
      packageDirs.push(full)
      continue
    }
    for (const scoped of readdirSync(full, { withFileTypes: true })) {
      if (isDirectoryLike(scoped)) packageDirs.push(path.join(full, scoped.name))
    }
  }
  return packageDirs
}

/** pnpm 在 home 顶层放的是指向 `.pnpm` 的目录链接 */
function isDirectoryLike(entry: Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink()
}

/** 包目录下全部 .d.ts（不进它自己的 node_modules） */
function declarationFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...declarationFilesUnder(full))
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(full)
    }
  }
  return files
}

/** home 里每个包的名字、版本与全部 .d.ts 原文；清单读不出、缺 name 或 version 的包当场报错 */
export function readHomeTypeDeclarations(homeDir: string): PackageTypeDeclarations[] {
  return packageDirsOf(homeDir).map((packageDir) => {
    const manifestFile = path.join(packageDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { name?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`${manifestFile} 缺 name 或 version`)
    }
    return {
      pkg: manifest.name,
      version: manifest.version,
      declarationTexts: declarationFilesUnder(packageDir).map((file) => readFileSync(file, 'utf8')),
    }
  })
}
