/**
 * 插件守卫：插件的 apply 在 mountHarness 的替身 ctx 上运行，替身把登记的窗格与命令记下来；四条用例只查结构，
 * 第 1 条查调用方给的名字，第 2 条查 apply 本身，第 3、4 条查记下来的命令与窗格。
 */

import { Arrow, Box, FG, Frame, MONO, MUTED, NARROW, Note } from './parts'

const CASES: string[][] = [
  ['1 名字对得上', 'name = pkgName = gwb-<短名>，pkg 以它结尾'],
  ['2 apply 在替身上运行不抛错', '用了替身没有的成员就会抛错'],
  ['3 每条命令', 'plugin 是包名，name、description、usage 不空'],
  ['4 每个窗格', 'id 不空，client / style 是 .js / .css 的 file: 地址'],
]

const MEMBERS = ['logger、effect、inject', 'gwbShell.registerPane', 'gwbCommands.register']

export function RkPluginGuard() {
  const casesTop = 220
  return (
    <svg viewBox="0 0 400 486" className={NARROW} role="img" aria-label="插件守卫在替身上运行 apply，查四条结构">
      <Box x={10} y={34} w={120} h={60} lines={['插件的 apply', '从 src/ 加载']} size={14} />
      <Arrow from={[130, 64]} to={[160, 64]} tone="a" />
      <Frame x={160} y={4} w={230} h={120} label="mountHarness 的替身 ctx" lit size={13} />
      {MEMBERS.map((line, index) => (
        <text key={line} x={174} y={52 + index * 22} fontSize={12.5} fill={FG} fontFamily={MONO}>
          {line}
        </text>
      ))}

      <Arrow from={[230, 124]} to={[105, 150]} />
      <Arrow from={[320, 124]} to={[295, 150]} />
      <Box x={10} y={150} w={185} h={46} lines={['记下的窗格', 'panes']} size={14} mono />
      <Box x={205} y={150} w={185} h={46} lines={['记下的命令', 'commands']} size={14} mono />

      {CASES.map((lines, index) => (
        <Box key={lines[0]} x={10} y={casesTop + index * 56} w={380} h={46} lines={lines} size={14} />
      ))}
      <Note x={10} y={casesTop + 4 * 56 + 10} size={12} color={MUTED}>
        不查窗格与命令的个数、命令名前缀、client 文件在不在 dist
      </Note>
    </svg>
  )
}
