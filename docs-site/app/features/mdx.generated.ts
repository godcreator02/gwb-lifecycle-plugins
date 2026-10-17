// 建站器生成，勿手改：addFeature / regenerateFeatureIndex 每次都重写。功能清单是 app/features/ 下含 routes.ts、feature.tsx、mdx.ts 或 styles.css 的子目录
import type { DefaultMDXOptions } from 'fumadocs-mdx/config'
import * as codePinMdx from './code-pin/mdx.ts'
import * as trajectoryMdx from './trajectory/mdx.ts'

export type MdxPluginList = Extract<NonNullable<DefaultMDXOptions['remarkPlugins']>, unknown[]>

/** 集合工厂收到的全站插件：工厂把它们并进自己集合的 applyMdxPreset（集合写了 mdxOptions，全局的就不生效） */
export interface SiteMdxPlugins {
  remarkPlugins: MdxPluginList
  rehypePlugins: MdxPluginList
}

/** 各功能 mdx.ts 可以导出的几样 */
interface FeatureMdxModule {
  remarkPlugins?: MdxPluginList
  rehypePlugins?: MdxPluginList
  collections?: Readonly<Record<string, (sitePlugins: SiteMdxPlugins) => unknown>>
}

const featureMdxModules: FeatureMdxModule[] = [codePinMdx, trajectoryMdx]

export const featureRemarkPlugins: MdxPluginList = featureMdxModules.flatMap((mdx) => mdx.remarkPlugins ?? [])
export const featureRehypePlugins: MdxPluginList = featureMdxModules.flatMap((mdx) => mdx.rehypePlugins ?? [])
