/**
 * MDX 组件的 React 表。docfirst.config.mjs 声明生成 markdown 时每个组件变成什么文字，这里给站上渲染用的组件。
 * 表的类型由 registry.ts 的名单决定：少一个、多一个都编译不过；
 * 跟 docfirst.config.mjs 的规则表齐不齐，由 scripts/verify-roster.mjs 核对。
 * 先用 fumadocs 的默认组件，再加上本站的组件，最后把 pre 换成格式包里会显示引用状态的那个。
 */
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { File, Files, Folder } from 'fumadocs-ui/components/files'
import { Step, Steps } from 'fumadocs-ui/components/steps'
import { Callout } from 'fumadocs-ui/components/callout'
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import type { MDXComponents } from 'mdx/types'
import type { ReactNode } from 'react'
import { DocfirstPre } from '@godcreator/docfirst-workflow/fumadocs/pre'
import { Diagram } from './diagram'
import { DirSwap } from './explain/dir-swap'
import { ReloadPicker } from './explain/reload-picker'
import { RemountRace } from './explain/remount-race'
import type { ComponentName } from './registry'

type Loose = MDXComponents[string]

export function Note({ children }: { children?: ReactNode }) {
  return <div className="note">{children}</div>
}

const table: Record<ComponentName, Loose> = {
  Note: Note as Loose,
  Files: Files as Loose,
  Folder: Folder as Loose,
  File: File as Loose,
  Steps: Steps as Loose,
  Step: Step as Loose,
  Callout: Callout as Loose,
  Accordions: Accordions as Loose,
  Accordion: Accordion as Loose,
  Diagram: Diagram as Loose,
  DirSwap: DirSwap as Loose,
  ReloadPicker: ReloadPicker as Loose,
  RemountRace: RemountRace as Loose,
}

export function getMDXComponents(components: MDXComponents = {}): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
    ...table,
    pre: DocfirstPre as unknown as NonNullable<MDXComponents['pre']>,
  }
}
