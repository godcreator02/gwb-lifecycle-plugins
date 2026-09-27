'use client'

/**
 * devkit.home.new 开一个测试 home 的七步：取名、选调试端口、定启动计划、装内核包、cordis 与基础插件、启动、观察五秒、读运行时记录。
 * 可能失败的步骤都排在启动之前。最下面一行是之后怎么用它：只按名字找到它；改内核源码的验证是内核仓自己的流程。
 */

import { Arrow, Box, Chain, type ChainItem, NARROW } from './parts'
import { StepControls, StepText, useSteps } from './steps'

const ITEMS: ChainItem[] = [
  { lines: ['1 取名', '<短名>-<yyMMddHHmm>'], mono: true },
  { lines: ['2 选调试端口', '先沿用上次的，被占了才另选'] },
  { lines: ['3 定启动计划', '启动宿主自己那个应用'] },
  { lines: ['4 写 cordis.yml，pnpm add 三次', '内核包 → cordis → 基础插件（含 timer）'] },
  { lines: ['5 启动', 'GWB_HOME=<名> + 两个调试开关'] },
  { lines: ['6 观察五秒', '进程刚启动就退出 → 报错'] },
  { lines: ['7 读 runtime.json', '内核写 cdp 等，MCP 入口补 mcp'] },
]

const STEPS: { title: string; detail: string; active: number }[] = [
  { title: '全貌', detail: '前四格都可能失败，全部排在启动进程之前：启动之后再失败，会留下一个没有记录、谁也管不了的窗口。devkit.home.open 重开已有的 home，走同一个启动计划，但不装包。', active: -1 },
  { title: '第 1 步：取名', detail: '名字是 <短名>-<yyMMddHHmm>，home 在 %APPDATA%\\gwb-kernel\\homes\\<名>\\。重名了改用秒，再重名就拒，不悄悄加序号。', active: 0 },
  {
    title: '第 2 步：选调试端口',
    detail: '这个 home 上次用的端口空着就沿用。被占了才另选：别的 home 记录里写着的端口一律跳过（过时的记录也算占着），再从 9400 起逐个问有没有进程在监听。一个空的都找不到就不启动。',
    active: 1,
  },
  { title: '第 3 步：定启动计划', detail: '启动的是宿主自己那个应用，日常是安装版（只带启动器，内核从 home 里的内核包加载），不构建内核、不认内核仓；宿主是开发态 electron 就拒。同一个 home 已有实例在运行也拒。', active: 2 },
  { title: '第 4 步：装内核包、cordis 与基础插件', detail: '只有 new 做这一步：往新建的 home 目录写 cordis.yml，每个基础插件一条条目；在 home 目录里依次 pnpm add 三次：内核包（运行中的内核的精确版本）；装上的内核包清单里 peer 写的那个精确版本的 cordis（--save-exact）；基础插件，其中有提供 timer 服务的 @cordisjs/plugin-timer。内核包与 cordis 装完都读 node_modules 里的清单核对版本。哪一步不成都不启动，回执带 pnpm 输出的最后几行。', active: 3 },
  {
    title: '第 5 步：启动',
    detail: '环境变量 GWB_HOME 是这个 home 的名字，去掉 ELECTRON_RUN_AS_NODE；命令行带 --remote-debugging-port=<端口> 与 --disable-backgrounding-occluded-windows（窗口被挡住时也照常渲染）。',
    active: 4,
  },
  { title: '第 6 步：观察五秒', detail: '「启动成功没有」没有接口可问，进程还活着是唯一的信号。这五秒只抓刚启动就退出这一种失败，报错指向这个 home 的 gwb.log。', active: 5 },
  { title: '第 7 步：读运行时记录', detail: 'runtime.json 由内核写 pid、startedAt、cdp，MCP 入口插件补上 mcp；本包只读这几项。读不到不算启动失败，但回执会说明：之后按名字找它全靠这份记录。', active: 6 },
  {
    title: '之后：只按名字找到它',
    detail: 'devkit.dev、devkit.cdp、devkit.home.open / rm 都只收 home 名，端口从 runtime.json 查。改了内核源码要验证，走内核仓自己的流程，开发套件不做。',
    active: 7,
  },
]

const TOP = 12
const H = 48
const GAP = 16
const LAST = TOP + ITEMS.length * (H + GAP) + 8

export function DkHomeNew() {
  const state = useSteps(STEPS.length, 3400)
  const current = STEPS[state.step]!
  const after = current.active === 7
  return (
    <>
      <svg viewBox="0 0 400 540" className={NARROW} role="img" aria-label="devkit.home.new 开一个测试 home 的七步，之后只按名字找到它">
        <Chain x={10} y={TOP} w={380} h={H} gap={GAP} items={ITEMS} active={current.active} />
        <Arrow from={[200, LAST - GAP - 8]} to={[200, LAST]} tone={after ? 'a' : undefined} flow={after} />
        <Box x={10} y={LAST} w={220} h={H + 6} lines={['按名字找到它', 'dev、cdp、home.open / rm']} tone={after ? 'a' : undefined} dim={current.active >= 0 && !after} size={14} />
        <Box x={242} y={LAST} w={148} h={H + 6} lines={['改内核源码', '内核仓自己的流程']} dashed dim={current.active >= 0 && !after} size={14} />
      </svg>
      <StepText title={current.title} detail={current.detail} />
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
