import defaultMdxComponents from '@fumadocs/base-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { siteLinkComponent, siteMdxComponents } from '@godcreator/god-docsite/react'
import { featureRuntime } from '../features/runtime.generated.ts'

/** MDX 页面与评论正文不用 import 就能写的组件：fumadocs 默认的、平台的、各功能 feature.tsx 导出的；链接 a 换成站内链接，各功能导出的链接种类先认 */
export const mdxComponents = {
  ...defaultMdxComponents,
  ...siteMdxComponents,
  ...featureRuntime.mdxComponents,
  a: siteLinkComponent(featureRuntime.linkKinds),
} satisfies MDXComponents

declare global {
  type MDXProvidedComponents = typeof mdxComponents
}
