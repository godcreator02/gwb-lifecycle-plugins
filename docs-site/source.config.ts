/**
 * 站侧的全部接线都在这一个文件：
 *   mdxOptions   格式包给——remark 链尾巴挂插件，meta 白名单放行 title / lineNumbers / data-dot
 *   docs 集合    postprocess 打开 processed markdown，序列化回调也是格式包给的
 * 集合定义在这里而不是 src/lib/source.ts 里，是为了让命令行也能按名字找到它：
 * fumadocs 的 Node loader 只认 source.config 里的集合。
 */
import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { livedocMdxOptions, livedocMarkdownOptions } from '@godcreator02/live-doc-format-fumadocs'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: { includeProcessedMarkdown: livedocMarkdownOptions() },
  },
})

export default defineConfig({
  // 类型要求完整 options（含 themes），运行时会 merge 默认值——cast 只在这一处
  mdxOptions: livedocMdxOptions({ root: process.cwd() }) as never,
})
