'use client'

/**
 * 改一版看一版的循环：左列是控制台 home 里开发套件自己做的（构建、发开发版），右列是在目标 home 里做的
 * （问页面是哪个 home、装、重新加载、刷新、取证），右列的页面操作都经 bin/cdp.mjs 按 home 名连过去。
 * 最后一步沿右边的折线回到「改代码」，表示看完回执接着改。
 */

import { Arrow, Box, MUTED, NARROW, Note, Route, type Tone } from './parts'
import { StepControls, StepText, useSteps } from './steps'

type Part = 'edit' | 'dev' | 'build' | 'publish' | 'registry' | 'ask' | 'install' | 'remount' | 'reload' | 'evidence'

type Flow = 'edit-dev' | 'dev-ask' | 'dev-build' | 'build-publish' | 'publish-registry' | 'registry-install' | 'install-remount' | 'remount-reload' | 'reload-evidence' | 'back'

const STEPS: { title: string; detail: string; lit: Part[]; flows: Flow[]; back?: boolean }[] = [
  {
    title: '全貌',
    detail: '改完代码调一次 devkit.dev {home, dir, packages}，七步依次做，任何一步失败当场停，回执写明停在哪一步。右列的页面操作都经 bin/cdp.mjs 子进程，按 home 名连过去。',
    lit: [],
    flows: [],
  },
  { title: '改代码', detail: '在仓的工作区里改，不用提交：devkit.dev 不看 git 状态，未提交的改动照样发成开发版。', lit: ['edit'], flows: ['edit-dev'] },
  {
    title: '第 1 步：问目标页面它是哪个 home',
    detail: '页面上的 file:// 地址带着 home 路径。目标是 default、或者就是开发套件自己所在的 home，直接拒：替换插件的工具不能运行在被替换的进程里。',
    lit: ['ask'], flows: ['dev-ask'],
  },
  { title: '第 2 步：仓根 pnpm build', detail: '在仓根构建，不在包目录：同仓的包常常用着另一个包的产物，只构建被发的那个，发出去的就是新插件配旧库。', lit: ['build'], flows: ['dev-build'] },
  {
    title: '第 3 步：发开发版',
    detail: '版本号是 <patch+1>-dev.<yyyyMMddHHmm>，不动 latest。版本号变了，装上之后路径才变，重新加载时模块才真的重新执行。同一个版本号已在源上就拒。',
    lit: ['publish', 'registry'], flows: ['build-publish', 'publish-registry'],
  },
  {
    title: '第 4 步：装进目标 home',
    detail: '先记下 gwb.log 的长度当基线。在目标 home 的 package.json 里写准确版本号再 pnpm install，装完读 node_modules/<包>/package.json 核对；对不上就停、不重新加载。',
    lit: ['install'], flows: ['registry-install'],
  },
  {
    title: '第 5 步：重新加载条目',
    detail: '用 plugin-manager.list 找到这个包的条目，每条发一条 plugin-manager.remount。回执 remounted 要是 ACTIVE；回执 deferred（插件管理重新加载自己）就每 500 毫秒轮询 list，最多等 60 秒。',
    lit: ['remount'], flows: ['install-remount'],
  },
  { title: '第 6 步：整页刷新', detail: '页面代码与样式表要整页重新加载才会重新取。给了 waitFor 选择器就等它出现再往下走。', lit: ['reload'], flows: ['remount-reload'] },
  {
    title: '第 7 步：取证',
    detail: '三样都对才 ok：装上的就是这次的版本号；条目都是 ACTIVE；gwb.log 基线之后新增的部分没有 error。取不到或不对，回 ok: false 并说明是哪一样。',
    lit: ['evidence'], flows: ['reload-evidence'],
  },
  { title: '读回执，接着改', detail: '回执里有发出的版本号、重新加载了哪几条条目、取证结果与日志里新增的 warn。看完回到改代码，再调一次 devkit.dev。', lit: ['edit'], flows: ['back'], back: true },
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
      <svg viewBox="0 0 400 520" className={NARROW} role="img" aria-label="devkit.dev：改代码、构建、发开发版、装进目标 home、重新加载、刷新、取证，再回到改代码">
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
        <Box x={LX} y={row(2)} w={LW} h={H} lines={['发开发版', '版本号带 -dev.<时间>']} tone={on('publish')} size={14} />
        <Box x={LX} y={row(3) + 20} w={LW} h={H} lines={['团队源', 'gitea 个人源']} tone={on('registry')} dashed size={14} />

        <Box x={RX} y={row(0)} w={RW} h={H} lines={['页面报自己的 home', 'cdp home']} tone={on('ask')} size={14} mono />
        <Box x={RX} y={row(1)} w={RW} h={H} lines={['写准确版本号', 'pnpm install，读回核对']} tone={on('install')} size={14} />
        <Box x={RX} y={row(2)} w={RW} h={H} lines={['重新加载条目', 'plugin-manager.remount']} tone={on('remount')} size={14} mono />
        <Box x={RX} y={row(3)} w={RW} h={H} lines={['整页刷新', 'cdp reload']} tone={on('reload')} size={14} mono />
        <Box x={RX} y={row(4)} w={RW} h={H} lines={['取证', '版本号 · ACTIVE · gwb.log']} tone={on('evidence')} size={14} />

        <Arrow from={[LX + LW / 2, 10 + H]} to={[LX + LW / 2, row(0)]} tone={moving('edit-dev') ? 'a' : undefined} flow={moving('edit-dev')} />
        <Arrow from={[LX + LW, row(0) + H / 2]} to={[RX, row(0) + H / 2]} tone={moving('dev-ask') ? 'a' : undefined} flow={moving('dev-ask')} />
        <Arrow from={[LX + LW / 2, row(0) + H]} to={[LX + LW / 2, row(1)]} tone={moving('dev-build') ? 'a' : undefined} flow={moving('dev-build')} />
        <Arrow from={[LX + LW / 2, row(1) + H]} to={[LX + LW / 2, row(2)]} tone={moving('build-publish') ? 'a' : undefined} flow={moving('build-publish')} />
        <Arrow from={[LX + LW / 2, row(2) + H]} to={[LX + LW / 2, row(3) + 20]} tone={moving('publish-registry') ? 'a' : undefined} flow={moving('publish-registry')} />
        <Route
          points={[
            [LX + LW, row(3) + 20 + H / 2],
            [180, row(3) + 20 + H / 2],
            [180, row(1) + H / 2],
            [RX, row(1) + H / 2],
          ]}
          tone={moving('registry-install') ? 'a' : undefined}
          flow={moving('registry-install')}
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
