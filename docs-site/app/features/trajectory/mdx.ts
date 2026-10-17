import { defineCollections } from 'fumadocs-mdx/config'
import { cardMdxOptions, cardSchema, type MdxPluginList } from '@godcreator/trajectory/site/collection'
import { trajectoryHrefBase } from './href.ts'

/** 站点的全站插件：建站器生成的集合汇总文件调用工厂时传入 */
interface SitePlugins {
  remarkPlugins: MdxPluginList
  rehypePlugins: MdxPluginList
}

/** 集合名单与 package.json 的 godDocsite.collections 一致；工厂把全站插件并进卡集合的 mdx 选项（集合写了 mdxOptions，全局插件对它不生效） */
export const collections = {
  /** 轨迹卡：站点根下 trajectory/ 里的 .md 与 .mdx，目录要和 docfirst.config.mjs 的 trajectory 一致；正文按需加载 */
  trajectory: (sitePlugins: SitePlugins) =>
    defineCollections({
      type: 'doc',
      dir: 'trajectory',
      files: ['*.{md,mdx}'],
      async: true,
      schema: cardSchema,
      mdxOptions: cardMdxOptions({ hrefBase: trajectoryHrefBase, ...sitePlugins }),
    }),
}
