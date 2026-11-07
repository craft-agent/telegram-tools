/** Waits `ms` milliseconds; a real one leaves early, and without a timer behind, when `signal` aborts. */
export type Pause = (ms: number, signal: AbortSignal) => Promise<void>

/** Calls `fn` when `signal` aborts, at once when it already has; returns the function that stops listening. */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => {}
  if (signal.aborted) {
    fn()
    return () => {}
  }
  signal.addEventListener("abort", fn, { once: true })
  return () => signal.removeEventListener("abort", fn)
}

/** Resolves after `ms`, or as soon as `signal` aborts; leaves no timer or listener behind. */
export const realPause: Pause = (ms, signal) =>
  new Promise((resolve) => {
    let stopListening = () => {}
    const timer = setTimeout(() => {
      stopListening()
      resolve()
    }, ms)
    stopListening = onAbort(signal, () => {
      clearTimeout(timer)
      resolve()
    })
  })

/** Waits through `pause`, and gives up the moment `signal` aborts, whatever `pause` does; never rejects. */
export function waitThrough(pause: Pause, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const stopListening = onAbort(signal, resolve)
    pause(ms, signal)
      .catch(() => {})
      .finally(() => {
        stopListening()
        resolve()
      })
  })
}

/** Resolves once `promise` settles or `ms` passed, whichever is first; leaves no timer behind and never rejects. */
export async function settledOrTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  const timer = new AbortController()
  try {
    await Promise.race([promise.catch(() => {}), realPause(ms, timer.signal)])
  } finally {
    timer.abort()
  }
}
