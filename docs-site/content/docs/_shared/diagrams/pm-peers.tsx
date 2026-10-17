/**
 * 一个插件 peer 的例子从声明走到 list 回执：插件 gwb-foo 的 peer 写了外壳、数据插件（可选）、设置插件；
 * home 里外壳装的是 0.12.4、数据插件与设置插件没装；list 回执的 unmetPeers 里外壳带 installed、设置插件没有，可选的数据插件不算。
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

export function PmPeers() {
  return (
    <svg viewBox="0 0 400 540" className={NARROW} role="img" aria-label="插件 peer 的一个例子：声明、home 里装的版本、list 回执里的 unmetPeers">
      <Frame x={4} y={4} w={392} h={166} label="插件 gwb-foo 的 package.json" size={13} />
      <Code
        x={16}
        y={48}
        lines={['"peerDependencies": {', '  "@godcreator/gwb-shell": "^0.13.7",', '  "@godcreator/gwb-data": "^0.1.7",', '  "@godcreator/gwb-settings": "^0.3.3" },', '"peerDependenciesMeta": {', '  "@godcreator/gwb-data": { "optional": true } }']}
      />

      <Arrow from={[200, 170]} to={[200, 206]} label="list 读 home 里装的版本" labelSize={12} />

      <Frame x={4} y={206} w={392} h={110} label="home 的 node_modules" size={13} />
      <Code x={16} y={250} lines={['@godcreator/gwb-shell     0.12.4', '@godcreator/gwb-data      不在', '@godcreator/gwb-settings  不在']} />
      <Note x={384} y={250} anchor="end" size={12} color="var(--diagram-b)">
        不在范围里
      </Note>
      <Note x={384} y={269} anchor="end" size={12} color={MUTED}>
        可选，不算
      </Note>
      <Note x={384} y={288} anchor="end" size={12} color="var(--diagram-b)">
        没装
      </Note>

      <Arrow from={[200, 316]} to={[200, 352]} tone="a" />

      <Frame x={4} y={352} w={392} h={150} label="list 回执里 gwb-foo 这一行" lit size={13} />
      <Code
        x={16}
        y={394}
        lines={['unmetPeers: [', '  { pkg: "@godcreator/gwb-shell",', '    range: "^0.13.7", installed: "0.12.4" },', '  { pkg: "@godcreator/gwb-settings",', '    range: "^0.3.3" } ]']}
      />
      <Note x={10} y={528} size={12.5} color={MUTED}>
        只报告：gwb-foo 照常加载，插件管理不替它升级或安装
      </Note>
    </svg>
  )
}
