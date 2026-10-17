/**
 * 接缝图：大虚线框是本仓，里面是 devkit、插件管理两个包；模块之间、模块与仓外之间的连线是接缝，
 * 编号与入口页的接缝表一一对应。实线接缝有代码接口，点线接缝只靠约定。
 */
import { BG, Box, FG, MONO, MUTED, Note } from './parts'

const SEAM = 'var(--diagram-b)'

function Package({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={10} fill="none" stroke={MUTED} strokeWidth={1} strokeDasharray="5 4" />
}

function PackageLabel({ x, y, name, path, anchor = 'start' }: { x: number; y: number; name: string; path?: string; anchor?: 'start' | 'middle' | 'end' }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={12.5} fontWeight={600} fill={FG}>
      {name}
      {path !== undefined && (
        <tspan dx={6} fontSize={11} fontWeight={400} fill={MUTED} fontFamily={MONO}>
          {path}
        </tspan>
      )}
    </text>
  )
}

function SeamLine({ d, byConvention }: { d: string; byConvention?: boolean }) {
  return <path d={d} fill="none" stroke={byConvention ? MUTED : SEAM} strokeWidth={1.4} strokeDasharray={byConvention ? '2 3' : undefined} />
}

function Badge({ x, y, n, byConvention }: { x: number; y: number; n: number; byConvention?: boolean }) {
  const color = byConvention ? MUTED : SEAM
  return (
    <g>
      <circle cx={x} cy={y} r={9} fill={BG} stroke={color} strokeWidth={1.2} strokeDasharray={byConvention ? '2 2' : undefined} />
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={10.5} fontWeight={600} fill={color}>
        {n}
      </text>
    </g>
  )
}

export function SeamMap() {
  return (
    <svg viewBox="0 0 760 600" role="img" aria-label="gwb-lifecycle-plugins 仓的两个包与九条接缝">
      <Package x={20} y={80} w={520} h={370} />
      <PackageLabel x={528} y={98} name="本仓" path="gwb-lifecycle-plugins" anchor="end" />
      <Package x={40} y={120} w={300} h={310} />
      <PackageLabel x={52} y={138} name="开发套件" path="plugins/devkit" />

      <SeamLine d="M300,120 V60" />
      <SeamLine d="M326,214 H360" />
      <SeamLine d="M326,260 H440 V240" byConvention />
      <SeamLine d="M189,380 V260 H196" byConvention />
      <SeamLine d="M326,306 H550 V352 H570" byConvention />
      <SeamLine d="M326,160 H345 V112 H570" byConvention />
      <SeamLine d="M520,212 H570" />
      <SeamLine d="M520,232 H560 V282 H570" />
      <SeamLine d="M300,430 V510" byConvention />

      <Box x={230} y={20} w={200} h={40} lines={['工作台服务', 'gwbCommands · gwbNodeCli · gwbSkills']} />

      <Box x={52} y={150} w={130} h={36} lines={['建仓', 'scaffold']} tone="a" mono />
      <Box x={196} y={150} w={130} h={36} lines={['测试 home', 'home.*']} tone="a" mono />
      <Box x={196} y={196} w={130} h={36} lines={['改一版看一版', 'dev']} tone="a" mono />
      <Box x={196} y={242} w={130} h={36} lines={['发正式版', 'release']} tone="a" mono />
      <Box x={196} y={288} w={130} h={36} lines={['CDP 驱动', 'cdp.mjs']} tone="a" mono />
      <Box x={52} y={380} w={274} h={36} lines={['建仓模板', 'template/']} tone="a" mono />

      <Box x={360} y={130} w={160} h={110} lines={['插件管理', 'plugins/plugin-manager']} tone="a" />

      <Box x={570} y={90} w={170} h={44} lines={['内核与 home', 'exe · runtime.json · gwb.log']} />
      <Box x={570} y={190} w={170} h={44} lines={['cordis loader', '条目树']} />
      <Box x={570} y={330} w={170} h={44} lines={['工作台页面', 'window.gwb']} />
      <Box x={570} y={260} w={170} h={44} lines={['pnpm 与包源', '@pnpm/exe · npmrc · registry']} />

      <Box x={260} y={510} w={280} h={44} lines={['被测插件仓', 'build 脚本 · files · keywords · 布局']} />

      <Badge x={300} y={95} n={1} />
      <Badge x={343} y={214} n={2} />
      <Badge x={400} y={260} n={3} byConvention />
      <Badge x={189} y={352} n={4} byConvention />
      <Badge x={440} y={306} n={6} byConvention />
      <Badge x={455} y={112} n={7} byConvention />
      <Badge x={545} y={212} n={8} />
      <Badge x={560} y={257} n={9} />
      <Badge x={300} y={475} n={10} byConvention />

      <Note x={20} y={585}>虚线框是包；实线接缝有代码接口，点线接缝只靠约定</Note>
    </svg>
  )
}
