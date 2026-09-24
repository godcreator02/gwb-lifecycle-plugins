/**
 * 接缝 10：被处理的仓按目录树从上往下排，每一行是 devkit 的某几条命令依赖的一处约定；右边的标签是依赖它的命令
 * （dev = devkit.dev，release = devkit.release，体检 = devkit.audit-structure，对账 = devkit.audit-deps）。
 * 这些约定没有一份检查合在一起查。
 */

import { FG, MONO, MUTED, NARROW } from './parts'

interface Row {
  path: string
  depth: number
  note: string
  users: string
}

const ROWS: Row[] = [
  { path: '<单元>/unit.json', depth: 0, note: '先读它决定这个单元跳不跳过', users: '对账 体检' },
  { path: '<仓根>/.git', depth: 1, note: 'git 工作区干净才发；不是 git 仓也拒', users: 'release' },
  { path: '<仓根>/package.json', depth: 1, note: '仓根能 pnpm build，不在包目录构建', users: 'dev release' },
  { path: '<仓根>/pnpm-workspace.yaml', depth: 1, note: '组装发布内容时，从包目录往上找仓根', users: 'dev release' },
  { path: 'plugins/*  packages/*', depth: 1, note: '成员放在这两处；对账另读 apps/*、docs-site', users: '体检 对账' },
  { path: '<包>/package.json', depth: 2, note: 'files 是产物清单，keywords 含 gwb-plugin 是插件', users: '全部' },
  { path: '<包>/dist/client.js', depth: 2, note: '浏览器侧产物入口；node 侧是 exports["."]', users: 'release' },
  { path: '<包>/node_modules/', depth: 2, note: 'importmap 里的名字从依赖的清单现读', users: 'release' },
  { path: '<包>/tsconfig.build.json', depth: 2, note: '类型检查按它，没有就用 tsconfig.json', users: 'release' },
]

const ROW_H = 48
const TOP = 12

export function SeamRepoShape() {
  return (
    <svg viewBox="0 0 400 488" className={NARROW} role="img" aria-label="devkit 的几条命令对被处理的仓做的约定，按目录树排">
      {ROWS.map((row, index) => {
        const y = TOP + index * ROW_H
        const x = 10 + row.depth * 16
        return (
          <g key={row.path}>
            {row.depth > 0 && <line x1={x - 9} y1={y - 6} x2={x - 9} y2={y + 12} stroke={MUTED} strokeWidth={1} />}
            {row.depth > 0 && <line x1={x - 9} y1={y + 12} x2={x - 3} y2={y + 12} stroke={MUTED} strokeWidth={1} />}
            <text x={x} y={y + 16} fontSize={13} fill={FG} fontFamily={MONO}>
              {row.path}
            </text>
            <text x={390} y={y + 16} textAnchor="end" fontSize={12} fill="var(--diagram-a)">
              {row.users}
            </text>
            <text x={x} y={y + 35} fontSize={12.5} fill={MUTED}>
              {row.note}
            </text>
          </g>
        )
      })}
      <text x={10} y={TOP + ROWS.length * ROW_H + 16} fontSize={12} fill={MUTED}>
        dev = devkit.dev，release = devkit.release
      </text>
      <text x={10} y={TOP + ROWS.length * ROW_H + 34} fontSize={12} fill={MUTED}>
        体检 = devkit.audit-structure，对账 = devkit.audit-deps
      </text>
    </svg>
  )
}
