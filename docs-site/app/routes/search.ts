import type { Route } from './+types/search'
import { searchLoader } from '@godcreator/god-docsite/server'
import { site } from '@/lib/site.server'

export const loader = (args: Route.LoaderArgs) => searchLoader(args, site)
