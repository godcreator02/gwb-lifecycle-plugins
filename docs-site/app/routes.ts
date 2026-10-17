import { index, layout, route, type RouteConfig } from '@react-router/dev/routes'
import { featureRoutes, featureStandaloneRoutes } from './features/routes.generated.ts'

export default [
  route('api/search', 'routes/search.ts'),
  route('api/markdown', 'routes/markdown.ts'),
  route('api/content/*', 'routes/content-file.ts'),
  route('llms.txt', 'routes/llms.ts'),
  route('llms-full.txt', 'routes/llms-full.ts'),
  route('__docsite/feed/:channel', 'routes/feed.ts'),
  // 首页：fumadocs 的 HomeLayout，在整站布局之外、没有侧栏；内容由站点自己写在 home.tsx 里
  index('routes/home.tsx'),
  // 功能的独立页面（routes.ts 的 standaloneRoutes）：在整站布局之外，占满窗口、不带侧栏
  ...featureStandaloneRoutes,
  // 整站布局放在外层：跳页时侧栏不重新挂载。功能的页面路由（routes.ts 的默认导出，含评论功能的 /comments）嵌在布局里、展开在 * 前面。
  // 外部契约：布局路由 id 固定为 routes/layout，功能的 LayoutTop 用 useRouteLoaderData('routes/layout') 取自己那份布局数据
  layout('routes/layout.tsx', { id: 'routes/layout' }, [...featureRoutes, route('*', 'routes/page.tsx')]),
] satisfies RouteConfig
