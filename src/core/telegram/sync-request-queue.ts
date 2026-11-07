import { abortable } from "./sync-request-errors"

/** Runs jobs one at a time, in the order they were asked for; a job whose caller leaves while it waits drops out. */
export class RequestQueue {
  /** Settles when the last job in line is done. It never rejects. */
  private tail: Promise<void> = Promise.resolve()

  /**
   * Runs `work` once the jobs ahead are done. Rejects as `cancelled()`, without
   * running `work`, when `signal` aborts first; the jobs behind it then wait
   * for the ones ahead of it, as they would have.
   */
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const ahead = this.tail
    let done = () => {}
    this.tail = new Promise<void>((resolve) => (done = resolve))
    try {
      await abortable(ahead, signal)
    } catch (error) {
      void ahead.then(done)
      throw error
    }
    try {
      return await work()
    } finally {
      done()
    }
  }
}
