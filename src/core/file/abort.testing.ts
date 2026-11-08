/** A real signal that is aborted at the first `throwIfAborted` check for which `when` holds; the request to the service sees it as any other. */
export function abortWhen(when: () => boolean): AbortSignal {
  const controller = new AbortController()
  const { signal } = controller
  const check = signal.throwIfAborted.bind(signal)
  signal.throwIfAborted = () => {
    if (when()) controller.abort()
    check()
  }
  return signal
}
