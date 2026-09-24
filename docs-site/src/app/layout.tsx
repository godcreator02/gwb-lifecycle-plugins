/**
 * 六区合一棵侧栏树：每区一个 root: true 的根节（侧栏分区），URL 仍是六个基座
 * （/docs、/trajectory、/spec、/future、/outputs、/feedback，路由各走各的 loader）。
 * base-ui 版的 Root 只有单槽 fallback，多树切换不稳，根节分区是正路。
 * 区内的顺序由各区 content/<区>/meta.json 定。
 */
import { RootProvider } from 'fumadocs-ui/provider/next'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { source, sourceFeedback, sourceFuture, sourceOutputs, sourceSpec, sourceTrajectory } from '@/lib/source'
import type { Node, Root } from 'fumadocs-core/page-tree'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './global.css'

function zone(name: string, root: Root): Node {
  return {
    type: 'folder',
    name,
    root: true,
    defaultOpen: true,
    children: root.children,
  }
}

/** 浏览器标签页上的标题：各页是「页面标题 | 站名」，没有页面标题时只有站名 */
export const metadata: Metadata = {
  title: { default: '开发套件', template: '%s | 开发套件' },
}

export default function Layout({ children }: { children: ReactNode }) {
  const tree: Root = {
    name: '开发套件',
    children: [
      zone('现状', source.getPageTree()),
      zone('轨迹', sourceTrajectory.getPageTree()),
      zone('交接', sourceSpec.getPageTree()),
      zone('未来', sourceFuture.getPageTree()),
      zone('生成正本', sourceOutputs.getPageTree()),
      zone('反馈', sourceFeedback.getPageTree()),
    ],
  }

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>
          <DocsLayout tree={tree} nav={{ title: '开发套件' }}>
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  )
}
