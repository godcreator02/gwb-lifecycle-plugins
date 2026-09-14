import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  /**
   * **空着，这一行就是那条「不许外置」的账。**
   *
   * 塌包之后 `@team/docfirst-workflow` 里同时住着服务端那半（读盘、调 git、remark 插件）
   * 与客户端组件（`/fumadocs/pre` 状态点、`/fumadocs/term` 术语），而
   * `serverExternalPackages` 按包名匹配、没有子路径粒度——所以它整包不能外置：外置之后 Next 走
   * Node 单独加载、跟站打包的 React 分了家，预渲染报
   * `Cannot read properties of null (reading 'use')`，或构建期报 `ERR_PACKAGE_IMPORT_NOT_DEFINED`
   * 指着 `@base-ui/react` 里的文件，两种报错都完全不指根因。
   *
   * 不外置的代价只是多打一遍服务端那半：那半只在构建期跑，进不了客户端束。
   */
  serverExternalPackages: [],
  // 站根落到文档首页
  redirects: async () => [
    { source: '/', destination: '/docs', permanent: true },
  ],
}

export default withMDX(config)
