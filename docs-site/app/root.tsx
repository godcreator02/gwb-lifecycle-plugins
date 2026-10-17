import type { ReactNode } from 'react'
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'
import { RootProvider } from '@fumadocs/base-ui/provider/react-router'
import { widePageScript, zhTranslations } from '@godcreator/god-docsite/react'
import './app.css'

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: widePageScript }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={{ translations: zhTranslations }}>{children}</RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export { SiteErrorBoundary as ErrorBoundary } from '@godcreator/god-docsite/react'
