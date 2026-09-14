/**
 * 站侧的全部接线都在这一个文件：六区六个集合，外加全局的 mdxOptions（格式包给——remark 链
 * 尾巴挂插件，meta 白名单放行 title / lineNumbers / data-dot）。
 *
 * 六区各一个 defineDocs（自带 docs + meta 双集合，meta.json 的侧栏排序天然支持）：
 *   docs        现状：只有现状、散文、尽量多钉；进 check
 *   trajectory  轨迹：卡只增不改；卡的 frontmatter 由 cardSchema 认（label 派生 title），
 *               正文里 `supersedes::` / `pivots-from::` 关系边由 remarkTrajectoryLinks 打标；不进 check
 *   spec        交接：在途 spec 与实施方案，做完删页
 *   future      未来：愿景 + not-doing + roadmap，常改
 *   outputs     生成正本：agents / readme 等，render 摆到仓根；进 check
 *   feedback    反馈：只有 hatch（本仓反复做的操作候选）——跨仓反馈集中投总控台，不落各仓的站
 * 只有 docs 与 outputs 开 processed markdown——命令行按名字找集合只对进 check 的两区有意义
 * （集合名 = 目录最后一截，docfirst 靠这条约定给 `?collection=`）。
 * 集合定义在这里而不是 src/lib/source.ts 里，是为了让命令行也能按名字找到它：
 * fumadocs 的 Node loader 只认 source.config 里的集合。
 */
import { applyMdxPreset, defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { docfirstMdxOptions, docfirstMarkdownOptions } from '@team/docfirst-workflow/fumadocs'
import { cardSchema, remarkTrajectoryLinks } from '@team/docfirst-trajectory/server'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: { includeProcessedMarkdown: docfirstMarkdownOptions() },
  },
})

// 集合级 mdxOptions 会把默认插件全去掉（fumadocs-mdx 的文档原话），所以用 applyMdxPreset 把默认
// preset（标题 id、gfm……）加回来，再挂 remarkTrajectoryLinks；全局那份 docfirst 插件不会跑到这个集合上
export const trajectory = defineDocs({
  dir: 'content/trajectory',
  docs: {
    schema: cardSchema,
    mdxOptions: applyMdxPreset({
      remarkPlugins: (v) => [...v, [remarkTrajectoryLinks, { hrefBase: '/trajectory' }]],
    }),
  },
})

export const spec = defineDocs({
  dir: 'content/spec',
})

export const future = defineDocs({
  dir: 'content/future',
})

export const outputs = defineDocs({
  dir: 'content/outputs',
  docs: {
    postprocess: { includeProcessedMarkdown: docfirstMarkdownOptions() },
  },
})

export const feedback = defineDocs({
  dir: 'content/feedback',
})

export default defineConfig({
  // 类型要求完整 options（含 themes），运行时会 merge 默认值——cast 只在这一处
  mdxOptions: docfirstMdxOptions({ root: process.cwd() }) as never,
})
