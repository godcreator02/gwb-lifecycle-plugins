import type { Route } from './+types/comments'
import { useLoaderData } from 'react-router'
import { DocsPage } from '@fumadocs/base-ui/layouts/docs/page'
import { sitePageRefs } from '@godcreator/god-docsite/server'
import { CommentsTable } from '@godcreator/comments/site'
import { commentsTableRowsOf, handleCommentWrite, threadsByPageOf } from '@godcreator/comments/site/server'
import { site } from '@/lib/site.server'
import { commentAvatar, CommentBody } from '@/lib/content'

export async function loader() {
  return { rows: commentsTableRowsOf(threadsByPageOf({ entries: site.commentEntries, people: site.people() }), sitePageRefs(site)) }
}

/** 评论写入：各页的评论都提交到 /comments */
export async function action({ request }: Route.ActionArgs) {
  return handleCommentWrite({ request, commentsDir: site.commentsDir, people: site.people(), identity: site.identity(), trustedOrigin: site.trustedOrigin() })
}

/** 全站评论：一行一串的表格（只读；写评论去对应页面） */
export default function AllComments() {
  const { rows } = useLoaderData<typeof loader>()
  return (
    <DocsPage toc={[]} full>
      <title>全站评论</title>
      <h1 className="text-2xl font-semibold">全站评论</h1>
      {rows.length === 0 ? <p className="text-fd-muted-foreground">还没有评论。</p> : <CommentsTable rows={rows} BodyComponent={CommentBody} AvatarComponent={commentAvatar} />}
    </DocsPage>
  )
}
