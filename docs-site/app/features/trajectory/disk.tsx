import type { Route } from './+types/disk'
import { useLoaderData } from 'react-router'
import { SiteLinksProvider } from '@godcreator/god-docsite/react'
import { sitePageTitles } from '@godcreator/god-docsite/server'
import { DiskPage } from '@godcreator/trajectory/site'
import { diskPageLoader } from '@godcreator/trajectory/site/server'
import { featureRuntime } from '@/features/runtime.generated'
import { mdxComponents } from '@/lib/mdx-components'
import { site } from '@/lib/site.server'
import browserCollections from '../../../.source/browser'
import { trajectorySite } from './site.server'

/** 星轨盘页不在整站布局里，布局给的站内地址到标题拿不到：这一页自己取一份，盘上展开的卡正文里的站内链接要用 */
export const loader = (args: Route.LoaderArgs) => ({ ...diskPageLoader(args, trajectorySite), pageTitles: sitePageTitles(site, featureRuntime.sidebarLinks) })

export default function TrajectoryDisk() {
  const { pageTitles } = useLoaderData<typeof loader>()
  return (
    <SiteLinksProvider pageTitles={pageTitles}>
      <DiskPage bodies={browserCollections.trajectory.raw} components={mdxComponents} />
    </SiteLinksProvider>
  )
}
