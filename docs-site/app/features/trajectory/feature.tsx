import { Orbit } from 'lucide-react'
import { routeLinkKind } from '@godcreator/god-docsite/react'
import { cardBodyLoadersById } from '@godcreator/trajectory/site'
import browserCollections from '../../../.source/browser'
import { trajectoryHrefBase } from './href'

/** 侧栏横排里的「轨迹」入口：进星轨盘，卡页（地址在它下面）上也高亮 */
export const sidebarLinks = [{ name: '轨迹', url: trajectoryHrefBase, icon: <Orbit />, order: 50 }]

const cardIds = new Set(cardBodyLoadersById(browserCollections.trajectory.raw).keys())

/** 正文里的卡链接（卡集合的 remark 插件把「<卡身份>.md」改写成卡页地址）：卡集合里有这张卡就显示成卡片、名字是卡身份，没有就标红 */
export const linkKinds = [routeLinkKind({ prefix: trajectoryHrefBase, titleOf: (cardId) => (cardIds.has(cardId) ? cardId : undefined) })]
