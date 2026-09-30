/**
 * 根 layout 只放 RootProvider：侧栏在 src/app/docs/layout.tsx，现状、未来与轨迹卡页共用；
 * 整页星轨盘（src/app/(trajectory-disk)/trajectory/）不带侧栏。
 */
import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './global.css'

/** 浏览器标签页上的标题：各页是「页面标题 | 站名」，没有页面标题时只有站名 */
export const metadata: Metadata = {
  title: { default: 'gwb-lifecycle-plugins', template: '%s | gwb-lifecycle-plugins' },
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
