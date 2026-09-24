/**
 * 接缝 11：devkit.services 只有一路数据——调用它的那个 home 顶层 node_modules 里各包的 .d.ts。
 * 上面是它在 .d.ts 里认的写法，中间是命令，下面是每个包按「类型定义在不在自己的声明里」分进的两栏。
 */

import { Arrow, Box, FG, Frame, MONO, MUTED, NARROW, Note } from './parts'

const DECLARATION = ["declare module 'cordis' {", '  interface Context {', '    gwbExample: GwbExample', '  }', '}']

function Lines({ x, y, lines }: { x: number; y: number; lines: string[] }) {
  return (
    <g>
      {lines.map((line, index) => (
        <text key={line} x={x} y={y + index * 20} fontSize={12.5} fill={FG} fontFamily={MONO} xmlSpace="preserve">
          {line}
        </text>
      ))}
    </g>
  )
}

export function SeamServiceTable() {
  return (
    <svg viewBox="0 0 400 430" className={NARROW} role="img" aria-label="devkit.services 从 home 里各包的 .d.ts 读服务声明，按类型定义在不在自己的声明里分成提供方与使用方">
      <Frame x={4} y={4} w={392} h={140} label="home 顶层 node_modules 里每个包的全部 .d.ts" size={12.5} />
      <Lines x={16} y={44} lines={DECLARATION} />

      <Arrow from={[200, 144]} to={[200, 184]} label="服务名、类型名、可选" labelSize={12} />
      <Box x={100} y={184} w={200} h={48} lines={['devkit.services', '无参数']} tone="a" size={13.5} />

      <Arrow from={[150, 232]} to={[100, 280]} />
      <Arrow from={[250, 232]} to={[300, 280]} />

      <Box x={10} y={280} w={185} h={62} lines={['providers', '类型定义在', '自己的声明里']} tone="b" size={13} />
      <Box x={205} y={280} w={185} h={62} lines={['declaredAlsoBy', '类型从别的包', 'import 来']} size={13} />

      <Note x={10} y={374} size={12} color={MUTED}>
        definition：第一个提供方里那个类型的定义原文与文档注释
      </Note>
      <Note x={10} y={396} size={12} color={MUTED}>
        providers 多于一个：有包带着重复或过期的声明，照实列出
      </Note>
    </svg>
  )
}
