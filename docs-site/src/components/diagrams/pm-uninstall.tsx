/**
 * 卸载的顺序：先删这个包的全部条目，再 pnpm remove。第一步顺带卸载依赖它的插件；第二步失败不回滚。
 */

import { Arrow, Box, MUTED, Note } from './parts'

export function PmUninstall() {
  return (
    <svg viewBox="0 0 760 230" role="img" aria-label="卸载先删条目、后卸包">
      <Box x={14} y={30} w={220} h={60} lines={['1 删这个包的全部条目', 'tree.remove：写回 yml、当场卸载']} tone="a" />
      <Box x={270} y={30} w={220} h={60} lines={['2 pnpm remove', '经 applyToHome 串行']} tone="a" />
      <Box x={526} y={30} w={220} h={60} lines={['完成', '设置与数据留在磁盘上']} />
      <Arrow from={[234, 60]} to={[270, 60]} />
      <Arrow from={[490, 60]} to={[526, 60]} label="成功" />

      <Box x={14} y={130} w={220} h={56} lines={['依赖它的插件', '被 cordis 一起卸载，停在未加载']} dashed />
      <Arrow from={[124, 90]} to={[124, 130]} dashed />
      <Box x={270} y={130} w={220} h={56} lines={['pnpm 失败：不回滚', '包留在「已装、没有条目」那一组']} tone="b" />
      <Arrow from={[380, 90]} to={[380, 130]} label="失败" tone="b" />

      <Note x={526} y={148} size={11} color={MUTED}>
        反过来先卸包：条目会指向一个
      </Note>
      <Note x={526} y={166} size={11} color={MUTED}>
        不在 home 里的包
      </Note>
    </svg>
  )
}
