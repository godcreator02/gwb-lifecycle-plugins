/**
 * 变更互斥（实施 Spec §3：同一 home 同时至多一个装卸/升级操作）。
 *
 * 进程内标志位起步：一个 gwb 内核进程只伺候一个 home，模块语义就是 home 语义。重入不排队、
 * 直接回 BUSY——排队会让界面看起来点了没反应，回执说清原因比静默等待诚实。
 */
export const BUSY_MESSAGE = 'BUSY：同一 home 同时只许一个装卸/升级操作，等在跑的那趟回执后再来'

export class BusyGate {
  private held = false

  /** 占门跑一趟；门已占时原样回 BUSY 回执，不执行 fn */
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
