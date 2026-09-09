import { loader } from 'fumadocs-core/source'
// .source/ 是 fumadocs-mdx 按 source.config.ts 生成的（gitignore），集合从这里拿
import { docs } from '../../.source/server'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
})
