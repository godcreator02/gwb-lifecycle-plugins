import type { TrajectorySite } from '@godcreator/trajectory/site/server'
import { site } from '@/lib/site.server'
import { trajectory } from '../../../.source/server'
import { trajectoryHrefBase } from './href'

/** 卡页、星轨盘页的站点上下文：卡集合是 mdx.ts 声明、经 source.config.ts 导出的 trajectory；站名每次从页面树根取（content/meta.json 的 title） */
export const trajectorySite: TrajectorySite = {
  cards: { entries: trajectory },
  get siteName() {
    const name = site.source.getPageTree().name
    return typeof name === 'string' ? name : ''
  },
  hrefBase: trajectoryHrefBase,
  docsHref: '/',
}
