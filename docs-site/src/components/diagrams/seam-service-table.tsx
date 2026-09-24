/**
 * 接缝 11：devkit.services 与 devkit.capabilities 的两路数据。上面是 cordis 的运行时结构（不是文档化接口，靠约定），
 * 两条命令都从它读服务表；下面是 home 里各包的 package.json，gwb.provides 在两条命令里的键不一样。
 */

import { Arrow, Box, FG, Frame, MONO, MUTED, NARROW, Note } from './parts'

const CORDIS = ['ctx.fiber → parent.fiber，最多 32 层', 'registry.entries() → runtime.fibers', 'fiber.store：只收 impl.fiber 是它的', 'fiber.entry.id、entry.options.name']
const MANIFEST = ['gwb.provides：{ summary, usage }', 'gwb.shared、exports、keywords', 'home 的 dependencies：列哪些包']

function Lines({ x, y, lines }: { x: number; y: number; lines: string[] }) {
  return (
    <g>
      {lines.map((line, index) => (
        <text key={line} x={x} y={y + index * 20} fontSize={12.5} fill={FG} fontFamily={MONO}>
          {line}
        </text>
      ))}
    </g>
  )
}

export function SeamServiceTable() {
  return (
    <svg viewBox="0 0 400 470" className={NARROW} role="img" aria-label="devkit.services 与 devkit.capabilities 从 cordis 与 package.json 读什么">
      <Frame x={4} y={4} w={392} h={120} label="cordis 4.0.0-rc.9 的运行时结构（靠约定）" size={12.5} />
      <Lines x={16} y={44} lines={CORDIS} />

      <Arrow from={[100, 124]} to={[100, 170]} label="服务表" labelSize={12} />
      <Arrow from={[300, 124]} to={[300, 170]} label="服务表" labelSize={12} />

      <Box x={10} y={170} w={185} h={62} lines={['devkit.services', '服务由哪个条目、', '哪个包提供']} tone="a" size={13.5} />
      <Box x={205} y={170} w={185} h={62} lines={['devkit.capabilities', '可注入的服务、', 'import 入口、类型文件']} tone="a" size={13.5} />

      <Arrow from={[100, 292]} to={[100, 232]} label="键是服务名" labelSize={12} />
      <Arrow from={[300, 292]} to={[300, 232]} label="键是模块说明符" labelSize={12} />

      <Frame x={4} y={292} w={392} h={104} label="home 里各包的 package.json" size={12.5} />
      <Lines x={16} y={332} lines={MANIFEST} />

      <Note x={10} y={424} size={12} color={MUTED}>
        结构认不出：回空表，带 note 与 saw，不抛错
      </Note>
      <Note x={10} y={446} size={12} color={MUTED}>
        gwb.provides 与源码对不对得上：发版前检查与结构体检查
      </Note>
    </svg>
  )
}
