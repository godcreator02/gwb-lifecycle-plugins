/**
 * 找插件与配包源：上面是两份 npmrc，source.add / remove 只写机器级那份，source.list 与 search 两份都读；
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
    <svg viewBox="0 0 400 490" className={NARROW} role="img" aria-label="包源命令读写哪份 npmrc，search 怎么检索">
      <Frame x={4} y={4} w={392} h={94} label="两份 npmrc（同名行 home 级优先）" size={12.5} />
      <Box x={14} y={32} w={178} h={54} lines={['机器级 ~/.npmrc', '本机所有 home 共用']} size={14} />
      <Box x={208} y={32} w={178} h={54} lines={['<home>/.npmrc', 'home 级，只读']} size={14} />

      <Box x={10} y={134} w={120} h={54} lines={['写包源', 'add / remove']} tone="b" size={14} />
      <Box x={140} y={134} w={120} h={54} lines={['列包源', 'source.list']} size={14} />
      <Box x={270} y={134} w={120} h={54} lines={['检索插件', 'search']} tone="a" size={14} />

      <Arrow from={[70, 134]} to={[70, 86]} tone="b" label="只写这份" labelSize={12} />
      <Arrow from={[200, 134]} to={[200, 98]} label="读两份" labelSize={12} />
      <Arrow from={[330, 134]} to={[330, 98]} label="读两份" labelSize={12} />
      <Note x={10} y={208} size={12} color={MUTED}>
        @godcreator 不许改、不许删
      </Note>

      <Arrow from={[330, 188]} to={[330, chainTop]} tone="a" />
      <Chain x={10} y={chainTop} w={380} h={50} gap={18} items={SEARCH} active={-1} />
      <Arrow from={[200, chainTop + 3 * 68 - 18]} to={[200, chainTop + 3 * 68]} dashed />
      <Box x={10} y={chainTop + 3 * 68} w={380} h={50} lines={['plugin-manager.install 装包', 'pnpm 读同一批配置行，装的就是这条源']} dashed size={14} />
    </svg>
  )
}
