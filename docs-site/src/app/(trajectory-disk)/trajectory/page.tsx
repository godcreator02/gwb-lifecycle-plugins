import { join } from 'node:path'
import Link from 'next/link'
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch'
import { DocsBody } from 'fumadocs-ui/layouts/docs/page'
import { loadTrajectory, StarDisk } from '@godcreator/docfirst-workflow/fumadocs/trajectory'
import { sourceTrajectory } from '@/lib/source'
import { getMDXComponents } from '@/components/mdx'

// 顶栏归页面画（回文档、报病数、主题切换），搜索、设置、帮助、图例、日期轨是组件自己固定在容器边上的浮层。
// 每张卡的正文在这里渲染好交给盘，点节点在盘右侧栏里看，不跳页；键是卡身份，跟卡页地址同一个。
export default async function Page() {
  const data = await loadTrajectory(join(process.cwd(), 'content', 'trajectory'))
  const bodies = Object.fromEntries(
    sourceTrajectory.getPages().map((page) => {
      const MDX = page.data.body
      return [
        page.slugs.join('/'),
        <DocsBody key={page.url}>
          <MDX components={getMDXComponents()} />
        </DocsBody>,
      ]
    }),
  )
  return (
    <div className="trajectory-page star-surface">
      <header className="trajectory-topbar">
        <Link href="/docs">← 文档</Link>
        <div className="trajectory-topbar-right">
          {data.sick.length > 0 ? (
            <span className="trajectory-sick" title={data.sick.map((f) => f.path).join('\n')}>
              报病 {data.sick.length}
            </span>
          ) : null}
          <ThemeSwitch mode="light-dark" />
        </div>
      </header>
      <div className="trajectory-stage">
        <StarDisk data={data} hrefBase="/trajectory" bodies={bodies} />
      </div>
    </div>
  )
}
