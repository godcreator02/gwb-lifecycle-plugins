// 建站器生成，勿手改：addFeature / regenerateFeatureIndex 每次都重写。功能清单是 app/features/ 下含 routes.ts、feature.tsx、mdx.ts 或 styles.css 的子目录
import { siteFeatureRuntime } from '@godcreator/god-docsite/react'
import * as commentsFeature from './comments/feature.tsx'
import * as trajectoryFeature from './trajectory/feature.tsx'

export const featureRuntime = siteFeatureRuntime({ 'comments': commentsFeature, 'trajectory': trajectoryFeature })
