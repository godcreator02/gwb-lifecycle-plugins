import { sourceTrajectory } from '@/lib/source'
import { DocsBody, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'
import { getMDXComponents } from '@/components/mdx'
import { notFound } from 'next/navigation'

// 卡页：标题用 label（cardSchema 已经把它派生成 title），标题下一行元信息
// （born-at、type、domain、parent 链到父卡页）；导读页没有 born-at，元信息那行整个不出。
export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  const page = sourceTrajectory.getPage(slug)
  if (!page) notFound()

  const { title, type, domain, parent, ['born-at']: bornAt } = page.data
  const MDX = page.data.body
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{title}</DocsTitle>
      {bornAt ? (
        <div style={{ fontSize: 13, opacity: 0.7, margin: '-8px 0 12px' }}>
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
      ) : null}
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}

export function generateStaticParams() {
  return sourceTrajectory.generateParams()
}
