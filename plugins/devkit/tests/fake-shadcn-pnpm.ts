import fs from 'node:fs'
import path from 'node:path'
import type { RunResult } from '../src/dev.js'
import type { PnpmInPluginDir } from '../src/shadcn-components.js'

/**
 * 假的 pnpm，照 probes/2609301700_shadcn-cli-in-scaffold/ 实测到的样子改插件包目录：
 * `dlx shadcn@latest add button --yes` 写出 button.tsx、把 cn 与 radix-ui 写进 dependencies，没装组件也 import 的 class-variance-authority；
 * `add -D <包[@范围]>…` 把点名的包从 dependencies 挪进 devDependencies（没写范围的记成 ^1.0.0），dependencies 空了就删掉这一项
 */

/** 实测 CLI 生成的 button.tsx 的 import 部分；组件正文与这里测的东西无关 */
export const BUTTON_IMPORTS = [
  'import * as React from "react"',
  'import { cva, type VariantProps } from "class-variance-authority"',
  'import { cn } from "cn"',
  'import { Slot } from "radix-ui"',
].join('\n')

/** 实测 CLI 写进 dependencies 的两项 */
export const CLI_DEPENDENCIES = { cn: '^0.4.0', 'radix-ui': '^1.6.7' }

export interface FakePnpm {
  calls: string[][]
  pnpm: PnpmInPluginDir
}

interface Behaviour {
  /** 让 dlx 那一步失败，回这段输出 */
  cliFails?: string
  /** CLI 报成功但不写组件文件 */
  cliWritesNothing?: boolean
  /** add -D 报成功但不改清单 */
  addDevDoesNothing?: boolean
}

function readManifest(pluginDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')) as Record<string, unknown>
}

function writeManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(pluginDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function specName(spec: string): { name: string; range: string } {
  const at = spec.indexOf('@', 1)
  return at === -1 ? { name: spec, range: '^1.0.0' } : { name: spec.slice(0, at), range: spec.slice(at + 1) }
}

export function fakePnpm(pluginDir: string, behaviour: Behaviour = {}): FakePnpm {
  const calls: string[][] = []
  const ok: RunResult = { ok: true, tail: '' }
  const pnpm: PnpmInPluginDir = (args) => {
    calls.push(args)
    if (args[0] === 'dlx') {
      if (behaviour.cliFails !== undefined) return Promise.resolve({ ok: false, tail: behaviour.cliFails })
      if (behaviour.cliWritesNothing === true) return Promise.resolve(ok)
      const ui = path.join(pluginDir, 'src', 'client', 'components', 'ui')
      fs.mkdirSync(ui, { recursive: true })
      fs.writeFileSync(path.join(ui, 'button.tsx'), `${BUTTON_IMPORTS}\n\nexport function Button() {\n  return null\n}\n`)
      const manifest = readManifest(pluginDir)
      writeManifest(pluginDir, { ...manifest, dependencies: { ...CLI_DEPENDENCIES } })
      return Promise.resolve(ok)
    }
    if (args[0] === 'add' && args[1] === '-D') {
      if (behaviour.addDevDoesNothing === true) return Promise.resolve(ok)
      const manifest = readManifest(pluginDir)
      const dependencies = { ...((manifest['dependencies'] as Record<string, string> | undefined) ?? {}) }
      const devDependencies = { ...((manifest['devDependencies'] as Record<string, string> | undefined) ?? {}) }
      for (const spec of args.slice(2)) {
        const { name, range } = specName(spec)
        delete dependencies[name]
        devDependencies[name] = range
      }
      const next: Record<string, unknown> = { ...manifest, devDependencies }
      if (Object.keys(dependencies).length === 0) delete next['dependencies']
      else next['dependencies'] = dependencies
      writeManifest(pluginDir, next)
      return Promise.resolve(ok)
    }
    return Promise.resolve({ ok: false, tail: `假 pnpm 不认识 ${args.join(' ')}` })
  }
  return { calls, pnpm }
}
