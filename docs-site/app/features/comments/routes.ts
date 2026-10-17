import { relative, type RouteConfig } from '@react-router/dev/routes'

const { route } = relative(import.meta.dirname)

/** 全站评论页，也是各页评论面板提交评论的地址（/comments 的 action）；在整站布局里 */
export default [route('comments', './comments.tsx')] satisfies RouteConfig
