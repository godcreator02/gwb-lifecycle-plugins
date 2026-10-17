import { createSitePage, type TsxPageModule } from '@godcreator/god-docsite/react'
import { commentScopeProps, type CommentAvatar } from '@godcreator/comments/site'
import { Avatar } from '@godcreator/identity/site'
import browserCollections from '../../.source/browser'
import { mdxComponents } from './mdx-components'

/** 页面正文：评论在带 commentScopeProps 的正文容器里找被批的原文 */
export const SitePage = createSitePage({
  docs: browserCollections.docs,
  tsxPages: import.meta.glob<TsxPageModule>('/content/**/*.page.tsx'),
  components: mdxComponents,
  bodyProps: commentScopeProps,
})

const commentContent = browserCollections.comments.createClientLoader({
  id: 'comments',
  component: ({ default: Mdx }) => (
    <div data-comment-body="">
      <Mdx components={mdxComponents} />
    </div>
  ),
})

/**
 * 评论正文：评论集合的 client loader 按路径在浏览器加载。
 * dev 下刚写入的评论，服务端数据常比浏览器里的集合入口先到；入口经 HMR 换新后路由重新渲染、传进新的 CommentBody，在那之前先占位
 */
export function CommentBody({ path }: { path: string }) {
  if (!(`./${path}` in browserCollections.comments.raw)) return <p data-comment-pending="">正文还没加载到浏览器</p>
  return commentContent.useContent(path)
}

export const commentAvatar: CommentAvatar = ({ id, name, size }) => <Avatar person={{ id, name }} size={size} />
