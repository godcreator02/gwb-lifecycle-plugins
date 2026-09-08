/**
 * 「插件源」格子的身体。卡框（边框、标题行、占格）归 gwb-status 的格子墙，这里只画
 * 框内：跑没跑、地址、端口、pid，加 起/停/刷新 三个按钮和一条日志尾巴。
 *
 * **零依赖**（vanilla DOM + inline 样式）：这一份经 `gwb://` 被 status 的格子墙动态
 * import，不引 react 也就不用进 importmap；tsc 直出即是可用产物，没有打包器。
 */

interface CellArgs {
  host: { call: (command: string, args?: unknown) => Promise<unknown> }
  cell: { id: string; title: string; size: string; entryId: string; pkg: string }
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

export function mountCell(args: CellArgs, container: HTMLElement): { dispose: () => void } {
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

  // 日志尾巴
  const logPre = el(
    'pre',
    'margin:0;padding:8px;border:1px solid color-mix(in srgb, currentColor 18%, transparent);border-radius:6px;' +
      'font-size:11px;line-height:1.5;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;' +
      'opacity:.85;display:none;',
  )

  // 提示 / 报错一行（未配置、命令失败都走这儿）
  const note = el('div', 'font-size:12px;display:none;')

  root.append(stateLine, detail, buttons, note, logPre)
  container.append(root)

  let busy = false
  let disposed = false
  let showLog = false

  function setButtons(): void {
    const off = BTN + BTN_OFF
    upBtn.style.cssText = busy ? off : BTN
    downBtn.style.cssText = busy ? off : BTN
    refreshBtn.style.cssText = busy ? off : BTN
  }

  function render(status: StatusData): void {
    const color = status.running ? '#16a34a' : 'color-mix(in srgb, currentColor 35%, transparent)'
    dot.style.background = color
    stateText.textContent = status.running
      ? `跑着${status.adopted ? '（接管来的）' : ''}`
      : '停着'
    stateText.style.color = status.running ? '#16a34a' : 'inherit'

    detail.textContent = ''
    const port = portOfUrl(status.url)
    detail.append(
      el('span', '', `地址 ${status.url ?? '—'}`),
      el('span', '', `端口 ${port}`),
      el('span', '', `pid ${status.pid === null ? '—' : String(status.pid)}`),
    )
    if (!status.hasBin) detail.append(el('span', 'opacity:.7;', '目录里没有 verdaccio 本体'))
  }

  async function refresh(): Promise<void> {
    const reply = (await host.call('registry.status')) as unknown
    if (disposed || !isRecord(reply)) return
    if (reply.ok !== true) {
      const error = typeof reply.error === 'string' ? reply.error : '查状态没成'
      note.textContent = error
      note.style.color = '#dc2626'
      note.style.display = 'block'
      // 「未配置」只认配置缺失那一种错——宿主断了、命令超时之类的失败不冒充它
      if (error.includes('registry-dir')) {
        stateText.textContent = '未配置'
        dot.style.background = 'color-mix(in srgb, currentColor 30%, transparent)'
        detail.textContent = ''
      }
      return
    }
    note.style.display = 'none'
    if (isRecord(reply.data)) render(reply.data as unknown as StatusData)
  }

  async function refreshLog(): Promise<void> {
    if (!showLog) {
      logPre.style.display = 'none'
      return
    }
    logPre.style.display = 'block'
    logPre.textContent = '读日志…'
    const reply = (await host.call('registry.log', { lines: 100 })) as unknown
    if (disposed || !isRecord(reply) || !isRecord(reply.data)) return
    const text = reply.data.text
    logPre.textContent = typeof text === 'string' && text !== '' ? text : '（日志还没有内容——registry 从没起过，或没写过这一条）'
  }

  async function act(command: string): Promise<void> {
    if (busy) return
    busy = true
    setButtons()
    try {
      const reply = (await host.call(command)) as unknown
      if (isRecord(reply) && reply.ok === false) {
        note.textContent = typeof reply.error === 'string' ? reply.error : '命令没成'
        note.style.color = '#dc2626'
        note.style.display = 'block'
      } else {
        note.style.display = 'none'
      }
    } finally {
      busy = false
      setButtons()
    }
    await Promise.all([refresh(), refreshLog()])
  }

  upBtn.addEventListener('click', () => void act('registry.up'))
  downBtn.addEventListener('click', () => void act('registry.down'))
  logPre.addEventListener('dblclick', () => {
    showLog = false
    void refreshLog()
  })
  refreshBtn.addEventListener('click', () => {
    void refresh()
    void refreshLog()
  })
  // 日志默认收着，双击状态行展开——格子的高度不该被一个没人看的尾巴永久占着
  stateLine.addEventListener('dblclick', () => {
    showLog = !showLog
    void refreshLog()
  })
  stateLine.style.cursor = 'default'
  stateLine.title = '双击展开/收起日志'

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
