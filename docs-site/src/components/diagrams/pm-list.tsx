/**
 * list 怎么把包与条目两层对上：左边是 home 的 package.json，中间是 cordis.yml 的条目，右边是 list 的结果。
 * 两边都不丢：没有条目的包报成 entries: []，指向没装的包的条目报成 installed: false。
 */

import { Arrow, Box, MUTED, Note } from './parts'

export function PmList() {
  return (
    <svg viewBox="0 0 760 230" role="img" aria-label="list 怎么把包与条目对上">
      <Box x={14} y={30} w={200} h={120} lines={['package.json 的依赖', '@x/gwb-a', '@x/gwb-b', '（没有 @x/gwb-c）']} />
      <Box x={250} y={30} w={200} h={120} lines={['cordis.yml 的条目', 'a → @x/gwb-a', 'a-2 → @x/gwb-a', 'c → @x/gwb-c']} />
      <Box x={490} y={20} w={256} h={140} lines={['list 的结果（按包名排）', '@x/gwb-a：条目 a、a-2', '@x/gwb-b：entries: []', '@x/gwb-c：installed: false', '每条带 active、disabled、显示名']} tone="a" />
      <Arrow from={[214, 90]} to={[250, 90]} />
      <Arrow from={[450, 90]} to={[490, 90]} />
      <Note x={380} y={190} anchor="middle" size={11.5} color={MUTED}>
        两边都不丢：没有条目的包、指向没装的包的条目都如实报出来，不推断原因
      </Note>
      <Note x={380} y={210} anchor="middle" size={11.5} color={MUTED}>
        active 看 fiber 的状态是不是 ACTIVE——依赖没满足的插件也有 fiber，只是永远到不了 ACTIVE
      </Note>
    </svg>
  )
}
