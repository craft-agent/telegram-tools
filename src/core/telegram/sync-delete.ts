import type { tl } from "@mtcute/core"
import { ACTION_PAST } from "./action-checks"
import { inTransaction } from "./mirror"
import { isNumberedPerChat, type ChatRow } from "./mirror-rows"
import type { DeleteParams, DeleteResult } from "./service-requests"
import type { ServiceCall } from "./service-server"
import { handOverAffected, performAction, recordAction, type ActionContext } from "./sync-action"
import { targetOf } from "./sync-action-mirror"
import { MESSAGE_GONE, type ActionRefusals, type ActionWords } from "./sync-action-outcome"
import { deleteMessages } from "./ingest-delete"
import { writing } from "./sync-ending"
import { viaTelegram } from "./sync-request-calls"
import { cancelled } from "./sync-request-errors"
import { parseDeleteParams } from "./sync-request-params"
import type { RequestQueue } from "./sync-request-queue"

const DELETE_WORDS: ActionWords = {
  name: "delete",
  gerund: "deleting",
  past: ACTION_PAST.delete,
  untouched: "the message is still there",
}

/** How a failed delete is told. A message that is already gone is not an error of Telegram's: it counts no message deleted. */
const DELETE_REFUSALS: ActionRefusals = {
  words: DELETE_WORDS,
  already: [],
  named: [
    MESSAGE_GONE,
    {
      names: ["MESSAGE_DELETE_FORBIDDEN"],
      code: "forbidden",
      what: "Telegram does not let this account delete this message",
    },
  ],
}

/** The call that deletes message `id` for everyone: a channel's own method for a supergroup or channel, else the account's. */
function requestOf(
  peer: tl.TypeInputPeer,
  id: number,
): tl.messages.RawDeleteMessagesRequest | tl.channels.RawDeleteMessagesRequest {
  if (peer._ !== "inputPeerChannel") return { _: "messages.deleteMessages", revoke: true, id: [id] }
  const { channelId, accessHash } = peer
  return { _: "channels.deleteMessages", channel: { _: "inputChannel", channelId, accessHash }, id: [id] }
}

/**
 * Removes the message from the mirror as a delete for everyone does, with its
 * earlier versions and a tombstone. The delete is the user's own, so it
 * outranks keeping disappearing messages. Ids of private chats and basic
 * groups are numbered for the account, so those are deleted without a chat.
 */
function recordDelete(ctx: ActionContext, { id: chat, kind }: ChatRow, id: number): void {
  recordAction(ctx, "delete", () => {
    const ingest = { now: ctx.settings.now(), keepDisappearing: false }
    writing(() =>
      inTransaction(ctx.mirror, () =>
        deleteMessages(ctx.mirror, ingest, { chat: isNumberedPerChat(kind) ? chat : null, ids: [id] }),
      ),
    )
  })
}

/** Checks the delete against the mirror, then asks for it once. See `deleteRequest`. */
async function deleteOwn(
  ctx: ActionContext,
  call: ServiceCall,
  signal: AbortSignal,
  params: DeleteParams,
): Promise<DeleteResult> {
  const { chat, message } = targetOf(ctx.mirror, params.chat, params.id, DELETE_WORDS)
  if (!message) return { id: params.id, deleted: true, already: true }
  const peer = await viaTelegram(ctx, call, "delete", () => ctx.client.resolvePeer(Number(params.chat)))
  if (signal.aborted) throw cancelled()

  const request = requestOf(peer, params.id)
  const affected = await performAction(ctx, signal, DELETE_REFUSALS, (options) => ctx.client.call(request, options))
  if (affected) handOverAffected(ctx, "delete", affected, peer._ === "inputPeerChannel" ? peer.channelId : undefined)
  recordDelete(ctx, chat, params.id)
  // No event counted: the message was not there to delete, so it is gone, though not by this call.
  return { id: params.id, deleted: true, ...(!affected || affected.ptsCount === 0 ? { already: true } : {}) }
}

/**
 * Answers a `delete` request: one of the user's own messages in a chat the
 * mirror lists, deleted for everyone through one low-level call and removed
 * from the mirror. Checked against the mirror first, and failing as
 * `forbidden` or `not_found` with nothing deleted (see `targetOf`). A message
 * the mirror has as deleted is done without a call. The outcome is never
 * guessed: see `actionFailureOf`. Deletes run one at a time through `queue`,
 * which the sends share.
 */
export function deleteRequest(
  ctx: ActionContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<DeleteResult> {
  const params = parseDeleteParams(raw)
  const signal = AbortSignal.any([call.signal, ctx.signal])
  return queue.run(signal, () => deleteOwn(ctx, call, signal, params))
}
