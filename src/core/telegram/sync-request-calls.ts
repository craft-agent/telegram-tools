import { ToolError } from "../errors"
import type { Mirror } from "./mirror"
import { findChat, type ChatRow } from "./mirror-rows"
import type { ServiceCall } from "./service-server"
import type { ResolvedSyncOptions } from "./sync-options"
import { abortable, cancelled, requestFailure } from "./sync-request-errors"

export const UNKNOWN_LISTED_CHAT_MESSAGE = "The chat list has no such chat; refresh it, or check the id."

/** What a request that calls Telegram needs of the service's context. */
export type TelegramCallContext = {
  settings: Pick<ResolvedSyncOptions, "log">
  /** Aborts when the run ends. */
  signal: AbortSignal
  /** Ends the run, since Telegram ended the session. */
  endSession(): void
}

/**
 * Runs a call to Telegram for a request: it gives up the moment the request's
 * client leaves or the run ends, and a failure of it becomes the error the
 * request answers with. `what` names the request in the log.
 */
export async function viaTelegram<T>(
  ctx: TelegramCallContext,
  call: ServiceCall,
  what: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.any([call.signal, ctx.signal])
  if (signal.aborted) throw cancelled()
  try {
    return await abortable(work(signal), signal)
  } catch (error) {
    throw requestFailure(error, what, { endSession: ctx.endSession, log: ctx.settings.log })
  }
}

/** The mirror's row for a chat the mirror lists; `not_found` when it does not. */
export function listedChat(mirror: Mirror, id: string): ChatRow {
  const row = findChat(mirror, id)
  if (!row) throw new ToolError("not_found", UNKNOWN_LISTED_CHAT_MESSAGE)
  return row
}
