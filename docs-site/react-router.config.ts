import type { Config } from '@react-router/dev/config'

export default {
  ssr: true,
  // 只预渲染与访问者无关的 llms 文本：页面的布局与页面 loader 带着本机身份与评论，预渲染出的是构建时的数据；
  // 功能包的页面要读写数据，推送路由是不结束的长连接，都不预渲染
  prerender: ['/llms.txt', '/llms-full.txt'],
} satisfies Config
