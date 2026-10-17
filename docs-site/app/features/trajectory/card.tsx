import type { Route } from './+types/card'
import { CardPage } from '@godcreator/trajectory/site'
import { cardPageLoader } from '@godcreator/trajectory/site/server'
import { mdxComponents } from '@/lib/mdx-components'
import browserCollections from '../../../.source/browser'
import { trajectorySite } from './site.server'

export const loader = (args: Route.LoaderArgs) => cardPageLoader(args, trajectorySite)

export default function TrajectoryCard() {
  return <CardPage bodies={browserCollections.trajectory.raw} components={mdxComponents} />
}
