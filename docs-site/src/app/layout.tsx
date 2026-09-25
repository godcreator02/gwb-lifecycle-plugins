/**
 * 三个区合成一棵侧栏树：每区一个 root: true 的根节点（侧栏里的分区），地址仍是三个前缀
 * （/docs、/trajectory、/future，路由各用各的 loader）。
 * base-ui 版的 Root 只有一个 fallback 位置，多棵树切换不稳，所以用根节点分区。
 * 区内的顺序由各区 content/<区>/meta.json 定。
 */
import { RootProvider } from 'fumadocs-ui/provider/next'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { source, sourceFuture, sourceTrajectory } from '@/lib/source'
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
  title: { default: 'gwb-lifecycle-plugins', template: '%s | gwb-lifecycle-plugins' },
}

export default function Layout({ children }: { children: ReactNode }) {
  const tree: Root = {
    name: 'gwb-lifecycle-plugins',
    children: [
      zone('现状', source.getPageTree()),
      zone('未来', sourceFuture.getPageTree()),
      zone('轨迹', sourceTrajectory.getPageTree()),
    ],
  }

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>
          <DocsLayout tree={tree} nav={{ title: 'gwb-lifecycle-plugins' }}>
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  )
}
