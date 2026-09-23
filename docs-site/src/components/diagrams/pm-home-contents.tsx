/**
 * home 里只有插件：左边是 home 的 node_modules 里的两个插件包，右边是插件代码运行时用到的东西各由谁提供。
 * cordis 由内核提供，react 的四个包名由声明了 gwb.shared 的插件经页面 importmap 提供，
 * 自己用的库打包进插件的构建产物，只取类型的包编译后就没了——所以没有什么需要另外装进 home。
 */

import { Arrow, Box, BORDER, FG, MUTED, Note } from './parts'

export function PmHomeContents() {
  return (
    <svg viewBox="0 0 760 300" role="img" aria-label="home 里只有插件，插件的依赖各由谁提供">
      <Note x={22} y={22} size={12} color={FG} weight={600}>
        home 的 node_modules：只有插件
      </Note>
      <rect x={14} y={30} width={366} height={222} rx={10} fill="none" stroke={BORDER} />
      <Box x={26} y={46} w={342} h={92} lines={['插件包 @x/gwb-foo（有条目）', 'dist/：自己的代码', '+ 打包进来的库（yaml、接口定义包……）']} tone="a" />
      <Box x={26} y={156} w={342} h={80} lines={['插件包 gwb-shell（有条目）', '清单 gwb.shared 里声明 react 的四个包名']} tone="a" />

      <Note x={478} y={22} size={12} color={FG} weight={600}>
        运行时由谁提供
      </Note>
      <Box x={470} y={40} w={276} h={56} lines={['内核（宿主）', "提供 cordis：import 'cordis' 用的是这一份"]} />
      <Box x={470} y={120} w={276} h={50} lines={['只取类型的包', 'cordis 的类型、词汇表包：编译后消失']} dashed />
      <Box x={470} y={196} w={276} h={56} lines={['页面的 importmap', 'react 的四个包名，只由插件声明']} />

      <Arrow from={[368, 70]} to={[470, 68]} label="按值 import cordis" />
      <Arrow from={[368, 118]} to={[470, 145]} dashed label="import type" labelAt="below" />
      <Arrow from={[368, 210]} to={[470, 224]} label="声明" />

      <Note x={380} y={284} anchor="middle" size={11.5} color={MUTED}>
        插件的依赖都有着落，不需要另外装进 home——所以插件管理不装 peer，也不判断装的是不是库
      </Note>
    </svg>
  )
}
