import type { Route } from './+types/page'
import { useLoaderData } from 'react-router'
import { sitePageData } from '@godcreator/god-docsite/server'
import { pageThreadsOf } from '@godcreator/comments/site/server'
import { CommentsDock, commentsAccessOf } from '@godcreator/comments/site'
import { site } from '@/lib/site.server'
import { commentAvatar, CommentBody, SitePage } from '@/lib/content'

export async function loader(args: Route.LoaderArgs) {
  const page = sitePageData(args, site)
  return {
    page,
    threads: pageThreadsOf({ entries: site.commentEntries, people: site.people(), page: page.key }),
    access: commentsAccessOf(site.identity()),
  }
}

export default function Page() {
  const { page, threads, access } = useLoaderData<typeof loader>()
  return (
    <>
      <SitePage page={page} />
      <CommentsDock pagePath={page.key} action="/comments" threads={threads} access={access} BodyComponent={CommentBody} AvatarComponent={commentAvatar} />
    </>
  )
}
