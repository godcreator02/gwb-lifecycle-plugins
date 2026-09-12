// 在真工作台的页面里动手：连 CDP，发真鼠标、真按键、截图、跑工作台命令，结果打成 JSON。
//
// 管什么：把「一个选择器」翻成「视口里的一个点」，检查那个点上最上面的确实是它，
// 然后让浏览器把事件派下去；外加几条不看界面、只问工作台的动作（cmd / reload / home）。
// 不知道什么：页面里有什么、点完该发生什么——那是调用方的事。
//
// **这支脚本是本件的身体，也是工作台起不来时的那条路**：零依赖、单文件、纯 JS，
// `node <devkit 包根>/bin/cdp.mjs <home 名> <动作>` 随时能跑。工作台跑着的时候走总线就够：
// `devkit.cdp {"args":["<home 名>","<动作>",…]}`（经 gwbNodeCli 登记，见本包 src/index.ts）。
// `devkit.dev` 那条链里，重挂、刷新、取证三步也是起它的子进程做的。
//
// **落点按工作目录算**，不按这个文件在哪算：截图落 `<cwd>/out/cdp/`，`eval` 那个文件
// 按 cwd 解相对路径。这支脚本住在 node_modules 里，拿它自己的位置去解，只会在别人的
// 依赖树里翻。量一张表的脚本落哪儿是调用方的纪律，一次性的就落 `out/`（那儿 gitignore
// 着，本来就是随时可以清空的地方）——提交进仓的那种会跟着界面一起变黄，而且不报错。
//
// 为什么不在页面里自己造事件（`el.dispatchEvent(new PointerEvent(…))`）：
// 造出来的事件**不做命中测试**，目标被浮层盖住照样打得中，而遮挡正是这套界面最容易出的错；
// 造出来的事件 `isTrusted` 是假的，按可信输入设防的地方行为两样。这儿发的是浏览器层的事件，
// 跟人的手一样，命中测试是浏览器自己做的。所以本件的价值不止「能点」，还在**点不着的时候
// 会告状**：把挡路的那个元素报出来。
//
// 用法：node <本文件> <home 名> <动作> [参数…]
//
// **第一个位置只收 home 名，不收端口**。口从那个 home 的 `runtime.json` 里查（内核开机写的
// 那份），连上之后还会问一句这张页自报的 home 名对不对得上——记录只说「它起的时候用的是这个
// 口」，不说「此刻这个口上还是它」。
// 端口是个没有语义的数，敲错一位就落在另一个现场，而那个现场会老老实实收下你发的事件。
//
//   eval   <文件> [JSON 参数]         在页面里跑一个函数：文件里写 `(args) => 一张表`
//   shot   [输出.png] [选择器]        截图；给选择器就裁到它
//   move   <点>                       悬停——这套界面一半东西是悬停才出现的
//   click  <点>                       命中检查过了才点
//   rclick <点>                       右键（块菜单挂在 contextmenu 上，左键点不出来）
//   drag   <点> <点>                  按下、分步移动、松开，一趟连接走完
//   type   <文本>                     往当前焦点插字
//   key    <键名>                     发一枚按键：Enter / Escape / Tab / Backspace / Delete / Arrow* / Home / End
//   scroll <点> [像素]                滚轮，正数往下，缺省 300
//   cmd    <命令名> [JSON 参数]        在页面里跑一条工作台命令，回执原样打出来；命令失败退出码非零
//   reload [选择器] [超时秒]           刷新这张页；给了选择器就等它出现再回（缺省等 20 秒）
//   home                             这张页的件是从哪个 home 装的（回绝对路径，devkit.dev 拿它当守卫）
//
// 「点」怎么写：`.bn-row` 纯选择器；`.bn-row@=观测独立性` 加「文字含这段」；
// `.bn-blk@=非独立观测 >> .bn-cbtn` 用 >> 先划范围再往里找；`520,400` 直接给视口坐标。
// 挑不出唯一一个的时候，候选的文字会一并报出来。
// 开关：`--target <子串>` 页面不止一个时按标题或地址挑；`--mod ctrl,shift` 带修饰键；
//       `--pad <像素>` 给 shot 的裁剪留边；`--size <宽>x<高>` 把视口当成这么大，扫容器查询的
//       断点用（会话级，必须跟动作同一句，见 override）；
//       `--timeout <秒>` 一条 CDP 消息等多久（cmd 缺省 900、reload 60、其余 15）。
//
// **只对隔离 home 用，绝不打 default。** 这儿发的是真操作，会真往库里写。
//
// 内核这样起（两个开关缺一不可）：
//
//   --remote-debugging-port=<端口> --disable-backgrounding-occluded-windows
//
// 前一个开门。**后一个是被真窗口撞出来的**：Chromium 在 Windows 上做遮挡检测，窗口被别的
// 窗口整个盖住就判定不可见、停止产帧，于是截图拿到陈旧帧、`requestAnimationFrame` 一次都不回。
// 关掉遮挡节流之后实测：另一扇最大化窗口压在上面、`document.hasFocus()` 为假，页面依旧
// `visible`，rAF 一毫秒就回。
//
// 所以前台与否：**发事件从来不需要**，事件走渲染进程，跟操作系统焦点无关，也不抢人的鼠标键盘；
// **看画面需要页面没被判定隐藏**，带上那个开关就够，不必真把窗口摆到最前。
// 最小化是另一回事，那个开关救不了，别最小化。
//
// **动词表是稳的那一半**：通用浏览器输入加几条工作台契约，一年也不该变一次。量什么跟着界面
// 走，所以量表的脚本一律外置成文件，由 `eval` 收路径——把它写进这儿，稳的那半就会跟着不稳的
// 那半一起动。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

const opts = {}
const rest = []
for (const arg of process.argv.slice(2)) {
  const named = /^--(target|mod|pad|size|timeout)=(.*)$/.exec(arg)
  if (named) opts[named[1]] = named[2]
  else if (/^--(target|mod|pad|size|timeout)$/.test(rest.at(-1) ?? '')) opts[rest.pop().slice(2)] = arg
  else rest.push(arg)
}
const [home, verb, ...args] = rest
if (!home || !verb) throw new Error('用法：node <本文件> <home 名> <动作> [参数…]，动作见文件头')

/**
 * 第一个位置是 **home 名，不是端口**（0.5.0 起）。口从那个 home 的 `runtime.json` 里查
 * （内核开机写的那份）。
 *
 * **端口不再收**：它是一个没有语义的数，敲错一位就落在另一个现场，而那个现场会老老实实
 * 收下你发的事件。名字有拼写、有记录、连上之后还能跟页面自报的名字对一次（见 `assertHome`），
 * 三样端口都没有。给了数字当场拒，不静默改道。
 *
 * home 根：Windows 是 `%APPDATA%\gwb-kernel\homes`。
 */
function portOf(name) {
  if (/^\d+$/.test(name)) {
    throw new Error(`第一个位置要 home 名，不是端口（给的是 ${name}）。哪个 home 在跑、口在哪，看 devkit.home.list`)
  }
  const root = process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'gwb-kernel', 'homes')
    : undefined
  if (root === undefined) throw new Error('认不出 home 根在哪——这支只在 Windows 上认得出 home 根')
  const file = path.join(root, name, 'runtime.json')
  if (!fs.existsSync(file)) throw new Error(`${file} 不在——${name} 没起过，或者起它的内核版本还不写这份记录。停掉重开一次`)
  let record
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file} 读不出来：${String(err)}`)
  }
  const cdp = record?.cdp
  if (!Number.isInteger(cdp) || cdp <= 0 || cdp >= 65536) {
    throw new Error(`${name} 的记录里没有 cdp 那格——起它的时候没带 --remote-debugging-port，够不着。停掉重开一次`)
  }
  return String(cdp)
}

const port = portOf(home)

/** CDP 的修饰键是位掩码，不是名字 */
const MOD_BIT = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const modifiers = (opts.mod ?? '')
  .split(',')
  .filter((name) => name !== '')
  .reduce((sum, name) => sum | (MOD_BIT[name.trim().toLowerCase()] ?? 0), 0)

const pad = Number(opts.pad ?? 0)
/**
 * 相对路径与截图落点按**工作目录**算，不按这个文件在哪算。这支脚本装在 home 的
 * `node_modules` 里，照文件位置解，解出来的是别人依赖树里的路径。
 */
const cwd = process.cwd()

/**
 * 一条 CDP 消息等多久。看门狗防的是**页面卡住**，不是「这条命令干的活久」——所以
 * `cmd` 那档给得很宽：工作台的一条命令可能在装依赖、在构建、在发版，十几秒回不来是常态，
 * 按 15 秒掐掉的话，掐的是一条正在干活的命令，而那头不会因此停下（回执从此没人接）。
 * 输入与求值那几档还是 15 秒：它们要么立刻回，要么就是页面真卡住了。`--timeout <秒>` 可改。
 */
const WATCHDOG_MS = Number(opts.timeout ?? (verb === 'cmd' ? 900 : verb === 'reload' ? 60 : 15)) * 1000

// ---------------------------------------------------------------------------
// 连上一个页面
// ---------------------------------------------------------------------------

/**
 * 能连的页面。devtools:// 是检查器自己那张页，不算。
 *
 * 连不上时**把原始错换成一句能读的话**：记录里那个口没人应答，压倒性的原因是那个 home
 * 已经退了而记录还留着（记录进程退了不删，这是故意的）。裸的 ECONNREFUSED 会让人去查网络。
 */
async function pagesOf() {
  let list
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch (err) {
    throw new Error(`连不上 ${home} 记录里那个调试口 ${port}：那儿没人应答——它多半已经退了（记录是上一次留下的）。停掉重开一次。原始错：${String(err)}`)
  }
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
}

const brief = (list) => list.map((t) => ({ title: t.title, url: t.url }))

/**
 * 连上唯一那个页面。**多于一个就报错，不猜**：一个 Electron 应用可以开好几个窗口，
 * 猜错了就是对着另一扇窗点，而且看不出来。
 */
async function connect() {
  const all = await pagesOf()
  const want = opts.target
  const hit = want === undefined ? all : all.filter((t) => `${t.title} ${t.url}`.includes(want))
  if (hit.length === 0) throw new Error(`没有匹配的页面。现有：${JSON.stringify(brief(all), null, 2)}`)
  if (hit.length > 1) throw new Error(`匹配到 ${hit.length} 个页面，用 --target 挑一个：${JSON.stringify(brief(hit), null, 2)}`)

  const ws = new WebSocket(hit[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`连不上 ${hit[0].webSocketDebuggerUrl}`))
  })

  // 一趟连接要发好几条，回执按 id 认领；没人等的是事件通知，丢掉
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    const claim = waiting.get(msg.id)
    if (claim === undefined) return
    waiting.delete(msg.id)
    claim(msg)
  }
  let seq = 0
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = (seq += 1)
      // 每条都带看门狗：页面挂住的时候要拿到一句能读的话，不是无限期地停在那儿
      const bark = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`${method} 等了 ${WATCHDOG_MS / 1000} 秒没回。页面可能卡住了，或者被遮住停止产帧了`))
      }, WATCHDOG_MS)
      waiting.set(id, (msg) => {
        clearTimeout(bark)
        if (msg.error) reject(new Error(`${method}：${msg.error.message}`))
        else resolve(msg.result)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  return { ws, send, page: hit[0] }
}

/** 在页面里求值，页面抛的异常照抛出来，不要装作成功 */
async function evaluate(send, expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (out.exceptionDetails) {
    throw new Error(`页面里抛了：${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`)
  }
  return out.result?.value
}

/**
 * 等两帧，让悬停样式与重排落地再看、再点。
 *
 * **必须带兜底**：窗口被别的窗口整个盖住时，Chromium 判定它不可见就停止产帧，
 * `requestAnimationFrame` 从此一次都不回。没有兜底的话工具就永远停在「等下一帧」上，
 * 而且看不出是为什么。这个坑是拿真窗口撞出来的。
 */
const settle = (send) =>
  evaluate(send, `Promise.race([
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done('frame')))),
    new Promise((done) => setTimeout(() => done('no-frame'), 400)),
  ])`)

/**
 * 页面看不看得见。看不见的时候截图拿到的是陈旧帧甚至空白，动画也不跑。
 *
 * 输入不受影响——发事件走的是渲染进程，跟操作系统的焦点无关，窗口压在底下照样收。
 * 所以只有要看画面的时候才把窗口抬起来，别的动作只如实报一句，不去抢人的焦点。
 */
async function visibility(send, raise) {
  const before = await evaluate(send, 'document.visibilityState')
  if (before === 'visible') return { visible: true }
  if (!raise) return { visible: false, note: '页面被遮住了：截图会是陈旧帧，动画不跑。输入不受影响' }
  await send('Page.bringToFront')
  const after = await evaluate(send, 'document.visibilityState')
  return { visible: after === 'visible', raised: true, note: after === 'visible' ? '窗口被抬到前面了' : '抬了也没抬起来' }
}

// ---------------------------------------------------------------------------
// 选择器 → 一个点（外加命中检查）
// ---------------------------------------------------------------------------

/**
 * 这段字符串是要送进页面里跑的，所以只能用页面认得的东西。
 *
 * 回的形状固定：`ok` 说这个点打不打得中目标，`x`/`y` 只要**算得出来**就给（哪怕被盖住），
 * 因为滚轮这类动作本来就该落在最上面那个元素上，不需要打中目标。打不中时把挡路的那条
 * 祖先链和目标的 `pointer-events` 一起报出来——这两样合起来基本就说清了为什么点不着。
 */
const probeExpr = (steps) => `(() => {
  const brief = (n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) || '(没字)';
  const name = (n) => n.tagName.toLowerCase()
    + (n.id ? '#' + n.id : '')
    + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).join('.') : '');

  // 一步步往里收：每一步都必须收敛到唯一一个，收不敛就把候选的字报出来
  let root = document;
  let el = null;
  for (const step of ${JSON.stringify(steps)}) {
    const pool = [...root.querySelectorAll(step.css)];
    let all = step.text === null ? pool : pool.filter((n) => (n.textContent || '').includes(step.text));
    // 块是嵌套的，父块的文字里必然含着子块的文字。同时命中祖孙时留最里面那个——
    // 人指着屏幕说「这一块」，指的从来是最贴着字的那一层
    if (all.length > 1) all = all.filter((n) => !all.some((other) => other !== n && n.contains(other)));
    const at = step.css + (step.text === null ? '' : '@=' + step.text);
    if (all.length === 0) return { ok: false, why: '「' + at + '」没选中任何元素', candidates: pool.slice(0, 8).map(brief) };
    if (all.length > 1) return { ok: false, why: '「' + at + '」选中 ' + all.length + ' 个，说具体点', candidates: all.slice(0, 8).map(brief) };
    el = all[0];
    root = el;
  }

  const r = el.getBoundingClientRect();
  const box = { x: r.left, y: r.top, width: r.width, height: r.height };
  if (r.width === 0 || r.height === 0) return { ok: false, why: '量出来是零尺寸：没渲染，或者被折叠了', box };
  if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) {
    return { ok: false, why: '不在视口里，先 scroll 过去', box };
  }
  const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1));
  const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
  // 留边不能把左上角推成负数：负的裁剪框 Chrome 认不了，会**默默退回从原点截**，
  // 图能出来、内容全错，最难发现的那一种。所以在这儿就夹住
  const px = Math.max(0, r.left + scrollX - ${pad});
  const py = Math.max(0, r.top + scrollY - ${pad});
  const clip = { x: px, y: py, width: r.right + scrollX + ${pad} - px, height: r.bottom + scrollY + ${pad} - py };
  const top = document.elementFromPoint(x, y);
  if (top === null) return { ok: false, why: '那个点上什么都没有', x, y, box, clip };
  if (top !== el && !el.contains(top)) {
    const chain = [];
    for (let n = top; n !== null && chain.length < 4; n = n.parentElement) chain.push(name(n));
    return {
      ok: false,
      why: '这个点打不到目标，被别的东西接管了',
      blocker: chain.join(' < '),
      pointerEvents: getComputedStyle(el).pointerEvents,
      x, y, box, clip,
    };
  }
  return { ok: true, x, y, box, clip, hit: name(top) };
})()`

/**
 * 「点」怎么写：
 *   `.bn-row`                     纯选择器
 *   `.bn-row@=观测独立性`           选择器 + 含这段文字的那一个。界面里大量元素没有自己的
 *                                 选择器，按文字挑才是人看着屏幕会做的事
 *   `.bn-blk@=非独立观测 >> .bn-cbtn` 先收到写着那句话的块，再在它**里面**找按钮。同名按钮
 *                                 一屏十几个，只有先划定范围才说得清是哪一个
 *   `520,400`                     直接给视口坐标
 * 任何一步收不敛，候选的文字都会一并报出来，省得再跑一趟去看有哪些。
 */
async function pointOf(send, arg) {
  const literal = /^(-?\d+),(-?\d+)$/.exec(arg ?? '')
  if (literal) return { ok: true, x: Number(literal[1]), y: Number(literal[2]), literal: true }
  if (arg === undefined) throw new Error('这个动作要一个点：选择器、选择器@=文字、用 >> 逐层收窄，或者 x,y')
  const steps = arg.split('>>').map((part) => {
    const one = part.trim()
    const cut = one.indexOf('@=')
    const css = (cut < 0 ? one : one.slice(0, cut)).trim()
    return { css: css === '' ? '*' : css, text: cut < 0 ? null : one.slice(cut + 2).trim() }
  })
  return await evaluate(send, probeExpr(steps))
}

// ---------------------------------------------------------------------------
// 发事件
// ---------------------------------------------------------------------------

const mouse = (send, type, x, y, more = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, clickCount: 0, modifiers, ...more })

/** 按键表：CDP 要的是虚拟键码，不是 `KeyboardEvent.keyCode` 那套的名字 */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
}

async function press(send, name) {
  const k = KEYS[name]
  if (k === undefined) throw new Error(`不认得这枚键：${name}。认得的：${Object.keys(KEYS).join(' / ')}`)
  const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }
  // 有 text 的走 keyDown（浏览器据此插字），没有的走 rawKeyDown（纯控制键）
  await send('Input.dispatchKeyEvent', k.text === undefined
    ? { type: 'rawKeyDown', ...common }
    : { type: 'keyDown', ...common, text: k.text, unmodifiedText: k.text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/** 截图落盘。默认落 out/cdp/，那儿 gitignore 着 */
function shotPath(given) {
  if (given !== undefined && given.toLowerCase().endsWith('.png')) return path.resolve(given)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return path.join(cwd, 'out', 'cdp', `shot-${stamp}.png`)
}

// ---------------------------------------------------------------------------
// 在页面里跑一个文件
// ---------------------------------------------------------------------------

/**
 * `eval <文件> [JSON 参数]` 的那段表达式。
 *
 * **文件里一律是一个函数表达式**：`(args) => 一张表`，想 await 就写成 async，求值这头
 * 等得住。不给参数就按空对象调。只有这一条规则——「是函数就调、不是就直接求值」是两条
 * 规则伪装成一条，而选错分支的那次不报错，只是回一个看不懂的值。
 *
 * **量什么不住这个文件**：界面改一版就要添一段、改一段，而这支脚本管的是「怎么把事件
 * 发进页面」，那件事一年也不该变一次。混在一起，稳的那半会跟着不稳的那半一起动。
 * 文件落哪儿是调用方的纪律：一次性的落 `out/`（gitignore 着），那儿本来就随时可以清空。
 */
function callExpressionOf(file, rawArgs) {
  const target = path.resolve(cwd, file)
  if (!fs.existsSync(target)) {
    throw new Error(`${target} 不在——eval 收的是一个文件路径（相对路径按当前工作目录算）`)
  }
  let args = {}
  if (rawArgs !== undefined) {
    try {
      args = JSON.parse(rawArgs)
    } catch {
      throw new Error(`参数要是一段 JSON，收到的是：${rawArgs}`)
    }
  }
  return `(${fs.readFileSync(target, 'utf8')})(${JSON.stringify(args)})`
}

/**
 * 这张页的件是从哪个 home 装的。
 *
 * 页面上那些 `file://` 地址里带着 home 的绝对路径（外壳注的样式表、共享 React 的
 * importmap 都是），所以**不用配置、不用猜**：问一趟正在跑的那张页就知道了。
 * `devkit.dev` 的守卫靠这一条定位，人也能拿它核对「我改的到底是不是这一个 home」。
 */
const HOME_EXPR = `(() => {
  const urls = [];
  for (const el of document.querySelectorAll('script[src], link[href]')) urls.push(el.src || el.href);
  for (const el of document.querySelectorAll('script[type="importmap"]')) {
    for (const m of (el.textContent || '').matchAll(/file:\\/\\/\\/[^"]+/g)) urls.push(m[0]);
  }
  return urls.filter((u) => typeof u === 'string' && u.startsWith('file:///'));
})()`

/** 一串 `file://` 地址 → home 的绝对路径。找不到就说找不到，不猜 */
function homeOf(urls) {
  const hits = new Map()
  for (const url of urls) {
    const cut = /^(file:\/\/\/.*?\/homes\/[^/]+)\//.exec(url)
    if (cut === null) continue
    const dir = fileURLToPath(cut[1])
    hits.set(dir, (hits.get(dir) ?? 0) + 1)
  }
  if (hits.size === 0) return { home: null, why: '页面上没有一条带 /homes/ 的 file:// 地址：它可能不是工作台的外壳页，或者这个 home 的件是别的装法' }
  if (hits.size > 1) return { home: null, why: '页面上出现了不止一个 home，不猜', 候选: [...hits.keys()] }
  const home = [...hits.keys()][0]
  return { home, 名字: path.basename(home), 凭据数: hits.get(home) }
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/**
 * `--size 宽x高`：把视口当成这么大，用来扫容器查询的断点。
 *
 * 改的是**视口**不是操作系统的窗口。`Browser` 那个域是浏览器级的，页面这条会话里没有；
 * 而 Electron 的窗口本来也不是 Chrome 的窗口，不值得去赌它认不认。断点问的本来就是
 * 「一格有多宽时怎么排」，覆盖视口问的是同一件事，样式引擎干的活一模一样。
 *
 * **它必须是开关，不能是动词**：这个覆盖是**会话级**的，连接一断就没了。鼠标位置、
 * 滚动位置这些住在页面里，跨连接留得住；这一个不留。所以它得跟真正要干的那件事同一趟
 * 连接里发——`shot --size 900x800` 是一句话，先 size 再 shot 是两句空话。
 *
 * **页面没在产帧的时候它是假的**，这儿会报一句。改视口只动 `innerWidth`；窗格的宽是
 * 外壳用 JS 排出来的，要等 `ResizeObserver` 与一次重排才跟着变，而那两样都骑在帧上。
 * 窗口被遮住或最小化时一帧都不产，于是 `innerWidth` 变了、窗格宽一个像素没动——量出来
 * 是**旧布局配新视口**，比量不到更糟，因为它看起来像个正经的数。撞到过一次：视口压到
 * 380，窗格照旧 2293。要扫断点，先让窗口露出来。
 */
async function override(send) {
  if (opts.size === undefined) return {}
  if (opts.size === 'off') {
    await send('Emulation.clearDeviceMetricsOverride')
    return { viewport: '撤了' }
  }
  const wh = /^(\d+)x(\d+)$/.exec(opts.size)
  if (!wh) throw new Error('--size 要写成 <宽>x<高>（例如 1085x900），或者 off 撤掉卡住的覆盖')
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(wh[1]),
    height: Number(wh[2]),
    deviceScaleFactor: 0, // 0 = 跟着这台机器真实的缩放，别把字的密度也一起改了
    mobile: false,
  })
  await settle(send)
  const seen = await evaluate(send, '[innerWidth, innerHeight, document.visibilityState]')
  const out = { viewport: [seen[0], seen[1]] }
  if (seen[2] !== 'visible') out.视口这一档不作数 = '页面不可见（窗口被遮住或最小化），外壳不会重排，量到的是旧布局配新视口。先把窗口露出来'
  return out
}

/** 点不着就停下，别把「没打中」当成「点过了」 */
function insist(spot) {
  if (spot.ok) return spot
  process.exitCode = 1
  console.log(JSON.stringify(spot, null, 2))
  process.exit(1)
}

async function run(send, target) {
  switch (verb) {
    case 'eval': {
      if (args[0] === undefined) throw new Error('eval 要一个文件路径，文件里写 `(args) => 一张表`')
      return { did: 'eval', 文件: path.resolve(cwd, args[0]), 表: await evaluate(send, callExpressionOf(args[0], args[1])) }
    }

    case 'move': {
      const spot = insist(await pointOf(send, args[0]))
      await mouse(send, 'mouseMoved', spot.x, spot.y)
      await settle(send)
      return { did: 'move', ...spot }
    }

    case 'click': {
      const spot = insist(await pointOf(send, args[0]))
      // 先移过去再按：悬停才出现的东西，得让它先出来
      await mouse(send, 'mouseMoved', spot.x, spot.y)
      await settle(send)
      await mouse(send, 'mousePressed', spot.x, spot.y, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse(send, 'mouseReleased', spot.x, spot.y, { button: 'left', buttons: 0, clickCount: 1 })
      await settle(send)
      return { did: 'click', ...spot }
    }

    // 右键：这套界面的块菜单挂在 contextmenu 上，左键点不出来。
    // 派的是真右键，浏览器自己合成 contextmenu 事件——跟人按右键走的是同一条路。
    case 'rclick': {
      const spot = insist(await pointOf(send, args[0]))
      await mouse(send, 'mouseMoved', spot.x, spot.y)
      await settle(send)
      await mouse(send, 'mousePressed', spot.x, spot.y, { button: 'right', buttons: 2, clickCount: 1 })
      await mouse(send, 'mouseReleased', spot.x, spot.y, { button: 'right', buttons: 0, clickCount: 1 })
      await settle(send)
      return { did: 'rclick', ...spot }
    }

    case 'drag': {
      const from = insist(await pointOf(send, args[0]))
      const to = insist(await pointOf(send, args[1]))
      await mouse(send, 'mouseMoved', from.x, from.y)
      await mouse(send, 'mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 })
      // 分步走：一步到位的拖拽很多实现认不出来，中间那几帧才是它判方向的依据
      const steps = 12
      for (let i = 1; i <= steps; i += 1) {
        const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
        const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
        await mouse(send, 'mouseMoved', x, y, { button: 'left', buttons: 1 })
      }
      await mouse(send, 'mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 })
      await settle(send)
      return { did: 'drag', from, to }
    }

    case 'scroll': {
      // 滚轮不做命中检查：滚的本来就该是最上面那个元素，被盖住不是错
      const spot = await pointOf(send, args[0])
      if (spot.x === undefined) insist(spot)
      const delta = Number(args[1] ?? 300)
      await mouse(send, 'mouseWheel', spot.x, spot.y, { deltaX: 0, deltaY: delta })
      await settle(send)
      return { did: 'scroll', delta, x: spot.x, y: spot.y }
    }

    case 'type': {
      if (args[0] === undefined) throw new Error('type 要一段文本')
      await send('Input.insertText', { text: args[0] })
      await settle(send)
      return { did: 'type', text: args[0] }
    }

    case 'key': {
      await press(send, args[0])
      await settle(send)
      return { did: 'key', key: args[0] }
    }

    /*
     * 在页面里跑一条工作台命令。外壳把 `window.gwb.command(名, 参数)` 开给页面，件的
     * 浏览器半用的就是这一条；从命令行够到它，等于**不经界面也能读写这个 home**——
     * 铺数据、查状态、事后核对，都不用先在界面上点半天。
     *
     * 命令失败（不存在、参数不对）回的是 `{ ok: false }` 那张信封，不是抛异常。这儿把
     * 退出码置成非零：串在脚本里的时候，「命令没跑成」必须让调用方看得见。
     */
    case 'cmd': {
      if (args[0] === undefined) throw new Error('cmd 要一个命令名，后面可以跟一段 JSON 当参数')
      let payload
      if (args[1] !== undefined) {
        try {
          payload = JSON.parse(args[1])
        } catch {
          throw new Error(`命令参数要是一段 JSON，收到的是：${args[1]}`)
        }
      }
      const call = `window.gwb.command(${JSON.stringify(args[0])}${payload === undefined ? '' : `, ${JSON.stringify(payload)}`})`
      const reply = await evaluate(send, `typeof window.gwb?.command === 'function'
        ? ${call}
        : { ok: false, error: '这张页上没有 window.gwb.command：它不是工作台的外壳页' }`)
      if (reply?.ok !== true) process.exitCode = 1
      return { did: 'cmd', 命令: args[0], 回执: reply }
    }

    /*
     * 刷新，然后等页面真的回来。
     *
     * **必须等**：刷新途中执行上下文被销毁，那几百毫秒里求值一律抛；不等就接着量的话，
     * 量到的要么是异常，要么是上一版的画面。等什么由调用方说了算——给个选择器，等它出现
     * （`.bn-app` 就是「块笔记那一格挂好了」）；不给就只等 `readyState`。
     *
     * 浏览器那半的快循环就靠这一条：件的 dist 换了之后刷新一下，外壳会重新按 `file://`
     * 地址取那份 client 与样式表。**node 那半（cordis 里已经挂着的模块）刷新不掉**，
     * 改了命令、引擎、窗格注册那些，得重起工作台。
     */
    case 'reload': {
      await send('Page.enable')
      await send('Page.reload', { ignoreCache: true })
      const wait = args[0]
      const deadline = Date.now() + Number(args[1] ?? 20) * 1000
      const check = `({ ready: document.readyState, 出来了: ${wait === undefined ? 'true' : `document.querySelector(${JSON.stringify(wait)}) !== null`} })`
      let last = null
      for (;;) {
        await new Promise((done) => setTimeout(done, 200))
        try {
          last = await evaluate(send, check)
        } catch {
          last = null // 刷新途中上下文没了，再等一轮
        }
        if (last?.ready === 'complete' && last.出来了 === true) break
        if (Date.now() > deadline) {
          process.exitCode = 1
          return { did: 'reload', 等到了: false, 等的是: wait ?? 'readyState', 最后看到: last }
        }
      }
      await settle(send)
      return { did: 'reload', 等到了: true, 等的是: wait ?? 'readyState' }
    }

    /*
     * 这张页的件是从哪个 home 装的。**连上就已经核对过了**（见 assertHome），所以这一条
     * 回的不是「对不对得上」，是那个 home 的**绝对路径**：`devkit.dev` 拿它挡住 default
     * 与本件自己住的那个 home。
     */
    case 'home':
      return { did: 'home', ...homeOf(await evaluate(send, HOME_EXPR)) }

    case 'shot': {
      await send('Page.enable')
      // 只有截图这一件真的要画面，所以只有它去抬窗口
      const seen = await visibility(send, true)
      const file = shotPath(args[0])
      const sel = args[0] !== undefined && !args[0].toLowerCase().endsWith('.png') ? args[0] : args[1]
      /*
       * 裁剪只要那个盒子，**不要命中检查**。命中检查是给点击用的：要点中一个东西，它得
       * 真的在那个点的最上面。裁图不点任何东西——一段长正文的中心点落在状态栏上是常态
       * （元素比视口高，中心自然在视口外，夹回来就夹到了别的东西身上），那跟能不能截它
       * 毫无关系。所以这儿只坚持「算得出盒子」，算不出才停。
       */
      const spot = sel === undefined ? undefined : await pointOf(send, sel)
      if (spot !== undefined && spot.clip === undefined) insist(spot)
      const clip = spot === undefined ? undefined : { ...spot.clip, scale: 1 }
      /*
       * captureBeyondViewport 让裁剪框可以伸到折叠线以下，不然长元素只截得到露出来的那截。
       *
       * **对长正文它只能给你一段空白**：正文是可视区渲染的，屏外的行根本没有元素，伸下去
       * 截到的是真的什么都没有。所以整页长图这条路在这套界面上不成立——要看下面，滚过去
       * 再截一张。
       */
      const out = await send('Page.captureScreenshot',
        clip === undefined ? { format: 'png' } : { format: 'png', clip, captureBeyondViewport: true })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(out.data, 'base64'))
      return { did: 'shot', file, clip: clip ?? '整个视口', ...seen }
    }

    default:
      throw new Error(`不认得这个动作：${verb}。动作表见文件头`)
  }
}

/**
 * 连上之后，问一句这张页属于哪个 home，跟你要的那个对不上就停。
 *
 * **记录只说「它起的时候用的是这个口」**，不说「此刻这个口上还是它」：进程可能已经退了、
 * 端口被下一个进程占走，而记录还躺在那儿指着那个数。名字是唯一的地址之后，这道核对就是
 * 「地址对不对」的最后一关——少了它，名字给的是一种假的安全感。
 *
 * 拿不出 home 的页也停：那说明这个口后头根本不是工作台的外壳页。
 */
async function assertHome(send) {
  const found = homeOf(await evaluate(send, HOME_EXPR))
  if (found.home === null) {
    throw new Error(`这个口后头不是工作台的外壳页（${found.why}）——记录陈旧了，或者那扇窗已经不在`)
  }
  if (found.名字 !== home) {
    throw new Error(`你要的是 ${home}，可这个口上的页面自报是 ${found.名字}——记录陈旧了。停掉重开那个 home`)
  }
}

// ---------------------------------------------------------------------------

{
  const { ws, send, page } = await connect()
  try {
    await assertHome(send)
    const viewport = await override(send)
    console.log(JSON.stringify({ page: page.title, 在哪个home: home, ...viewport, ...(await run(send, page)) }, null, 2))
  } finally {
    /*
     * 视口覆盖**必须自己撤**。它不像鼠标位置那样只是页面里的一点状态：断开连接不一定还原，
     * 页面就那么卡在那个尺寸上，界面缩在窗口一角，下一个来看这扇窗的人只会觉得程序坏了。
     * 这一条是把人的窗口弄坏一次之后加的。撤不掉也不能盖住本来要报的错，所以吞掉。
     */
    if (opts.size !== undefined && opts.size !== 'off') {
      try {
        await send('Emulation.clearDeviceMetricsOverride')
      } catch {
        /* 连接已经断了就算了，下一趟 `--size off` 也能收 */
      }
    }
    ws.close()
  }
}
