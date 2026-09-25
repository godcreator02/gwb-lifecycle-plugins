import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  /**
   * 必须为空：`@godcreator/docfirst-workflow` 一个包里既有服务端代码（读盘、调 git、remark 插件），
   * 又有客户端组件（`/fumadocs/pre` 的引用状态、`/fumadocs/term` 的术语），而 `serverExternalPackages`
   * 只能按整个包名设置，不能只外置子路径。外置之后 Next 用 Node 单独加载它，它拿到的 React 和站点打包的
   * 不是同一份，预渲染报 `Cannot read properties of null (reading 'use')`，或构建时报
   * `ERR_PACKAGE_IMPORT_NOT_DEFINED` 并指向 `@base-ui/react` 里的文件，两种报错都看不出原因。
   * 不外置的代价只是服务端代码多打包一次：它只在构建时运行，不会进客户端的包。
   */
  serverExternalPackages: [],
  redirects: async () => [
    { source: '/', destination: '/docs', permanent: true },
    // 现状区按接缝图重写（2026-09-24）：devkit 的几页移进 devkit 目录，怎么用与系统地图并进 devkit 首页与入口页。
    // 用临时跳转：永久跳转会被浏览器缓存，以后这些网址再用上就打不开
    { source: '/docs/start', destination: '/docs/devkit', permanent: false },
    { source: '/docs/system-map', destination: '/docs', permanent: false },
    { source: '/docs/scaffold', destination: '/docs/devkit/scaffold', permanent: false },
    { source: '/docs/structure', destination: '/docs/devkit/structure', permanent: false },
    { source: '/docs/home', destination: '/docs/devkit/home', permanent: false },
    { source: '/docs/dev', destination: '/docs/devkit/dev', permanent: false },
    { source: '/docs/cdp', destination: '/docs/devkit/cdp', permanent: false },
    // 生成正本挪进了现状区
    { source: '/outputs/:path*', destination: '/docs/outputs/:path*', permanent: false },
  ],
}

export default withMDX(config)
