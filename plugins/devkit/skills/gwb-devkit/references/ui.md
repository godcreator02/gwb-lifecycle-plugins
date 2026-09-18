# 带界面的插件：浏览器半与样式

`skill.read {"name":"gwb-devkit","file":"references/ui.md"}` 读到的就是这一份。主文件是 skill「gwb-devkit」。

**样板就是模板本身**：`devkit.scaffold` 落出来的就是带窗格的完整形状（浏览器半、前缀围栏、两道产物守卫、
esbuild 构建线），照着改。更活的用例是 UI 平台仓的 baseui（`D:\unitfolders\26091217uiz\gwb-ui-plugins`）。

## 浏览器半

浏览器半的文件头先写 `import type {} from '@godcreator/gwb-plugin-api'`——client 的 tsconfig 是
`"types": []`，不吃全局声明，这一行之后 TypeScript 才认得 `window.gwb`。

`src/client/index.tsx` 导出 `mountPane(args, container) => { dispose() }`。esbuild 打成 `dist/client.js`，
只把 `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` 四个裸名外置（页面 importmap 解析到
共享包），其余打进本束——多外置一个就是运行期 `Failed to resolve module specifier`。node 半注册窗格时自报
`client` 与 `style` 的 `file://` 地址，从自己的 `import.meta.url` 算。

`dispose` 先同步 `root.unmount()`，再清容器——反过来，React 拆树时找不到自己的节点，关窗格抛
`removeChild NotFoundError`。

**窗格图标写 lucide 的正名，kebab-case**（`registerPane({ id, title, icon: 'layout-grid' })`，`describeSelf`
同一套），lucide 全集都认。认不出时窗格照挂、标签画一个 `#`，登记当下日志里一条 warn——写完看一眼日志。
怎么认的正本在 UI 平台仓文档站 shell 页「图标名怎么认」。

**窗格不是视口**：响应式用容器查询变体 `@sm:` / `@md:`。外壳给每个窗格的容器是容器查询根。

## 样式围栏是 Tailwind 前缀

插件自己就是一个完整的 Tailwind 入口，`src/client/styles.css` 五行：

```css
@import 'tailwindcss/theme.css' theme(reference) prefix(<cssPrefix>);
@import '@godcreator/gwb-tokens/theme.reference.css' theme(reference);
@import 'tailwindcss/utilities.css' layer(utilities) source(none);
@import 'tw-animate-css';
@source "./";
```

产物 `tailwindcss -i src/client/styles.css -o dist/style.css`。类名一律 `<cssPrefix>:flex`——cssPrefix 是
短名剔除非小写字母（Tailwind 4 的 `prefix()` 只收 a-z，`audit-probe` → `auditprobe`）。规则全页有效、
只匹配本插件元素，所以弹层 portal 到 `body` 照样有样式，shadcn 组件原样用；容器上的 `data-gwb-plugin`
只是身份标记。`components.json` 的 `tailwind.prefix` 填 cssPrefix，`shadcn add` 拉下来的类名自带前缀。

会静默出错的几处：

* **前缀永远排最前**，变体跟在它后面：`<cssPrefix>:disabled:opacity-50`、`<cssPrefix>:hover:bg-accent`。
  写成 `disabled:<cssPrefix>:opacity-50` 不报错，只是一条规则都不出，产物守卫也测不到
* **前缀人人要带**：忘加前缀的类一个字节都不出，模板的 `tests/prefix.test.ts` 当场红；`group` / `peer`
  这类标记类也带前缀（`<cssPrefix>:group`），标记不带前缀永远不命中，守卫抓不到
* **TS 字符串撞上工具类名**：`'running'` / `'paused'` 这类值恰好是 Tailwind 的真实工具类，前缀守卫
  照样报红。改值名（`ticking` / `halted`），守卫是对的
* **引齐三样**：不引令牌映射面，颜色类全空；不引 `tw-animate-css`，`animate-in` 一族不生成、菜单不动画
* Tailwind 会把内置主题变量也改名（`--<cssPrefix>-spacing`），主题值只经令牌映射面送进来
* lucide 图标上的 `lucide lucide-xxx` 是它烤进 SVG 的身份属性，不是类名泄漏

## 令牌与颜色

第二行引的令牌映射面（`@godcreator/gwb-tokens` ≥0.1.1）把插件用到的 Tailwind 出厂键（间距、字重字距、
白黑、八档阴影、缓动、过渡、容器断点）全接管到页面变量，重编后 `dist/style.css` 零字面 fallback。
映射面只接管到 `text-*` 的 4xl、`container-*` 的 xs/lg；出了这个区（`text-6xl`、`max-w-sm`）写明示任意值
`text-[3.75rem]`、`max-w-[24rem]`。

颜色三条（判据正本：UI 平台仓文档站「令牌与颜色：共享规则」`docs-site\content\docs\tokens.mdx`）：

* **语义色一律语义类**，含 `warning`（亮暗两套）——换主题时颜色才跟着走
* **纯装饰色走插件域令牌两段制**，值只住一处。值段 `src/client/tokens.css` 把带插件前缀的变量挂 `:root`
  （弹层 portal 到哪都读得到；值优先桥接如 `var(--accent)`，`.dark` 里可覆盖）；映射段在样式入口尾部
  `@theme inline` 注册插件域工具类。活例：baseui 的日志来源点色
* **一次性装饰**用任意值语法明示写死（`bg-[#abc]`），让写死看得见

```css
/* 值段 src/client/tokens.css */
:root { --<cssPrefix>-src-plugin: oklch(0.623 0.214 259.815); }

/* 映射段 src/client/styles.css 尾部：注册 <cssPrefix>:bg-src-plugin 这一族 */
@theme inline { --color-src-plugin: var(--<cssPrefix>-src-plugin); }
```

## 产物守卫

模板的 `tests/artifact.test.ts` 钉着两条：

* **零字面 fallback**：`dist/style.css` 里 `var()` 的第二参只认 `var()` 引用、`currentcolor`、空；
  tw-animate-css 烤在包里的那几个（`--tw-animation-*` / `--tw-enter-*` / `--tw-exit-*`、`--tw-ease,ease`、
  `--tw-duration,.15s`）豁免。红了多半是升了令牌没重编
* **前缀选择器**

要加**颜色类白名单**，照 baseui 的同名测试补：色名 ∈ 令牌映射面的 `--color-*` ∪ 本插件入口 `@theme`
自注册，两边现扫；`transparent` / `inherit` / `current` 与字号对齐这类非色形态豁免。

升 Tailwind 大版本时，按令牌映射面头注的提示重核键名——映射面是出厂主题的镜像，新键与改名都在那儿现形。
