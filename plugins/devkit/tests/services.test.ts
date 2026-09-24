import { describe, expect, it } from 'vitest'
import { contextFieldsOf, definitionOf, servicesOf } from '../src/services.js'

const SKILLS_DTS = [
  "import { Service, type Context } from 'cordis';",
  '/** 调用方拿到的接口。写 `inject: [\'gwbSkills\']` 或局部注入才有 */',
  'export interface GwbSkillsApi {',
  '    /** 此刻登记着的全部说明书 */',
  '    list(): GwbSkill[];',
  '    read(name: string, file?: string): Promise<string | undefined>;',
  '}',
  "declare module 'cordis' {",
  '    interface Context {',
  '        gwbSkills: GwbSkillsApi;',
  '    }',
  '}',
].join('\n')

const COMMANDS_DTS = [
  "import type { GwbResult } from '@godcreator/gwb-kernel-desktop';",
  '/** 命令总线对外的接口 */',
  'export declare class GwbCommands extends Service {',
  '    run(name: string, args?: unknown): Promise<GwbResult>;',
  '    list(): { name: string }[];',
  '}',
  "declare module 'cordis' {",
  '    interface Context {',
  '        gwbCommands?: GwbCommands;',
  '    }',
  '}',
].join('\n')

const SHELL_DTS = [
  "import type { GwbCommands } from '@godcreator/gwb-commands';",
  "import type { GwbDataApi } from '@godcreator/gwb-data';",
  'export interface GwbShellApi {',
  '    describeSelf(face: { title: string }): void;',
  '}',
  "declare module 'cordis' {",
  '    interface Context {',
  '        gwbCommands?: GwbCommands;',
  '        gwbData: GwbDataApi;',
  '    }',
  '}',
  "declare module 'cordis' {",
  '    interface Context {',
  '        gwbShell: GwbShellApi;',
  '    }',
  '}',
].join('\n')

const pkg = (name: string, version: string, ...declarationTexts: string[]) => ({ pkg: name, version, declarationTexts })

describe('contextFieldsOf：只认 declare module cordis 里的 interface Context', () => {
  it('一份声明里可以有几段，可选的带 ?', () => {
    expect(contextFieldsOf(SHELL_DTS)).toEqual([
      { service: 'gwbCommands', type: 'GwbCommands', optional: true },
      { service: 'gwbData', type: 'GwbDataApi', optional: false },
      { service: 'gwbShell', type: 'GwbShellApi', optional: false },
    ])
  })

  it('别的模块里的 interface Context 不算', () => {
    expect(contextFieldsOf("declare module 'other' {\n    interface Context {\n        x: X;\n    }\n}")).toEqual([])
  })
})

describe('definitionOf：取定义原文连同紧挨着的文档注释', () => {
  it('interface 带注释', () => {
    const got = definitionOf(SKILLS_DTS, 'GwbSkillsApi')
    expect(got?.startsWith('/** 调用方拿到的接口')).toBe(true)
    expect(got?.endsWith('}')).toBe(true)
    expect(got).toContain('list(): GwbSkill[];')
  })

  it('declare class 也算定义', () => {
    expect(definitionOf(COMMANDS_DTS, 'GwbCommands')).toContain('export declare class GwbCommands extends Service {')
  })

  it('type 别名取到分号', () => {
    expect(definitionOf('export type GwbPing = () => Promise<void>;\n', 'GwbPing')).toBe('export type GwbPing = () => Promise<void>;')
  })

  it('import type 只是引用，不算定义；名字前缀相同的别的类型不算', () => {
    expect(definitionOf(SHELL_DTS, 'GwbCommands')).toBeUndefined()
    const inlineTypeImport = "import { type GwbCommandDef, type GwbCommands } from './registry.js';\nexport interface GwbCommands {\n    list(): string[];\n}\n"
    expect(definitionOf(inlineTypeImport, 'GwbCommands')).toBe('export interface GwbCommands {\n    list(): string[];\n}')
    expect(definitionOf('export interface GwbCommandsExtra {\n}\n', 'GwbCommands')).toBeUndefined()
  })
})

describe('servicesOf：类型定义在自己声明里的是提供方，import 来的只是在用', () => {
  it('提供方、用它的一方各归各，按服务名排序', () => {
    const got = servicesOf([
      pkg('@godcreator/gwb-shell', '0.13.7', SHELL_DTS),
      pkg('@godcreator/gwb-commands', '0.5.0', COMMANDS_DTS),
      pkg('@godcreator/gwb-skills', '0.4.5', SKILLS_DTS),
    ])
    expect(got.map((entry) => entry.service)).toEqual(['gwbCommands', 'gwbData', 'gwbShell', 'gwbSkills'])
    const commands = got.find((entry) => entry.service === 'gwbCommands')!
    expect(commands.providers).toEqual(['@godcreator/gwb-commands@0.5.0'])
    expect(commands.declaredAlsoBy).toEqual(['@godcreator/gwb-shell@0.13.7'])
    expect(commands.optional).toBe(true)
    expect(commands.definition).toContain('run(name: string')
    expect(got.find((entry) => entry.service === 'gwbShell')?.providers).toEqual(['@godcreator/gwb-shell@0.13.7'])
  })

  it('没有提供方的服务照样列出，providers 为空、不带 definition', () => {
    const data = servicesOf([pkg('@godcreator/gwb-shell', '0.13.7', SHELL_DTS)]).find((entry) => entry.service === 'gwbData')!
    expect(data.providers).toEqual([])
    expect(data.declaredAlsoBy).toEqual(['@godcreator/gwb-shell@0.13.7'])
    expect('definition' in data).toBe(false)
  })

  it('两个包都带着定义：两个都列进 providers，definition 取先读到的那个', () => {
    const got = servicesOf([pkg('@godcreator/gwb-skills', '0.4.5', SKILLS_DTS), pkg('@godcreator/gwb-kernel-desktop', '0.5.0', SKILLS_DTS)])
    expect(got[0]?.providers).toEqual(['@godcreator/gwb-skills@0.4.5', '@godcreator/gwb-kernel-desktop@0.5.0'])
  })

  it('同一个包的几份 .d.ts 里重复声明同一个服务只记一次', () => {
    const got = servicesOf([pkg('@godcreator/gwb-skills', '0.4.5', SKILLS_DTS, SKILLS_DTS)])
    expect(got[0]?.providers).toEqual(['@godcreator/gwb-skills@0.4.5'])
  })
})
