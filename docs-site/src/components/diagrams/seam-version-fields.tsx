/**
 * 接缝 3：插件包 package.json 的 peer（内核包的范围、用到的别的插件的范围）被两处读。左边 devkit.release 在发版时拿
 * devkit 所在 home 的内核比内核范围、拿源上 latest 比 peer 里的插件在不在同一条线，没过就拒发；右边 plugin-manager.list
 * 在它所在的 home 里拿内核与装着的版本比，只报告。最下面是两份内核范围比对规则靠什么保持一样。
 */

import { Arrow, Box, Frame, MUTED, NARROW, Note } from './parts'

export function SeamVersionFields() {
  return (
    <svg viewBox="0 0 400 520" className={NARROW} role="img" aria-label="peer 里的内核包范围与别的插件的范围被 devkit.release 与 plugin-manager.list 两处读">
      <Box x={60} y={8} w={280} h={54} lines={['插件包的 package.json', 'peer：内核包 · 用到的插件']} tone="a" size={14} />
      <Arrow from={[140, 62]} to={[100, 100]} />
      <Arrow from={[260, 62]} to={[300, 100]} />

      <Frame x={4} y={100} w={192} h={300} label="devkit.release" size={13} />
      <Note x={14} y={138} size={12} color={MUTED}>
        发版时，只查插件包
      </Note>
      <Box x={12} y={152} w={176} h={62} lines={['内核范围含不含', 'devkit 所在 home', '的 gwbKernel']} size={13.5} />
      <Box x={12} y={224} w={176} h={62} lines={['peer 里的插件', '和源上 latest', '在不在同一条线']} size={13.5} />
      <Box x={12} y={316} w={176} h={62} lines={['没过：一个都不发', '回执写改成什么']} tone="b" size={13.5} />
      <Arrow from={[100, 286]} to={[100, 316]} tone="b" />

      <Frame x={204} y={100} w={192} h={300} label="plugin-manager.list" size={13} />
      <Note x={214} y={138} size={12} color={MUTED}>
        每次列出时，每个包
      </Note>
      <Box x={212} y={152} w={176} h={62} lines={['内核范围含不含', '插件管理所在 home', '的 gwbKernel']} size={13.5} />
      <Box x={212} y={224} w={176} h={62} lines={['比装着的版本', 'node_modules/<包>', '/package.json']} size={13.5} />
      <Box x={212} y={316} w={176} h={62} lines={['只报告，照常加载', 'kernelUntested', 'unmetPeers']} size={13.5} />
      <Arrow from={[300, 286]} to={[300, 316]} />

      <Box x={10} y={424} w={380} h={62} lines={['内核范围的两份比对规则，不跨包 import', '两个 kernel-compat.ts', '对照测试拿同一组输入比两份的结果']} dashed size={13.5} />
      <Note x={10} y={508} size={12} color={MUTED}>
        内核不读 peer；两处比的可以是不同的 home
      </Note>
    </svg>
  )
}
