import { MtPeerNotFoundError } from "@mtcute/core"
import { ToolError } from "../errors"
import { floodWaitSecondsOf, isSessionEnded, rpcTextOf } from "./rpc-errors"
import { StorageFailure } from "./sync-ending"
import { SESSION_ENDED_REASON, errorLabel } from "./sync-outcome"
import { onAbort } from "./sync-wait"

/** The errors Telegram answers with when it no longer gives the account a chat. */
export const CHAT_GONE_ERRORS: readonly string[] = [
  "CHANNEL_PRIVATE",
  "CHANNEL_INVALID",
  "PEER_ID_INVALID",
  "CHAT_ID_INVALID",
]

/** What the failure of a request may do to the run, and where its trace goes. */
export type RequestEnv = {
  /** Ends the run: Telegram ended the session. */
  endSession(): void
  /** The service's log, which takes error names and never content. */
  log(line: string): void
}

/** The error of a request whose caller left or whose service is stopping. */
export function cancelled(): ToolError {
  return new ToolError("upstream_error", "The request was cancelled before Telegram answered.")
}

/** `promise`, rejecting as `cancelled()` the moment `signal` aborts; what the promise does later is ignored. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stopListening = onAbort(signal, () => reject(cancelled()))
    promise.then(resolve, reject).then(stopListening)
  })
}

/**
 * The error a request answers with for something that went wrong on the way to
 * Telegram. Only Telegram's name for an error, a flood wait's seconds and fixed
 * texts reach the answer: an error's own message may hold what the person
 * wrote. A session that ended ends the run, as it does when a background call
 * finds it. A failure that is the service's own (a mirror that cannot be
 * written) is returned as it is, for the server to report as an internal error.
 */
export function requestFailure(error: unknown, what: string, env: RequestEnv): Error {
  if (error instanceof ToolError || error instanceof StorageFailure) return error
  if (isSessionEnded(error)) {
    env.endSession()
    return new ToolError("upstream_error", `${SESSION_ENDED_REASON}.`)
  }
  const seconds = floodWaitSecondsOf(error)
  if (seconds !== undefined) {
    return new ToolError(
      "upstream_error",
      `Telegram is limiting requests from this account; try again in ${seconds} seconds.`,
    )
  }
  const name = rpcTextOf(error)
  if (name !== undefined && CHAT_GONE_ERRORS.includes(name)) {
    return new ToolError("not_found", "Telegram no longer gives this account that chat.")
  }
  if (error instanceof MtPeerNotFoundError) {
    return new ToolError("not_found", "Telegram has not given this account that chat.")
  }
  env.log(`${what} failed: ${errorLabel(error)}`)
  if (name !== undefined) return new ToolError("upstream_error", `Telegram refused the request (${name}).`)
  return new ToolError("upstream_error", "Telegram did not answer the request; try again.")
}
