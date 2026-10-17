import type { Route } from './+types/markdown'
import { markdownLoader } from '@godcreator/god-docsite/server'
import { site } from '@/lib/site.server'

export const loader = (args: Route.LoaderArgs) => markdownLoader(args, site)
