/**
 * 站的三个集合与全局 mdxOptions（@godcreator/docfirst-workflow/fumadocs 给：remark 链末尾挂 docfirst 的插件，meta 白名单放行 title / lineNumbers / data-dot）。
 *   docs        现状：进 check；生成正本（AGENTS、README、SKILL.md 的 mdx）在它的 outputs/ 下
 *   trajectory  轨迹：卡只增不改；卡的 frontmatter 由 cardSchema 认（label 派生 title），
 *               正文里 `supersedes::` / `pivots-from::` 关系由 remarkTrajectoryLinks 标出；不进 check
 *   future      未来：路线图、在途的 spec（future/spec/）；别的仓投来的反馈是 gitea 上的 issue
 * 只有现状区开 processed markdown：站上各页的机读版从这儿出。
 */
import { applyMdxPreset, defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { cardSchema, docfirstMarkdownOptions, docfirstMdxOptions, remarkTrajectoryLinks } from '@godcreator/docfirst-workflow/fumadocs'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: { includeProcessedMarkdown: docfirstMarkdownOptions() },
  },
})

// 集合级 mdxOptions 会去掉 fumadocs 的全部默认插件，所以用 applyMdxPreset 把默认插件加回来，再挂 remarkTrajectoryLinks；
// 全局那份 docfirst 插件不会用在这个集合上
export const trajectory = defineDocs({
  dir: 'content/trajectory',
  docs: {
    schema: cardSchema,
    mdxOptions: applyMdxPreset({
      remarkPlugins: (v) => [...v, [remarkTrajectoryLinks, { hrefBase: '/trajectory' }]],
    }),
  },
})

export const future = defineDocs({
  dir: 'content/future',
})

export default defineConfig({
  // 类型要求完整 options（含 themes），运行时会合并默认值，所以只在这一处转换类型
  mdxOptions: docfirstMdxOptions({ root: process.cwd() }) as never,
})
