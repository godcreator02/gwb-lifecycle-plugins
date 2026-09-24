/**
 * 一个 gwb.requires 的例子从声明走到 list 回执：插件 gwb-foo 要求外壳至少 0.5.0、数据插件至少 0.3.0；
 * home 里外壳装的是 0.4.2、数据插件没装；list 回执里这两条都进 unmetRequires，没装的那条没有 installed。
 */

import { Arrow, FG, Frame, MUTED, NARROW, Note } from './parts'

function Code({ x, y, lines, color = FG }: { x: number; y: number; lines: string[]; color?: string }) {
  return (
    <g>
      {lines.map((line, index) => (
        <text key={line} x={x} y={y + index * 19} fontSize={12} fill={color} fontFamily="var(--font-mono, monospace)" style={{ whiteSpace: 'pre' }}>
          {line}
        </text>
      ))}
    </g>
  )
}

export function PmRequires() {
  return (
    <svg viewBox="0 0 400 472" className={NARROW} role="img" aria-label="gwb.requires 的一个例子：声明、home 里装的版本、list 回执里的 unmetRequires">
      <Frame x={4} y={4} w={392} h={108} label="插件 gwb-foo 的 package.json" size={13} />
      <Code x={16} y={48} lines={['"gwb": { "requires": {', '  "@godcreator/gwb-shell": "0.5.0",', '  "@godcreator/gwb-data": "0.3.0"', '} }']} />

      <Arrow from={[200, 112]} to={[200, 148]} label="list 读 home 里装的版本" labelSize={12} />

      <Frame x={4} y={148} w={392} h={92} label="home 的 node_modules" size={13} />
      <Code x={16} y={192} lines={['@godcreator/gwb-shell   0.4.2', '@godcreator/gwb-data    不在']} />
      <Note x={384} y={192} anchor="end" size={12} color="var(--diagram-b)">
        比 0.5.0 低
      </Note>
      <Note x={384} y={211} anchor="end" size={12} color="var(--diagram-b)">
        没装
      </Note>

      <Arrow from={[200, 240]} to={[200, 276]} tone="a" />

      <Frame x={4} y={276} w={392} h={162} label="list 回执里 gwb-foo 这一行" lit size={13} />
      <Code
        x={16}
        y={318}
        lines={['requires: { 与声明相同 }', 'unmetRequires: [', '  { pkg: "@godcreator/gwb-shell",', '    required: "0.5.0", installed: "0.4.2" },', '  { pkg: "@godcreator/gwb-data",', '    required: "0.3.0" } ]']}
      />
      <Note x={10} y={460} size={12.5} color={MUTED}>
        只报告：gwb-foo 照常加载，插件管理不替它升级外壳
      </Note>
    </svg>
  )
}
