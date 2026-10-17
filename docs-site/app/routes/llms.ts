import type { Route } from './+types/llms'
import { llmsIndexLoader } from '@godcreator/god-docsite/server'
import { site } from '@/lib/site.server'

export const loader = (args: Route.LoaderArgs) => llmsIndexLoader(args, site)
