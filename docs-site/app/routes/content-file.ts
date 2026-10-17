import type { Route } from './+types/content-file'
import { contentFileLoader } from '@godcreator/god-docsite/server'
import { site } from '@/lib/site.server'

export const loader = (args: Route.LoaderArgs) => contentFileLoader(args, site)
