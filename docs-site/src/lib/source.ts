/**
 * 三个区各一个 loader：地址前缀 /docs、/trajectory、/future。路由各用各的 loader（src/app/<区>/[[...slug]]/page.tsx），
 * 侧栏在 src/app/layout.tsx 合成一棵树。.source/ 是 fumadocs-mdx 按 source.config.ts 生成的（gitignore），集合从这里取。
 */
import { loader } from 'fumadocs-core/source'
import { docs, future, trajectory } from '../../.source/server'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
})

export const sourceTrajectory = loader({
  baseUrl: '/trajectory',
  source: trajectory.toFumadocsSource(),
})

export const sourceFuture = loader({
  baseUrl: '/future',
  source: future.toFumadocsSource(),
})
