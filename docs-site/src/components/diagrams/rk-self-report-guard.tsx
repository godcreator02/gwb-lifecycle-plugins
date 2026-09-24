/**
 * 自述守卫读的四样东西（包清单、源码、skills/ 目录、文档站现状区）与它登记的五条用例，每条用例写明拿什么对照什么。
 * 中间一格是前提：keywords 里没有 gwb-plugin 的包一条用例都不登记。
 */

import { Arrow, Box, MUTED, NARROW, Note } from './parts'

const CASES: string[][] = [
  ['1 description 写齐三项', '「服务」「skill」「命令 N 条」或「命令无」'],
  ['2 提供的服务名都写进 description', '源码里提供的每个服务名'],
  ['3 gwb.provides 与源码提供的一一对应', 'summary、usage 都不空'],
  ['4 说明书份数对得上', '「skill N 份」= 带 SKILL.md 的目录数'],
  ['5 注入的服务名都在文档里', '现状区一个 .mdx 都没有时直接通过'],
]

export function RkSelfReportGuard() {
  const casesTop = 214
  return (
    <svg viewBox="0 0 400 506" className={NARROW} role="img" aria-label="自述守卫读哪几样东西、登记哪五条用例">
      <Box x={10} y={10} w={185} h={52} lines={['package.json', 'description、gwb.provides']} size={14} />
      <Box x={205} y={10} w={185} h={52} lines={['src/ 下的 .ts、.tsx', '按文本扫服务名']} size={14} />
      <Box x={10} y={72} w={185} h={52} lines={['skills/', '带 SKILL.md 的目录']} size={14} />
      <Box x={205} y={72} w={185} h={52} lines={['文档站现状区', 'docsDir 下全部 .mdx']} size={14} />

      <Arrow from={[200, 124]} to={[200, 150]} />
      <Box x={10} y={150} w={380} h={40} lines={['keywords 含 gwb-plugin 才登记用例']} tone="a" size={13.5} />
      <Arrow from={[200, 190]} to={[200, casesTop]} tone="a" />

      {CASES.map((lines, index) => (
        <Box key={lines[0]} x={10} y={casesTop + index * 56} w={380} h={46} lines={lines} size={14} />
      ))}
      <Note x={10} y={casesTop + 5 * 56 + 8} size={12} color={MUTED}>
        不数命令条数：条数只有运行时知道
      </Note>
    </svg>
  )
}
