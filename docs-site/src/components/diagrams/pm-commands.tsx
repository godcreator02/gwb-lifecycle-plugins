/**
 * 对外只有命令：左边三类调用方都经命令插件按名字调用插件管理的 12 条命令；别的插件另外可以 inject
 * 服务 gwbPluginManager，它只表示插件管理装了，上面没有方法。
 */

import { Arrow, Box, BORDER, FG, MUTED, Note } from './parts'

export function PmCommands() {
  return (
    <svg viewBox="0 0 760 270" role="img" aria-label="插件管理对外只有命令">
      <Box x={14} y={30} w={170} h={46} lines={['插件管理窗格', 'gwb-baseui 的页面']} />
      <Box x={14} y={100} w={170} h={46} lines={['agent', '经 MCP 入口的 run']} />
      <Box x={14} y={176} w={170} h={46} lines={['别的插件', '主进程里']} />

      <Box x={250} y={66} w={160} h={84} lines={['命令插件', 'gwbCommands', '按名字转交']} />
      <Arrow from={[184, 53]} to={[250, 88]} />
      <Arrow from={[184, 123]} to={[250, 108]} />
      <Arrow from={[184, 190]} to={[250, 130]} />
      <Arrow from={[410, 100]} to={[482, 90]} />

      <Note x={478} y={20} size={12} color={FG} weight={600}>
        plugin-manager
      </Note>
      <rect x={470} y={28} width={276} height={206} rx={10} fill="none" stroke={BORDER} />
      <Box
        x={482}
        y={40}
        w={252}
        h={104}
        lines={['12 条命令 plugin-manager.*', 'list · install · uninstall · outdated', 'update-all · add-entry · remove-entry', 'enable · disable · remount', 'set-label · transfer-owner']}
        tone="a"
      />
      <Box x={482} y={166} w={252} h={56} lines={['服务 gwbPluginManager', '{ contract: 1 }，上面没有方法']} dashed />
      <Arrow from={[184, 206]} to={[482, 196]} dashed label="inject：跟着它一起加载、卸载" labelAt="below" />

      <Note x={380} y={262} anchor="middle" size={11.5} color={MUTED}>
        读写与动作一律走命令；改动命令都经过同一道 BUSY 检查，没有绕开它的调用方式
      </Note>
    </svg>
  )
}
