import type { Route } from './+types/llms-full'
import { llmsFullLoader } from '@godcreator/god-docsite/server'
import { site } from '@/lib/site.server'

export const loader = (args: Route.LoaderArgs) => llmsFullLoader(args, site)
