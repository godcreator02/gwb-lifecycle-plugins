import { sourceTrajectory } from '@/lib/source'
import { DocsBody, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'
import { getMDXComponents } from '@/components/mdx'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

// 卡页：标题用 label（cardSchema 已经把它派生成 title），标题下一行元信息（born-at、type、domain、parent 链到父卡页）。
// slug 必选：空 slug 是另一个路由组里的整页星轨盘，轨迹区没有导读页，meta.json 第一条链到盘
export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params
  const page = sourceTrajectory.getPage(slug)
  if (!page) notFound()

  const { title, type, domain, parent, ['born-at']: bornAt } = page.data
  const MDX = page.data.body
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{title}</DocsTitle>
      <div style={{ fontSize: 13, opacity: 0.7, margin: '-8px 0 4px' }}>
        {bornAt}
        {type ? ` · ${type}` : ''}
        {domain ? ` · ${domain}` : ''}
        {parent && parent.length > 0 ? (
          <>
            {' · 父卡：'}
            {parent.map((id: string, i: number) => (
              <span key={id}>
                {i > 0 ? '、' : ''}
                <a href={`/trajectory/${encodeURIComponent(id)}`}>{id}</a>
              </span>
            ))}
          </>
        ) : null}
      </div>
      <div style={{ fontSize: 13, margin: '0 0 16px' }}>
        <a href="/trajectory">← 回到盘</a>
      </div>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params
  const page = sourceTrajectory.getPage(slug)
  if (!page) notFound()
  return { title: page.data.title, description: page.data.description }
}

export function generateStaticParams() {
  return sourceTrajectory.generateParams().filter((p) => p.slug.length > 0)
}
