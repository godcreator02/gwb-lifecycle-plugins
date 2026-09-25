// 在真实工作台的页面里操作：连 CDP，发真实的鼠标与按键、截图、执行工作台命令，结果打印成 JSON。
// 零依赖、单文件、纯 JS：工作台启动不了时也能直接 `node <devkit 包根>/bin/cdp.mjs <home 名> <动作>`；
// 工作台运行时经命令总线调 `devkit.cdp {"args":["<home 名>","<动作>",…]}`（经 gwbNodeCli 登记，见 src/index.ts）。
//
// 路径一概不看工作目录：截图缺省存到被截的那个 home 自己的 `<home>\out\cdp\`，要存别处给绝对路径；
// `eval` 的文件只收绝对路径。写磁盘的位置不许在本包目录与任何 `node_modules` 里。
//
// 用法：node <本文件> <home 名> <动作> [参数…]
//
// 第一个位置只收 home 名，不收端口：端口从那个 home 的 `runtime.json` 里查，连上之后还核对页面自报的 home 名。
//
//   eval   <文件> [JSON 参数]         在页面里执行一个函数：文件里写 `(args) => 一张表`；文件只收绝对路径
//   shot   [输出.png] [选择器]        截图；给选择器就裁到它。缺省存到 `<home>\out\cdp\`，给输出就给绝对路径
//   move   <点>                       悬停：这套界面一半东西是悬停才出现的
//   click  <点>                       命中检查过了才点
//   rclick <点>                       右键（块菜单在 contextmenu 上，左键点不出来）
//   drag   <点> <点>                  按下、分步移动、松开，一次连接做完
//   type   <文本>                     往当前焦点插入文字
//   key    <键名>                     发一个按键：Enter / Escape / Tab / Backspace / Delete / Arrow* / Home / End
//   scroll <点> [像素]                滚轮，正数往下，缺省 300
//   cmd    <命令名> [JSON 参数]        在页面里执行一条工作台命令，回执原样打印；命令失败退出码非零
//   reload [选择器] [超时秒]           刷新这个页面；给了选择器就等它出现再回（缺省等 20 秒）
//   home                             这个页面的插件是从哪个 home 装的（回绝对路径，devkit.dev 用它检查目标）
//
// 「点」怎么写：`.bn-row` 纯选择器；`.bn-row@=观测独立性` 加「文字含这段」；
// `.bn-blk@=非独立观测 >> .bn-cbtn` 用 >> 先划范围再往里找；`520,400` 直接给视口坐标。
// 选不出唯一一个时，候选的文字会一并报出来。
// 开关：`--target <子串>` 页面不止一个时按标题或地址挑；`--mod ctrl,shift` 带修饰键；
//       `--pad <像素>` 给 shot 的裁剪留边；`--size <宽>x<高>` 把视口当成这么大，查容器查询的
//       断点用（只对这次连接生效，必须跟动作写在同一次调用里，见 override）；
//       `--timeout <秒>` 一条 CDP 消息等多久（cmd 缺省 900、reload 60、其余 15）。
//
// default 上只许只读动作（shot / home），别的动作与 `--size` 在分发之前就拒：这里发的是真实操作，会真的写数据。
// 动作分类见 READ_ONLY_VERBS / WRITE_VERBS，加动作必须登记进其中一张。
//
// 内核要这样启动（两个开关缺一不可）：
//
//   --remote-debugging-port=<端口> --disable-backgrounding-occluded-windows
//
// 后一个关掉遮挡降频：窗口被别的窗口完全挡住时 Chromium 停止出新帧，截图拿到旧画面、`requestAnimationFrame` 不回调。
// 发事件不需要窗口在前台（事件走渲染进程，跟系统焦点无关）；看画面需要页面没被判定为隐藏，带上那个开关就够。
// 最小化这个开关管不了，别最小化。

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

// ---------------------------------------------------------------------------
// 写磁盘的位置：一概不看工作目录（这一段是纯函数，单测直接 import）
// ---------------------------------------------------------------------------

/** 本包的根（`bin/` 的上一层）。写磁盘的位置不许在它里面 */
export const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * home 根 `%APPDATA%\gwb-kernel\homes`，与内核 `main.ts` 里 `GWB_HOME` 是名字时的算法相同（Electron 的
 * `app.getPath('appData')` 在 Windows 上就是 `%APPDATA%`）。只支持 Windows：开发套件找 pnpm、查进程也都只支持 Windows
 */
export function homesRootOf(env = process.env, platform = process.platform) {
  if (platform !== 'win32') throw new Error(`开发套件只支持 Windows，当前平台是 ${platform}——home 根算不出来`)
  if (!env.APPDATA) throw new Error('环境变量 APPDATA 没有设置——home 根在 %APPDATA%\\gwb-kernel\\homes，没有它算不出来')
  return path.join(env.APPDATA, 'gwb-kernel', 'homes')
}

/** home 名 → 那个 home 的目录。`root` 是 `homesRootOf()` 的结果 */
export function homeDirOf(name, root) {
  return path.join(root, name)
}

/** Windows 上 `\foo` 也算 isAbsolute，可它指向进程当前所在的盘，所以那边要带盘符或是 UNC */
export function isFullPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false
  return process.platform !== 'win32' || /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/.test(p)
}

/** 完整的绝对路径、不在本包目录里、不在任何 `node_modules` 里；过不了就抛，回规整过的路径 */
export function assertWritable(file, pkgRoot = PACKAGE_ROOT) {
  if (!isFullPath(file)) throw new Error(`落点 ${file} 不是完整的绝对路径——这支脚本不看工作目录，相对路径没有「相对于谁」`)
  const normalized = path.normalize(file)
  const relativeToPackage = path.relative(pkgRoot, normalized)
  if (relativeToPackage === '' || (relativeToPackage !== '..' && !relativeToPackage.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToPackage))) {
    throw new Error(`落点 ${normalized} 在 devkit 包目录 ${pkgRoot} 里——那是装好的包，写进去弄脏它、升级之后也找不回来`)
  }
  if (normalized.split(/[\\/]/).some((seg) => seg.toLowerCase() === 'node_modules')) {
    throw new Error(`落点 ${normalized} 在 node_modules 里——那是装好的依赖树，不是放产物的地方`)
  }
  return normalized
}

/** `shot` 的两个位置参数：第一个以 .png 结尾就是输出路径、后面跟选择器；否则它就是选择器 */
export function shotArgsOf(list) {
  const firstIsOutput = list[0] !== undefined && list[0].toLowerCase().endsWith('.png')
  return { given: firstIsOutput ? list[0] : undefined, sel: firstIsOutput ? list[1] : list[0] }
}

/** 缺省存到 `<home>\out\cdp\shot-<时刻>.png`；给了输出就只收完整的绝对路径。两种都过 `assertWritable` */
export function shotFileOf(given, homeDir, now = new Date(), pkgRoot = PACKAGE_ROOT) {
  if (given === undefined) {
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return assertWritable(path.join(homeDir, 'out', 'cdp', `shot-${stamp}.png`), pkgRoot)
  }
  if (!isFullPath(given)) {
    throw new Error(`shot 的输出只收绝对路径，给的是 ${given}。不给就落这个 home 自己的 ${path.join(homeDir, 'out', 'cdp')}`)
  }
  return assertWritable(given, pkgRoot)
}

/** `eval` 的文件：只收完整的绝对路径，回规整过的路径 */
export function evalFileOf(given) {
  if (given === undefined) throw new Error('eval 要一个文件的绝对路径，文件里写 `(args) => 一张表`')
  if (!isFullPath(given)) {
    throw new Error(
      `eval 的文件只收绝对路径，给的是 ${given}。这支脚本不看工作目录：走总线时那是 devkit 包自己的目录，` +
        '直接 node 跑时是 shell 的，同一个相对路径两条路指两样东西。PowerShell 里 (Resolve-Path <文件>).Path 拿绝对路径',
    )
  }
  return path.normalize(given)
}

// ---------------------------------------------------------------------------
// 找到那个 home
// ---------------------------------------------------------------------------

/** 端口从 `<dir>/runtime.json` 的 `cdp` 字段查；给的不是 home 名（比如一个端口号），这里找不到那个 home 的记录就停 */
function portOf(name, dir) {
  const file = path.join(dir, 'runtime.json')
  if (!fs.existsSync(file)) throw new Error(`${file} 不在——${name} 没启动过。用 devkit.home.open 启动它`)
  let record
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file} 读不出来：${String(err)}`)
  }
  const cdp = record?.cdp
  if (!Number.isInteger(cdp) || cdp <= 0 || cdp >= 65536) {
    throw new Error(`${name} 的记录里没有 cdp 字段——启动它的时候没带 --remote-debugging-port，连不上。停掉重开一次`)
  }
  return String(cdp)
}

/** 目标 home 的目录与调试端口。直接运行时才填（见文件末尾），被 import 时一直是 undefined */
let homeDir
let port

/** CDP 的修饰键是位掩码，不是名字 */
const MOD_BIT = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/** `--mod ctrl,shift` → 位掩码。写错的键名直接拒：当它没写，发出去的就是一个少了修饰键的真操作 */
export function modifiersOf(spec) {
  let sum = 0
  for (const raw of (spec ?? '').split(',')) {
    const name = raw.trim().toLowerCase()
    if (name === '') continue
    const bit = MOD_BIT[name]
    if (bit === undefined) throw new Error(`--mod 里的 ${raw.trim()} 不认得，只认 ${Object.keys(MOD_BIT).join('、')}`)
    sum |= bit
  }
  return sum
}

/** 直接运行时才算（见文件末尾）：被 import 时 argv 不是给这支脚本的 */
let modifiers = 0

const pad = Number(opts.pad ?? 0)

/** 一条 CDP 消息等多久。防的是页面卡住，不是命令做的事久：`cmd` 可能在装依赖、在构建，所以给得宽 */
const WATCHDOG_MS = Number(opts.timeout ?? (verb === 'cmd' ? 900 : verb === 'reload' ? 60 : 15)) * 1000

// ---------------------------------------------------------------------------
// 连上一个页面
// ---------------------------------------------------------------------------

/** devtools:// 是检查器自己的页面，不算。连不上时换成一句能读的话：多半是那个 home 已经退出、记录还留着 */
async function pagesOf() {
  let list
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch (err) {
    throw new Error(`连不上 ${home} 记录里那个调试端口 ${port}：那里没有应答——它多半已经退出了（记录是上一次留下的）。停掉重开一次。原始错：${String(err)}`)
  }
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
}

const brief = (list) => list.map((t) => ({ title: t.title, url: t.url }))

/** 只连唯一的那个页面，多于一个就报错、不猜：猜错了就是对着另一个窗口操作，而且看不出来 */
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

  // 一次连接发好几条，回执按 id 对上；没人等的是事件通知，丢掉
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
      // 每条都带超时：页面卡住时要拿到一句能读的话，而不是一直停在那里
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

/** 在页面里求值，页面抛的异常照样抛出来 */
async function evaluate(send, expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (out.exceptionDetails) {
    throw new Error(`页面里抛了：${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`)
  }
  return out.result?.value
}

/** 等两帧，让悬停样式与重排生效。必须带超时：窗口被完全挡住时 Chromium 停止出新帧，rAF 一次都不回调 */
const settle = (send) =>
  evaluate(send, `Promise.race([
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done('frame')))),
    new Promise((done) => setTimeout(() => done('no-frame'), 400)),
  ])`)

/** 看不见时截图是旧画面、动画不跑；输入不受影响，所以只有截图（要看画面）才调它把窗口提到前面 */
async function raiseForScreenshot(send) {
  const before = await evaluate(send, 'document.visibilityState')
  if (before === 'visible') return { visible: true }
  await send('Page.bringToFront')
  const after = await evaluate(send, 'document.visibilityState')
  return { visible: after === 'visible', raised: true, note: after === 'visible' ? '窗口被抬到前面了' : '抬了也没抬起来' }
}

// ---------------------------------------------------------------------------
// 选择器 → 一个点（外加命中检查）
// ---------------------------------------------------------------------------

/**
 * 这段字符串送进页面里执行，只能用页面认得的东西。`ok` 说这个点打不打得中目标，`x`/`y` 只要算得出来就给
 * （滚轮本来就该作用在最上面那个元素上）；打不中时把挡住它的祖先链与目标的 `pointer-events` 一起报出来
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
    // 父块的文字里必然含着子块的文字：同时命中祖孙时留最里面那个，人指的从来是最贴着字的那一层
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
  // 留边不能把左上角推成负数：负的裁剪框 Chrome 不认，会不报错地从原点截，图出来了内容全错
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
 * 「点」的写法见文件开头。按文字挑是因为界面里大量元素没有自己的选择器；`>>` 先划范围，
 * 因为同名按钮一屏十几个，只有先划定范围才说得清是哪一个
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

/** CDP 要的是虚拟键码，不是 `KeyboardEvent.keyCode` 那套名字 */
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
  // 有 text 的发 keyDown（浏览器据此插入文字），没有的发 rawKeyDown（纯控制键）
  await send('Input.dispatchKeyEvent', k.text === undefined
    ? { type: 'rawKeyDown', ...common }
    : { type: 'keyDown', ...common, text: k.text, unmodifiedText: k.text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

// ---------------------------------------------------------------------------
// 在页面里执行一个文件
// ---------------------------------------------------------------------------

/**
 * 文件里一律是一个函数表达式 `(args) => 一张表`，要 await 就写成 async；不给参数就按空对象调。
 * 只有这一条规则：「是函数就调、不是就直接求值」其实是两条，选错分支时不报错、只回一个看不懂的值。
 * `target` 是 `evalFileOf` 处理过的绝对路径
 */
function callExpressionOf(target, rawArgs) {
  if (!fs.existsSync(target)) {
    throw new Error(`${target} 不在——eval 收的是一个文件的绝对路径`)
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

/** 页面上的 `file://` 地址（外壳插入的脚本与样式表）里带着 home 的绝对路径，问一次正在运行的页面就知道 */
const HOME_EXPR = `(() => {
  const urls = [];
  for (const el of document.querySelectorAll('script[src], link[href]')) urls.push(el.src || el.href);
  return urls.filter((u) => typeof u === 'string' && u.startsWith('file:///'));
})()`

/** 一串 `file://` 地址 → home 的绝对路径。找不到、不止一个都照实说，不猜 */
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
 * `--size 宽x高`：改的是视口，不是系统窗口，用来查容器查询的断点。它只对这次连接生效，所以是开关、
 * 不是动作：`shot --size 900x800` 是一次调用，先 size 再 shot 是两次什么都没做的调用。
 * 页面没在出新帧时这个覆盖量不准：窗格宽度要等 ResizeObserver 与重排，都依赖帧，量到的是旧布局配新视口，这里会报一句
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

/** 点不到就停下，别把「没点到」当成「点过了」 */
function insist(spot) {
  if (spot.ok) return spot
  process.exitCode = 1
  console.log(JSON.stringify(spot, null, 2))
  process.exit(1)
}

async function run(send) {
  switch (verb) {
    case 'eval': {
      const file = evalFileOf(args[0])
      return { did: 'eval', 文件: file, 表: await evaluate(send, callExpressionOf(file, args[1])) }
    }

    case 'move': {
      const spot = insist(await pointOf(send, args[0]))
      await mouse(send, 'mouseMoved', spot.x, spot.y)
      await settle(send)
      return { did: 'move', ...spot }
    }

    case 'click': {
      const spot = insist(await pointOf(send, args[0]))
      // 先移过去再按：悬停才出现的东西得先让它出来
      await mouse(send, 'mouseMoved', spot.x, spot.y)
      await settle(send)
      await mouse(send, 'mousePressed', spot.x, spot.y, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse(send, 'mouseReleased', spot.x, spot.y, { button: 'left', buttons: 0, clickCount: 1 })
      await settle(send)
      return { did: 'click', ...spot }
    }

    // 发的是真实的右键，contextmenu 事件由浏览器自己合成，跟人按右键是同一条路
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
      // 分步移动：一步到位的拖拽很多实现认不出来，中间那几次移动才是它判断方向的依据
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
      // 滚轮不做命中检查：滚的本来就该是最上面那个元素，被挡住不是错
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

    // 经外壳给页面的 window.gwb.command 执行工作台命令。命令失败回 { ok: false }、不抛异常，所以这里把退出码设成非零
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
     * 刷新之后必须等页面真的回来：刷新途中执行上下文被销毁，那几百毫秒里求值一律抛。给了选择器等它出现，不给只等 readyState。
     * 刷新只换得掉页面代码；主进程里已经加载的模块刷新不掉
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

    // 连上时已经核对过名字（assertHome），这里回的是那个 home 的绝对路径
    case 'home':
      return { did: 'home', ...homeOf(await evaluate(send, HOME_EXPR)) }

    case 'shot': {
      // 先算存到哪：给错了在把窗口提到前面、截图之前就停
      const { given, sel } = shotArgsOf(args)
      const file = shotFileOf(given, homeDir)
      await send('Page.enable')
      const seen = await raiseForScreenshot(send)
      // 裁剪只要盒子、不要命中检查：长元素的中心点在别的元素上很常见，跟能不能截它无关
      const spot = sel === undefined ? undefined : await pointOf(send, sel)
      if (spot !== undefined && spot.clip === undefined) insist(spot)
      const clip = spot === undefined ? undefined : { ...spot.clip, scale: 1 }
      // captureBeyondViewport 让裁剪框能伸到可视区以外；长正文是按可视区渲染的，伸出去截到的是空白，要看下面就滚过去再截
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
 * 连上之后核对这个页面属于哪个 home，跟要的对不上就停：记录只说「它启动时用的是这个端口」，
 * 不说「此刻这个端口上还是它」。拿不出 home 的页面也停：那不是工作台的外壳页
 */
async function assertHome(send) {
  const found = homeOf(await evaluate(send, HOME_EXPR))
  if (found.home === null) {
    throw new Error(`这个端口上不是工作台的外壳页（${found.why}）——记录过时了，或者那个窗口已经不在`)
  }
  if (found.名字 !== home) {
    throw new Error(`你要的是 ${home}，可这个端口上的页面自报是 ${found.名字}——记录过时了。停掉重开那个 home`)
  }
  return found.名字
}

/** 日常使用的 home。它上面只许只读动作 */
const DAILY_HOME = 'default'

/** 不改页面与 home 状态的动作 */
export const READ_ONLY_VERBS = new Set(['shot', 'home'])

/** 会改状态的动作：真实输入（悬停、滚动也会触发页面逻辑）、执行命令、刷新；eval 能执行任意代码，一律算写 */
export const WRITE_VERBS = new Set(['eval', 'move', 'click', 'rclick', 'drag', 'scroll', 'type', 'key', 'cmd', 'reload'])

/**
 * `pageHome` 是页面自报的 home 名（`assertHome` 已核对它等于请求的名字）。表外的动作在哪个 home 上都拒；
 * `--size` 改的是页面视口，外壳会跟着重排，所以 default 上也拒
 */
export function assertVerbAllowedOn(pageHome, verb, sizeSwitch) {
  if (!READ_ONLY_VERBS.has(verb) && !WRITE_VERBS.has(verb)) {
    throw new Error(`不认得这个动作：${verb}。每个动作都要登记进 READ_ONLY_VERBS 或 WRITE_VERBS（见文件头的动作表）`)
  }
  if (pageHome !== DAILY_HOME) return
  if (WRITE_VERBS.has(verb)) {
    throw new Error(`default 上只许只读动作（${[...READ_ONLY_VERBS].join(' / ')}），${verb} 是写动作——写动作请在隔离 home 上做（devkit.home.new）`)
  }
  if (sizeSwitch !== undefined) {
    throw new Error(`default 上只许只读动作，--size 会改页面视口——要换视口尺寸请在隔离 home 上做（devkit.home.new）`)
  }
}

// ---------------------------------------------------------------------------

// 被 `node <本文件>` 运行时才动手，被 import 时（单测与 `src/index.ts`）只交出上面那几个纯函数
if (import.meta.main) {
  if (!home || !verb) throw new Error('用法：node <本文件> <home 名> <动作> [参数…]，动作见文件头')
  modifiers = modifiersOf(opts.mod)
  homeDir = homeDirOf(home, homesRootOf())
  port = portOf(home, homeDir)
  const { ws, send, page } = await connect()
  let viewportOverridden = false
  try {
    const pageHome = await assertHome(send)
    assertVerbAllowedOn(pageHome, verb, opts.size)
    viewportOverridden = opts.size !== undefined && opts.size !== 'off'
    const viewport = await override(send)
    console.log(JSON.stringify({ page: page.title, 在哪个home: home, ...viewport, ...(await run(send)) }, null, 2))
  } finally {
    // 视口覆盖必须自己撤：断开连接不一定还原，页面会卡在那个尺寸上。撤不掉也不能盖住本来要报的错，所以不抛。
    // 核对 home 或守卫没过就没发过覆盖，也就不往那个页面发撤销
    if (viewportOverridden) {
      try {
        await send('Emulation.clearDeviceMetricsOverride')
      } catch {
        /* 连接已经断了就算了，下一次 `--size off` 也能撤 */
      }
    }
    ws.close()
  }
}
