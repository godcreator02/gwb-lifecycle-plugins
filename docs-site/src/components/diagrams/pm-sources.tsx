/**
 * 找插件：上面是两份 npmrc，agent 照说明书往机器级那份手写第三方包源，search 两份都只读；
 * 下面是 search 往下的三步，最后一格虚线表示装包的 plugin-manager.install 经 pnpm 读的是同一批配置行。
 */

import { Arrow, Box, Chain, type ChainItem, Frame, MUTED, NARROW, Note } from './parts'

const SEARCH: ChainItem[] = [
  { lines: ['每个 scope 找一条源地址', '@scope:registry= → registry= → 官方源'], mono: true },
  { lines: ['各条源并发检索', 'GET <源>/-/v1/search?text=<scope>'], mono: true },
  { lines: ['keywords 含 gwb-plugin 才算插件', '合并进 packages，没查成的写进 note'] },
]

export function PmSources() {
  const chainTop = 222
  return (
    <svg viewBox="0 0 400 490" className={NARROW} role="img" aria-label="search 读哪两份 npmrc，怎么检索">
      <Frame x={4} y={4} w={392} h={94} label="两份 npmrc（同名行 home 级优先）" size={12.5} />
      <Box x={14} y={32} w={178} h={54} lines={['机器级 ~/.npmrc', '本机所有 home 共用']} size={14} />
      <Box x={208} y={32} w={178} h={54} lines={['<home>/.npmrc', 'home 级']} size={14} />

      <Box x={10} y={134} w={180} h={54} lines={['agent 照说明书', '手写第三方包源']} tone="b" size={14} />
      <Box x={210} y={134} w={180} h={54} lines={['检索插件', 'plugin-manager.search']} tone="a" size={14} />

      <Arrow from={[100, 134]} to={[100, 86]} tone="b" label="写这份" labelSize={12} />
      <Arrow from={[300, 134]} to={[300, 98]} label="只读两份" labelSize={12} />
      <Note x={10} y={208} size={12} color={MUTED}>
        @godcreator 那行不动
      </Note>

      <Arrow from={[300, 188]} to={[300, chainTop]} tone="a" />
      <Chain x={10} y={chainTop} w={380} h={50} gap={18} items={SEARCH} active={-1} />
      <Arrow from={[200, chainTop + 3 * 68 - 18]} to={[200, chainTop + 3 * 68]} dashed />
      <Box x={10} y={chainTop + 3 * 68} w={380} h={50} lines={['plugin-manager.install 装包', 'pnpm 读同一批配置行，装的就是这条源']} dashed size={14} />
    </svg>
  )
}
