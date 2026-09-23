/**
 * 变更互斥：同一 home 同时至多一个安装、卸载或升级操作。
 *
 * 用进程内标志位实现：一个 gwb 内核进程只服务一个 home，所以模块级互斥就是 home 级互斥。重入不排队、
 * 直接回 BUSY——排队会让界面看起来点了没反应，用回执说清原因比静默等待更明确。
 */
export const BUSY_MESSAGE = 'BUSY：同一 home 同时只许一个装卸/升级操作，等在跑的那趟回执后再来'

export class BusyGate {
  private held = false

  /** 占用互斥标志执行一次 fn；已被占用时直接回 BUSY 回执，不执行 fn */
  async run<T extends { ok: boolean }>(fn: () => Promise<T> | T): Promise<T | { ok: false; error: string }> {
    if (this.held) return { ok: false, error: BUSY_MESSAGE }
    this.held = true
    try {
      return await fn()
    } finally {
      this.held = false
    }
  }
}
