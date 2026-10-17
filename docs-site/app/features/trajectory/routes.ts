import { relative, type RouteConfig } from '@react-router/dev/routes'
import { trajectoryHrefBase } from './href.ts'

const { route } = relative(import.meta.dirname)
const path = trajectoryHrefBase.slice(1)

/** 卡页在整站布局里 */
export default [route(`${path}/*`, './card.tsx')] satisfies RouteConfig

/** 星轨盘页占满窗口、不带侧栏，在整站布局之外 */
export const standaloneRoutes = [route(path, './disk.tsx')] satisfies RouteConfig
