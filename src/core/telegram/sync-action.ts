import type { RpcCallOptions, tl } from "@mtcute/core"
import { actionFailureOf, type ActionRefusals } from "./sync-action-outcome"
import { StorageFailure } from "./sync-ending"
import { errorLabel } from "./sync-outcome"
import { callOnce, handOverPts, type SendContext } from "./sync-send"

/** What an action works with; the sync requests' context holds all of it. */
export type ActionContext = SendContext

/**
 * Makes the one call of an action and resolves with Telegram's answer, or
 * with undefined when Telegram answers that the message is already as asked.
 * Any other failure throws what `actionFailureOf` decides (see `callOnce`).
 */
export function performAction<Answer>(
  ctx: ActionContext,
  signal: AbortSignal,
  refusals: ActionRefusals,
  call: (options: RpcCallOptions) => Promise<Answer>,
): Promise<Answer | undefined> {
  return callOnce<Answer | undefined>(ctx, signal, refusals.words.name, call, (error, trouble) =>
    actionFailureOf(error, trouble, refusals),
  )
}

/**
 * Tells mtcute's update state of the events an action answered with a count
 * and no updates (`messages.affectedMessages`), the way its own delete does.
 * `channelId` is the bare id of the channel they happened in; none for the
 * account's own. `what` names the request in the log.
 */
export function handOverAffected(
  ctx: ActionContext,
  what: string,
  affected: tl.messages.TypeAffectedMessages,
  channelId?: number,
): void {
  try {
    handOverPts(ctx, affected, channelId)
  } catch (error) {
    ctx.settings.log(`${what}: the update state could not take the response (${errorLabel(error)})`)
  }
}

/**
 * Records the outcome of an action in the mirror through `write`, which
 * writes it in one transaction. It never fails the action, which went through:
 * what cannot be read is left for the gap filling to bring, and a mirror that
 * cannot be written stops the service, as it does for a received message, once
 * the answer has been written.
 */
export function recordAction(ctx: ActionContext, what: string, write: () => void): void {
  try {
    write()
  } catch (error) {
    if (error instanceof StorageFailure) {
      // The call's context holds the run's end back until the answer has been written.
      ctx.failRun(error)
      return
    }
    ctx.settings.log(`${what}: the result could not be recorded (${errorLabel(error)})`)
  }
}
