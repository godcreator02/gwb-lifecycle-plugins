import { useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * 浏览器侧：一个窗格，你好 + 计数按钮。
 *
 * 类名一律带 `{{cssPrefix}}:` 前缀：样式只作用于本插件，靠的是类名唯一，不靠 DOM 祖先关系（弹层
 * portal 到 body 也有样式）。样式入口在 `styles.css`，那几行 import 每一条都不能省，理由写在那边。
 * react 由页面的 importmap 提供（提供方是外壳），构建时不打包，见 build.ts。
 */

/** 外壳调 mountPane 时传入的参数。只按形状声明，不引外壳的包——那是 node 侧的依赖 */
interface PaneArgs {
  pane: { id: string; instance: string }
}

function Pane(): ReactElement {
  const [count, setCount] = useState(0)
  return (
    <div className="{{cssPrefix}}:h-full {{cssPrefix}}:space-y-4 {{cssPrefix}}:p-8">
      <h1 className="{{cssPrefix}}:text-2xl {{cssPrefix}}:font-semibold">你好，{{title}}</h1>
      <p className="{{cssPrefix}}:text-sm {{cssPrefix}}:text-muted-foreground">
        模板窗格。按钮只改本地状态；命令 {{name}}.ping 在 node 侧，经命令总线调用。
      </p>
      <div className="{{cssPrefix}}:flex {{cssPrefix}}:items-center {{cssPrefix}}:gap-3">
        <button
          data-probe="bump"
          className="{{cssPrefix}}:rounded {{cssPrefix}}:bg-primary {{cssPrefix}}:px-3 {{cssPrefix}}:py-1.5 {{cssPrefix}}:text-sm {{cssPrefix}}:text-primary-foreground"
          onClick={() => setCount((n) => n + 1)}
        >
          +1
        </button>
        <span className="{{cssPrefix}}:font-mono {{cssPrefix}}:text-2xl" data-probe="count">
          {count}
        </span>
      </div>
    </div>
  )
}

/**
 * 窗格插件浏览器侧的入口，导出名固定是 `mountPane`。返回 `{ dispose }`：关闭窗格时外壳调用它，
 * 由它卸载这棵 React 树。
 */
export function mountPane(_args: PaneArgs, container: HTMLElement): { dispose(): void } {
  const root = createRoot(container)
  root.render(<Pane />)
  return {
    dispose() {
      root.unmount()
      container.textContent = ''
    },
  }
}
