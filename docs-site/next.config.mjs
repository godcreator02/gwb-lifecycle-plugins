import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // core / project 只在服务端跑、还要读盘和调 git，标成外部包让 Node 自己解析。
  // **format-fumadocs 不外置**：它的 /pre 是客户端组件，跟着站一起打包才是同一个 React。
  // 外置它的现象是构建期报 ERR_PACKAGE_IMPORT_NOT_DEFINED（`#prehydration/...` 找不到），
  // 报错完全不指根因——那是 Node 单独加载它、连带把 fumadocs-ui 也拉出包外的结果。
  serverExternalPackages: ['@godcreator02/live-doc-project', '@godcreator02/live-doc-core'],
  // 站根落到文档首页
  redirects: async () => [
    { source: '/', destination: '/docs', permanent: true },
  ],
}

export default withMDX(config)
