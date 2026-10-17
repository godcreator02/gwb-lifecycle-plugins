// 建站器生成，勿手改：addFeature / regenerateFeatureIndex 每次都重写。功能清单是 app/features/ 下含 routes.ts、feature.tsx、mdx.ts 或 styles.css 的子目录
// source.config.ts 用 export * 再导出这里：fumadocs-mdx 要求那份文件只导出集合，所以这里只有集合是导出的
import { sitePlugins } from '../lib/mdx-plugins.ts'
import * as trajectoryMdx from './trajectory/mdx.ts'

export const trajectory = trajectoryMdx.collections.trajectory(sitePlugins)
