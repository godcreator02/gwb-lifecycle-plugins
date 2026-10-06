/**
 * 页面与 agent 经命令插件按名字调插件管理的 10 条命令，别的插件 inject 服务 gwbPluginManager；
 * 除了 search，命令校验参数后调服务上的同名方法。
 */

import { Arrow, Box, BORDER, FG, MUTED, Note } from './parts'

export function PmCommands() {
  return (
    <svg viewBox="0 0 760 270" role="img" aria-label="插件管理的命令与服务">
      <Box x={14} y={30} w={170} h={46} lines={['插件管理窗格', 'gwb-baseui 的页面']} />
      <Box x={14} y={100} w={170} h={46} lines={['agent', '经 MCP 入口的 run']} />
      <Box x={14} y={176} w={170} h={46} lines={['别的插件', '主进程里']} />

      <Box x={250} y={66} w={160} h={84} lines={['命令插件', 'gwbCommands', '按名字转交']} />
      <Arrow from={[184, 53]} to={[250, 88]} />
      <Arrow from={[184, 123]} to={[250, 108]} />
      <Arrow from={[410, 100]} to={[482, 90]} />

      <Note x={478} y={20} size={12} color={FG} weight={600}>
        plugin-manager
      </Note>
      <rect x={470} y={28} width={276} height={206} rx={10} fill="none" stroke={BORDER} />
      <Box
        x={482}
        y={40}
        w={252}
        h={120}
        lines={['10 条命令 plugin-manager.*', 'list · install · uninstall', 'outdated · update', 'add-entry · remove-entry', 'enable · disable', 'search']}
        tone="a"
      />
      <Box x={482} y={172} w={252} h={52} lines={['服务 gwbPluginManager', '继承 Service，命令调它的方法']} />
      <Arrow from={[184, 206]} to={[482, 198]} label="inject，调方法" labelAt="below" />

      <Note x={380} y={262} anchor="middle" size={11.5} color={MUTED}>
        除了 search，命令只校验参数、再调服务的同名方法；装卸、升级的 BUSY 检查在方法里
      </Note>
    </svg>
  )
}
