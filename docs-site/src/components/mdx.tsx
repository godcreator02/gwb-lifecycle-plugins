/**
 * 名册的人看那一半：格式包给机制，项目在 docfirst.config.mjs 里声明压平表，这里给 React 表。
 * 表的类型由 registry.ts 的名单钉死：少一个编译不过，多一个也编译不过。
 * 跟压平表齐不齐，由 scripts/verify-roster.mjs 两头对。
 * 底下铺 fumadocs 的默认表，再把 pre 换成格式包那个会画状态点的。
 */
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { File, Files, Folder } from 'fumadocs-ui/components/files'
import type { MDXComponents } from 'mdx/types'
import type { ReactNode } from 'react'
import { DocfirstPre } from '@godcreator02/docfirst-workflow/fumadocs/pre'
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
}

export function getMDXComponents(components: MDXComponents = {}): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
    ...table,
    pre: DocfirstPre as unknown as NonNullable<MDXComponents['pre']>,
  }
}
