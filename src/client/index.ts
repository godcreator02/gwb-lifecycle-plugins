/**
 * 「插件源」窗格的身体：跑没跑、地址、端口、pid，加 起/停/刷新 三个按钮，和**最近一次
 * 操作的回执**。原先是状态件格子墙上的一颗格子，状态格机制 2026-09-08 下架后改开普通
 * 窗格（契约从 `mountCell` 换成 `mountPane`，身体原样）。
 *
 * **只显示本次操作的状态信息**：起/停的回执（note/error）显示在操作行，随下一次操作被
 * 替换；verdaccio 自己的运行日志不进来——那些是日志的事，这格越干净越一眼。
 * 轮询只更新状态行，不动操作行。
 *
 * **零依赖**（vanilla DOM + inline 样式）：这一份由外壳按 node 半注册窗格时自报的
 * `file://` 地址动态 import，不引 react 也就不用进 importmap；tsc 直出即是可用产物，
 * 没有打包器。
 */

interface PaneArgs {
  host: { call: (command: string, args?: unknown) => Promise<unknown> }
  shell: unknown
  pane: { id: string; instance: string }
}

interface StatusData {
  dir: string
  url: string | null
  running: boolean
  pid: number | null
  adopted: boolean
  hasConfig: boolean
  hasBin: boolean
}

/** 未配置时回的那句话——措辞可以改，指挥人去设置填这件事不能不改 */
const MISSING_DIR =
  '未配置 registry-dir——到「设置」给开发套件填 registry-dir：那个含 config.yaml、storage、node_modules/verdaccio 的目录'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function portOfUrl(url: string | null): string {
  if (url === null) return '—'
  try {
    const parsed = new URL(url)
    return parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port
  } catch {
    return '—'
  }
}

function el(tag: string, cssText: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.style.cssText = cssText
  if (text !== undefined) node.textContent = text
  return node
}

const BTN =
  'padding:3px 12px;border:1px solid color-mix(in srgb, currentColor 30%, transparent);border-radius:6px;' +
  'background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;'
const BTN_OFF = 'opacity:.4;cursor:default;'

export function mountPane(args: PaneArgs, container: HTMLElement): { dispose: () => void } {
  if (args.pane.id !== 'registry') {
    const line = el('p', 'margin:8px;font-size:13px;', `开发套件不认识这扇窗：${args.pane.id}`)
    container.append(line)
    return { dispose: () => line.remove() }
  }
  const host = args.host

  const root = el('div', 'display:flex;flex-direction:column;gap:8px;font-size:13px;min-width:0;')

  // 状态行：一颗圆点 + 一句话
  const dot = el('span', 'width:9px;height:9px;border-radius:50%;background:color-mix(in srgb, currentColor 30%, transparent);flex:none;')
  const stateText = el('span', 'font-weight:600;', '查一下…')
  const stateLine = el('div', 'display:flex;align-items:center;gap:7px;')
  stateLine.append(dot, stateText)

  // 明细行：地址 / 端口 / pid
  const detail = el('div', 'display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;opacity:.85;')

  // 按钮行
  const upBtn = el('button', BTN, '起')
  const downBtn = el('button', BTN, '停')
  const refreshBtn = el('button', BTN, '刷新')
  const buttons = el('div', 'display:flex;gap:8px;align-items:center;')
  buttons.append(upBtn, downBtn, refreshBtn)

  // 操作行：**只放最近一次操作的回执**（起来了的 note、停掉的 note、失败的原因）。
  // 轮询不写它，verdaccio 的运行日志也不进它——格子只说「刚才那一下结果如何」
  const opLine = el('div', 'font-size:12px;display:none;min-width:0;')

  root.append(stateLine, detail, buttons, opLine)
  container.append(root)

  let busy = false
  let disposed = false

  function setButtons(): void {
    const off = BTN + BTN_OFF
    upBtn.style.cssText = busy ? off : BTN
    downBtn.style.cssText = busy ? off : BTN
    refreshBtn.style.cssText = busy ? off : BTN
  }

  function render(status: StatusData): void {
    const color = status.running ? '#16a34a' : 'color-mix(in srgb, currentColor 35%, transparent)'
    dot.style.background = color
    stateText.textContent = status.running ? `跑着${status.adopted ? '（接管来的）' : ''}` : '停着'
    stateText.style.color = status.running ? '#16a34a' : 'inherit'

    detail.textContent = ''
    detail.append(
      el('span', '', `地址 ${status.url ?? '—'}`),
      el('span', '', `端口 ${portOfUrl(status.url)}`),
      el('span', '', `pid ${status.pid === null ? '—' : String(status.pid)}`),
    )
    if (!status.hasBin) detail.append(el('span', 'opacity:.7;', '目录里没有 verdaccio 本体'))
  }

  /** 配置缺失是**状态本身**，进状态行；其余失败不算状态，不打扰状态行 */
  async function refresh(): Promise<void> {
    const reply = (await host.call('registry.status')) as unknown
    if (disposed || !isRecord(reply)) return
    if (reply.ok !== true) {
      const error = typeof reply.error === 'string' ? reply.error : '查状态没成'
      if (error.includes('registry-dir')) {
        stateText.textContent = '未配置'
        stateText.style.color = 'inherit'
        dot.style.background = 'color-mix(in srgb, currentColor 30%, transparent)'
        detail.textContent = ''
      }
      return
    }
    if (isRecord(reply.data)) render(reply.data as unknown as StatusData)
  }

  function showOutcome(reply: unknown): void {
    if (!isRecord(reply)) return
    if (reply.ok === true) {
      const note = isRecord(reply.data) && typeof reply.data.note === 'string' ? reply.data.note : '好了'
      opLine.textContent = note
      opLine.style.color = 'inherit'
    } else {
      opLine.textContent = typeof reply.error === 'string' ? reply.error : '没成'
      opLine.style.color = '#dc2626'
    }
    opLine.style.display = 'block'
  }

  async function act(command: string): Promise<void> {
    if (busy) return
    busy = true
    setButtons()
    try {
      showOutcome(await host.call(command))
    } finally {
      busy = false
      setButtons()
    }
    await refresh()
  }

  upBtn.addEventListener('click', () => void act('registry.up'))
  downBtn.addEventListener('click', () => void act('registry.down'))
  refreshBtn.addEventListener('click', () => void refresh())

  const timer = setInterval(() => {
    if (!disposed) void refresh()
  }, 10_000)
  void refresh()

  return {
    dispose(): void {
      disposed = true
      clearInterval(timer)
    },
  }
}
