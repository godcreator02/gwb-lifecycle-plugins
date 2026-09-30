import type { ReactNode } from 'react'
import './disk.css'

// 整个视口就是盘，不套 DocsLayout 的侧栏与目录；RootProvider 在根 layout 里
export default function Layout({ children }: { children: ReactNode }) {
  return children
}
