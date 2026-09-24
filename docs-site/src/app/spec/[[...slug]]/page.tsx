import { sourceSpec } from '@/lib/source'
import { DocsBody, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'
import { getMDXComponents } from '@/components/mdx'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  const page = sourceSpec.getPage(slug)
  if (!page) notFound()

  const MDX = page.data.body
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}

export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }): Promise<Metadata> {
  const { slug } = await params
  const page = sourceSpec.getPage(slug)
  if (!page) notFound()
  return { title: page.data.title, description: page.data.description }
}

export function generateStaticParams() {
  return sourceSpec.generateParams()
}
