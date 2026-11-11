import type { tl } from "@mtcute/core"
import type { ServiceCall } from "./service-server"
import { actionFailureOf, type ActionRefusals } from "./sync-action-outcome"
import { StorageFailure } from "./sync-ending"
import { errorLabel } from "./sync-outcome"
import { viaTelegram } from "./sync-request-calls"
import { cancelled } from "./sync-request-errors"
import type { RequestQueue } from "./sync-request-queue"
import { callOnce, handOverPts, type SendContext } from "./sync-send"

/** What an action works with; the sync requests' context holds all of it. */
export type ActionContext = SendContext

/**
 * Parses an action's `raw` params, then runs `act` on `queue` with the signal
 * of the call joined to the run's: one at a time, and not at all when the call
 * is cancelled while it waits (`RequestQueue.run`). `parse` throws the
 * refusal for params it does not take, before anything is queued.
 */
export function runAction<Params, Result>(
  ctx: ActionContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
  parse: (raw: unknown) => Params,
  act: (params: Params, signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const params = parse(raw)
  const signal = AbortSignal.any([call.signal, ctx.signal])
  return queue.run(signal, () => act(params, signal))
}

/**
 * The input peer of `chat`, a chat id of the mirror, as Telegram knows it.
 * `what` names the request in the log. A call cancelled meanwhile throws
 * `cancelled()`, so that no call to Telegram follows.
 */
export async function resolveChatPeer(
  ctx: ActionContext,
  call: ServiceCall,
  signal: AbortSignal,
  what: string,
  chat: string,
): Promise<tl.TypeInputPeer> {
  const peer = await viaTelegram(ctx, call, what, () => ctx.client.resolvePeer(Number(chat)))
  if (signal.aborted) throw cancelled()
  return peer
}

/** The channel a supergroup's or channel's `peer` is, for the methods of `channels.*`; undefined for any other peer. */
export function inputChannelOf(peer: tl.TypeInputPeer): tl.RawInputChannel | undefined {
  if (peer._ !== "inputPeerChannel") return undefined
  const { channelId, accessHash } = peer
  return { _: "inputChannel", channelId, accessHash }
}

/**
 * Makes the one call of an action and resolves with Telegram's answer, or
 * with undefined when Telegram answers that the message is already as asked.
 * Any other failure throws what `actionFailureOf` decides (see `callOnce`).
 */
export function performAction<Request extends tl.RpcMethod>(
  ctx: ActionContext,
  signal: AbortSignal,
  refusals: ActionRefusals,
  request: Request,
): Promise<tl.RpcCallReturn[Request["_"]] | undefined> {
  return callOnce<tl.RpcCallReturn[Request["_"]] | undefined>(
    ctx,
    signal,
    refusals.words.name,
    (options) => ctx.client.call(request, options),
    (error, trouble) => actionFailureOf(error, trouble, refusals),
  )
}

/** The updates an answer carries: an updates group's, or the one of a short update; none for any other form. */
export function updatesOf(response: tl.TypeUpdates): readonly tl.TypeUpdate[] {
  switch (response._) {
    case "updates":
    case "updatesCombined":
      return response.updates
    case "updateShort":
      return [response.update]
    default:
      return []
  }
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
