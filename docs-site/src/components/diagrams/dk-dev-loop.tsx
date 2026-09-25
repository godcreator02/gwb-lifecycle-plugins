'use client'

/**
 * 改一版看一版的循环：左列是控制台 home 里开发套件自己做的（构建、打包进目标 home 的 dev-packs），右列是在目标 home 里做的
 * （问页面是哪个 home、插件管理装包并重新加载、刷新、取证），右列的页面操作都经 bin/cdp.mjs 按 home 名连过去。
 * 最后一步沿右边的折线回到「改代码」，表示看完回执接着改。
 */

import { Arrow, Box, MUTED, NARROW, Note, Route, type Tone } from './parts'
import { StepControls, StepText, useSteps } from './steps'

type Part = 'edit' | 'dev' | 'build' | 'pack' | 'packs' | 'ask' | 'install' | 'remount' | 'reload' | 'evidence'

type Flow = 'edit-dev' | 'dev-ask' | 'dev-build' | 'build-pack' | 'pack-packs' | 'packs-install' | 'install-remount' | 'remount-reload' | 'reload-evidence' | 'back'

const STEPS: { title: string; detail: string; lit: Part[]; flows: Flow[]; back?: boolean }[] = [
  {
    title: '全貌',
    detail: '改完代码调一次 devkit.dev {home, dir, packages}，依次做下去，任何一步失败当场停，回执写明停在哪一步。右列的页面操作都经 bin/cdp.mjs 子进程，按 home 名连过去。开发版不进任何 npm 源。',
    lit: [],
    flows: [],
  },
  { title: '改代码', detail: '在仓的工作区里改，不用提交：devkit.dev 不看 git 状态，未提交的改动照样打包进开发版。', lit: ['edit'], flows: ['edit-dev'] },
  {
    title: '第 1 步：问目标页面它是哪个 home',
    detail: '页面上的 file:// 地址带着 home 路径。目标是 default、或者就是开发套件自己所在的 home，直接拒：替换插件的工具不能运行在被替换的进程里。',
    lit: ['ask'], flows: ['dev-ask'],
  },
  { title: '第 2 步：仓根 pnpm build', detail: '在仓根构建，不在包目录：同仓的包常常用着另一个包的产物，只构建被装的那个，装进去的就是新插件配旧库。构建之后带界面的插件过样式检查（类名前缀、颜色只用主题令牌），没过就停，一个都不装。', lit: ['build'], flows: ['dev-build'] },
  {
    title: '第 3 步：打包进目标 home',
    detail: '只收插件与内核包，库直接拒。版本号是 <patch+1>-dev.<yyyyMMddHHmmss>，pnpm pack 到目标 home 的 dev-packs 目录。包文件路径每版不同，已存在就拒；旧的包文件不删，home 清单还引用着它们。',
    lit: ['pack', 'packs'], flows: ['build-pack', 'pack-packs'],
  },
  {
    title: '第 4 步：经插件管理装',
    detail: '先记下 gwb.log 的长度当基线。已在 home 的 dependencies 里的包合成一条 plugin-manager.update {specs}，写法是 file:./dev-packs/<包文件>；然后不在的插件逐个 plugin-manager.install，新建一条条目（先换已装的，新插件加载时 import 到的才是这次装的）。',
    lit: ['install'], flows: ['packs-install'],
  },
  {
    title: '第 5 步：插件管理重新加载',
    detail: 'update 在同一条命令里重新加载这些包与真实目录变了的别的包。插件管理自己的条目推迟到回执之后（回执 selfDeferred），这边每 500 毫秒轮询 plugin-manager.list，最多等 60 秒。装了内核包时回执 restartRequired，改成重启目标 home。',
    lit: ['remount'], flows: ['install-remount'],
  },
  { title: '第 6 步：整页刷新', detail: '页面代码与样式表要整页重新加载才会重新取。给了 waitFor 选择器就等它出现再往下走；没等到、或驱动退出码非零，回 ok: false 并写明最后看到了什么。重启了目标 home 时没有这一步。', lit: ['reload'], flows: ['remount-reload'] },
  {
    title: '第 7 步：取证',
    detail: '三样都对才 ok：装上的就是这次的版本号；条目都是 ACTIVE；gwb.log 基线之后新增的部分没有 error。取不到或不对，回 ok: false 并说明是哪一样。',
    lit: ['evidence'], flows: ['reload-evidence'],
  },
  { title: '读回执，接着改', detail: '回执里有打包的版本号与包文件、update 的回执原样、取证结果与日志里新增的 warn。看完回到改代码，再调一次 devkit.dev。', lit: ['edit'], flows: ['back'], back: true },
]

const LX = 10
const LW = 160
const RX = 206
const RW = 184
const H = 48

export function DkDevLoop() {
  const state = useSteps(STEPS.length, 3400)
  const current = STEPS[state.step]!
  const on = (part: Part): Tone | undefined => (current.lit.includes(part) ? (current.back ? 'b' : 'a') : undefined)
  const moving = (flow: Flow) => current.flows.includes(flow)
  const row = (index: number) => 104 + index * 70

  return (
    <>
      <svg viewBox="0 0 400 520" className={NARROW} role="img" aria-label="devkit.dev：改代码、构建、打包进目标 home、经插件管理装并重新加载、刷新、取证，再回到改代码">
        <Box x={LX} y={10} w={LW} h={H} lines={['改代码', '仓的工作区']} tone={on('edit')} size={14} />

        <Note x={LX} y={86} size={12.5} weight={600} color="var(--color-fd-foreground)">
          控制台 home
        </Note>
        <Note x={RX} y={86} size={12.5} weight={600} color="var(--color-fd-foreground)">
          目标 home（隔离）
        </Note>
        <line x1={188} y1={74} x2={188} y2={470} stroke={MUTED} strokeDasharray="6 5" />

        <Box x={LX} y={row(0)} w={LW} h={H} lines={['devkit.dev', 'home, dir, packages']} tone={on('dev')} mono size={14} />
        <Box x={LX} y={row(1)} w={LW} h={H} lines={['仓根 pnpm build']} tone={on('build')} size={14} />
        <Box x={LX} y={row(2)} w={LW} h={H} lines={['pnpm pack', '版本号带 -dev.<时间>']} tone={on('pack')} size={14} />
        <Box x={LX} y={row(3) + 20} w={LW} h={H} lines={['包文件', 'dev-packs，只增不删']} tone={on('packs')} dashed size={14} />

        <Box x={RX} y={row(0)} w={RW} h={H} lines={['页面报自己的 home', 'cdp home']} tone={on('ask')} size={14} mono />
        <Box x={RX} y={row(1)} w={RW} h={H} lines={['插件管理装', 'update {specs} / install']} tone={on('install')} size={14} />
        <Box x={RX} y={row(2)} w={RW} h={H} lines={['重新加载条目', '插件管理做，这边等']} tone={on('remount')} size={14} />
        <Box x={RX} y={row(3)} w={RW} h={H} lines={['整页刷新', 'cdp reload']} tone={on('reload')} size={14} mono />
        <Box x={RX} y={row(4)} w={RW} h={H} lines={['取证', '版本号 · ACTIVE · gwb.log']} tone={on('evidence')} size={14} />

        <Arrow from={[LX + LW / 2, 10 + H]} to={[LX + LW / 2, row(0)]} tone={moving('edit-dev') ? 'a' : undefined} flow={moving('edit-dev')} />
        <Arrow from={[LX + LW, row(0) + H / 2]} to={[RX, row(0) + H / 2]} tone={moving('dev-ask') ? 'a' : undefined} flow={moving('dev-ask')} />
        <Arrow from={[LX + LW / 2, row(0) + H]} to={[LX + LW / 2, row(1)]} tone={moving('dev-build') ? 'a' : undefined} flow={moving('dev-build')} />
        <Arrow from={[LX + LW / 2, row(1) + H]} to={[LX + LW / 2, row(2)]} tone={moving('build-pack') ? 'a' : undefined} flow={moving('build-pack')} />
        <Arrow from={[LX + LW / 2, row(2) + H]} to={[LX + LW / 2, row(3) + 20]} tone={moving('pack-packs') ? 'a' : undefined} flow={moving('pack-packs')} />
        <Route
          points={[
            [LX + LW, row(3) + 20 + H / 2],
            [180, row(3) + 20 + H / 2],
            [180, row(1) + H / 2],
            [RX, row(1) + H / 2],
          ]}
          tone={moving('packs-install') ? 'a' : undefined}
          flow={moving('packs-install')}
        />
        <Arrow from={[RX + RW / 2, row(1) + H]} to={[RX + RW / 2, row(2)]} tone={moving('install-remount') ? 'a' : undefined} flow={moving('install-remount')} />
        <Arrow from={[RX + RW / 2, row(2) + H]} to={[RX + RW / 2, row(3)]} tone={moving('remount-reload') ? 'a' : undefined} flow={moving('remount-reload')} />
        <Arrow from={[RX + RW / 2, row(3) + H]} to={[RX + RW / 2, row(4)]} tone={moving('reload-evidence') ? 'a' : undefined} flow={moving('reload-evidence')} />
        <Route
          points={[
            [RX + RW / 2, row(4) + H],
            [RX + RW / 2, 500],
            [396, 500],
            [396, 34],
            [LX + LW, 34],
          ]}
          tone={current.back ? 'b' : undefined}
          dashed={!current.back}
          flow={current.back}
        />
        <Note x={392} y={60} anchor="end" size={11.5} color={current.back ? 'var(--diagram-b)' : MUTED}>
          读回执，接着改
        </Note>
      </svg>
      <StepText title={current.title} detail={current.detail} />
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
