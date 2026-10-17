import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import { applyMdxPreset, defineCollections, defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { featureRehypePlugins, featureRemarkPlugins } from './app/features/mdx.generated.ts'
import { sitePlugins } from './app/lib/mdx-plugins.ts'

// 各功能的集合（功能包 mdx.ts 的集合工厂按 package.json 的 godDocsite.collections 生成）；fumadocs-mdx 要求这份文件只导出集合
export * from './app/features/collections.generated.ts'

// 全局的 mdxOptions 管没写自己 mdxOptions 的集合（评论）与集合外被 import 的 mdx；
// 集合写了自己的 mdxOptions，全局的对它就不生效，全站插件要在集合里再列一次
export default defineConfig({
  mdxOptions: { remarkPlugins: [remarkMath, ...featureRemarkPlugins], rehypePlugins: [rehypeKatex, ...featureRehypePlugins] },
})

export const docs = defineDocs({
  dir: 'content',
  docs: {
    async: true,
    // 下划线开头的 .mdx 是被页面 import 的正文，不是独立页面
    files: ['**/[^_]*.mdx'],
    postprocess: { includeProcessedMarkdown: true },
    mdxOptions: applyMdxPreset({
      remarkPlugins: sitePlugins.remarkPlugins,
      rehypePlugins: (list) => [...sitePlugins.rehypePlugins, ...list],
    }),
  },
  // fumadocs-mdx 默认把所有 .json 当目录说明：页面同名文件夹里的 .json 附件会让那个文件夹变成一组，同名的那一页从侧栏消失
  meta: { files: ['**/meta.json'] },
})

// 评论：一串一个文件夹（index.mdx 是串头，回复各一个 mdx），frontmatter 由评论包校验
export const comments = defineCollections({
  type: 'doc',
  dir: 'comments',
  async: true,
})
