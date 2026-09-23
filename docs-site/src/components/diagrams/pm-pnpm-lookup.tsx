/**
 * 插件管理用自己依赖里的 pnpm：在 home 的 pnpm 布局里，本插件与 `@pnpm/exe.win32-x64` 放在同一个目录下，
 * 从本插件的位置解析就找到它，直接启动；找不到就报错。
 */

import { Arrow, Box, MUTED, Note } from './parts'

export function PmPnpmLookup() {
  return (
    <svg viewBox="0 0 760 214" role="img" aria-label="插件管理从自己的依赖里找到 pnpm">
      <rect x={14} y={14} width={500} height={150} rx={8} fill="none" stroke={MUTED} strokeDasharray="6 5" />
      <Note x={26} y={34} mono>
        home/node_modules/.pnpm/@godcreator+gwb-plugin-manager@&lt;版&gt;/node_modules/
      </Note>
      <Box x={30} y={52} w={200} h={56} lines={['@godcreator/gwb-plugin-manager', '插件管理自己的代码']} />
      <Box x={300} y={52} w={200} h={56} lines={['@pnpm/exe.win32-x64', '固定版本，包里只有 pnpm.exe']} tone="a" />
      <Arrow from={[230, 80]} to={[300, 80]} label="解析" />
      <Note x={30} y={144}>
        升级时连带升级 pnpm：链接换到新版本目录，旧目录和正在运行的文件留在原处
      </Note>

      <Box x={560} y={52} w={186} h={56} lines={['直接启动 pnpm.exe', '工作目录是 home']} tone="a" />
      <Arrow from={[500, 80]} to={[560, 80]} />
      <Box x={560} y={150} w={186} h={48} lines={['包或文件找不到', '报错：重装插件管理']} tone="b" />
      <Arrow from={[500, 100]} to={[560, 162]} dashed />
    </svg>
  )
}
