
/**
 * 一次 CDP 驱动的运行：上面两个入口（命令总线上的 devkit.cdp、直接用 node 运行）进的是同一个 bin/cdp.mjs；
 * 往下是按 home 名查端口、连上唯一的页面、核对页面报的 home 名、执行动作（以 cmd 为例）、把 JSON 写到标准输出。
 */

import { Arrow, Box, Chain, type ChainItem, NARROW } from './parts'
import { StepControls, StepText, useSteps } from './steps'

const ITEMS: ChainItem[] = [
  { lines: ['1 按 home 名查端口', '<home 根>/<名>/runtime.json 的 cdp'] },
  { lines: ['2 连上唯一的页面', 'GET 127.0.0.1:<端口>/json/list'] },
  { lines: ['3 核对页面属于哪个 home', '页面报的名字 = 给的名字'] },
  { lines: ['4 执行动作（以 cmd 为例）', 'window.gwb.command(名, 参数)'] },
  { lines: ['5 JSON 写到标准输出', '失败时退出码非零'] },
]

const STEPS: { title: string; detail: string; active: number; entries?: boolean }[] = [
  { title: '全貌', detail: '两个入口进的是同一个零依赖的单文件脚本 bin/cdp.mjs。它只认 home 名，每次运行都查一次端口、核对一次页面报的名字，任何一步不通就不往下走。', active: -1 },
  {
    title: '入口',
    detail: '工作台运行时经命令总线调 devkit.cdp {"args":["<home 名>","<动作>",…]}，它由 gwbNodeCli 登记，启动 node 子进程运行脚本；工作台启动不了时直接 node <包根>/bin/cdp.mjs <home 名> <动作>。',
    active: -1,
    entries: true,
  },
  { title: '第 1 步：按 home 名查端口', detail: '第一个位置一律当 home 名，给的是端口号就找不到那个 home 的记录、当场停。home 根是 %APPDATA%\\gwb-kernel\\homes；runtime.json 不在、或者没有 cdp 字段（启动时没带调试开关），都照实报连不上，让人停掉重开一次。', active: 0 },
  {
    title: '第 2 步：连上唯一的页面',
    detail: '问调试端口的 /json/list，去掉 devtools:// 页；一个都没有、或不止一个（用 --target 选）时，把候选页面的标题与地址列进报错。选定后用 WebSocket 连上它。',
    active: 1,
  },
  { title: '第 3 步：核对页面属于哪个 home', detail: '外壳插入的样式表是带 home 路径的 file:// 地址，从里面读出 home 名，跟给的名字对不上就停：记录可能过时了，端口上已经是别的进程。', active: 2 },
  {
    title: '第 4 步：执行动作',
    detail: 'cmd 在页面里执行 window.gwb.command(命令名, 参数)，页面上没有它就说这不是工作台的外壳页。别的动作：click、type、shot 等发浏览器层的真实输入，eval 执行一个文件里的函数表达式。',
    active: 3,
  },
  { title: '第 5 步：输出', detail: '结果是一段 JSON，写到标准输出；失败时照样写全，只把退出码设成非零。经 devkit.cdp 调用时，回执带 stdout、stderr 与退出码。', active: 4 },
]

const TOP = 92
const H = 50
const GAP = 20

export function DkCdp() {
  const state = useSteps(STEPS.length, 3400)
  const current = STEPS[state.step]!
  const entries = current.entries === true
  const firstActive = current.active === 0
  return (
    <>
      <svg viewBox="0 0 400 446" className={NARROW} role="img" aria-label="CDP 驱动一次运行的五步">
        <Box x={10} y={10} w={182} h={H} lines={['devkit.cdp', '经 gwbNodeCli 登记']} tone={entries ? 'a' : undefined} dim={current.active >= 0} size={14} />
        <Box x={208} y={10} w={182} h={H} lines={['node bin/cdp.mjs', '工作台没运行时']} tone={entries ? 'a' : undefined} dashed dim={current.active >= 0} size={14} />
        <Arrow from={[101, 10 + H]} to={[170, TOP]} tone={entries || firstActive ? 'a' : undefined} flow={entries} />
        <Arrow from={[299, 10 + H]} to={[230, TOP]} tone={entries || firstActive ? 'a' : undefined} flow={entries} dashed={!entries} />
        <Chain x={10} y={TOP} w={380} h={H} gap={GAP} items={ITEMS} active={current.active} />
      </svg>
      <StepText title={current.title} detail={current.detail} />
      <StepControls count={STEPS.length} state={state} />
    </>
  )
}
