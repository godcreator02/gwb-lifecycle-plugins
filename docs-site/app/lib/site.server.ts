import path from 'node:path'
import { siteFeedValue, siteOrigin, type BaseSiteContext } from '@godcreator/god-docsite/server'
import { siteIdentity, sitePeople } from '@godcreator/identity/node'
import { comments } from '../../.source/server'
import { source } from './source'

// react-router dev 与 react-router-serve 都在站点目录里启动
const dir = process.cwd()
const mode: 'dev' | 'start' = import.meta.env.DEV ? 'dev' : 'start'

/**
 * 基础站点上下文：平台与功能的 loader、action 经参数拿到它，它们自己不 import 站点代码。
 * 功能目录里的 site.server.ts 从它组装本功能要的上下文；字段说明见平台包的 BaseSiteContext
 */
export const site = {
  dir,
  mode,
  source,
  contentDir: path.join(dir, 'content'),
  commentsDir: path.join(dir, 'comments'),
  commentEntries: comments,
  /** 带身份码，只在服务端用；给浏览器的经 publicPeopleOf */
  people: () => sitePeople(dir),
  /** start（build 之后的发布版）一律只读 */
  identity: () => siteIdentity(dir, mode),
  trustedOrigin: () => siteOrigin(mode),
  feedValue: (channel: string) => siteFeedValue(channel),
} satisfies BaseSiteContext
