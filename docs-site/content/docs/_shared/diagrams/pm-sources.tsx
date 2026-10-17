/**
 * 找插件：上面是 search 读的两样——市场名单（设置项，人在窗格或 agent 用 settings.set 改）与 pnpm 合并好的配置；
 * 下面是 search 往下的三步，最后一格虚线表示装包的 plugin-manager.install 经 pnpm 读的是同一份配置。
 */

import { Arrow, Box, Chain, type ChainItem, Frame, MUTED, NARROW, Note } from './parts'

const SEARCH: ChainItem[] = [
  { lines: ['名单里每个 scope 找源地址', '只认 @scope:registry，没配就报'], mono: true },
  { lines: ['各市场并发检索', 'GET <源>/-/v1/search?text=<scope>'], mono: true },
  { lines: ['keywords 含 gwb-plugin 才算插件', '合并进 packages，各市场状态进 markets'] },
]

export function PmSources() {
  const chainTop = 222
  return (
    <svg viewBox="0 0 400 490" className={NARROW} role="img" aria-label="search 在哪些市场上找，每个市场去哪个源查">
      <Frame x={4} y={4} w={392} h={94} label="search 读的两样" size={12.5} />
      <Box x={14} y={32} w={178} h={54} lines={['市场名单', '设置项 plugin-markets']} size={14} />
      <Box x={208} y={32} w={178} h={54} lines={['pnpm 的配置', 'config list --json']} size={14} />

      <Box x={10} y={134} w={180} h={54} lines={['窗格「可安装」', '或 settings.set']} tone="b" size={14} />
      <Box x={210} y={134} w={180} h={54} lines={['检索插件', 'plugin-manager.search']} tone="a" size={14} />

      <Arrow from={[100, 134]} to={[100, 86]} tone="b" label="加删市场" labelSize={12} />
      <Arrow from={[300, 134]} to={[300, 98]} label="只读" labelSize={12} />
      <Note x={10} y={208} size={12} color={MUTED}>
        默认只有 @godcreator
      </Note>

      <Arrow from={[300, 188]} to={[300, chainTop]} tone="a" />
      <Chain x={10} y={chainTop} w={380} h={50} gap={18} items={SEARCH} active={-1} />
      <Arrow from={[200, chainTop + 3 * 68 - 18]} to={[200, chainTop + 3 * 68]} dashed />
      <Box x={10} y={chainTop + 3 * 68} w={380} h={50} lines={['plugin-manager.install 装包', 'pnpm 读同一份配置，装的就是这个源']} dashed size={14} />
    </svg>
  )
}
