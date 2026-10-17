import { createDiskPinner } from '@godcreator/code-pin/node'
import { remarkCodePin } from '@godcreator/code-pin/site'

// 钉上写的路径相对站点目录：react-router dev 与 build 都在站点目录里运行
const pinner = createDiskPinner(process.cwd())

/** 页面里的钉码标记换成带状态的钉码外框；目录树钉用到的 Files / Folder / File 组件平台已登记 */
export const remarkPlugins = [() => remarkCodePin({ pinner })]
