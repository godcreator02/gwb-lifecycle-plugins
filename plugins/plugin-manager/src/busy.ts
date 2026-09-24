export const BUSY_MESSAGE = 'BUSY：同一个 home 同一时刻只允许一个安装、卸载或升级操作，等正在运行的那个返回回执后再试'

/** 进程内的一个标志就够：一个内核进程只服务一个 home */
export class BusyGate {
  private aChangeIsRunning = false

  /** 已有改动在运行时直接回 BUSY 回执，不执行 fn、也不排队 */
  async run<T extends { ok: boolean }>(fn: () => Promise<T> | T): Promise<T | { ok: false; error: string }> {
    if (this.aChangeIsRunning) return { ok: false, error: BUSY_MESSAGE }
    this.aChangeIsRunning = true
    try {
      return await fn()
    } finally {
      this.aChangeIsRunning = false
    }
  }
}
