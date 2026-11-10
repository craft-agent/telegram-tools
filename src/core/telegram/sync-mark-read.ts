import type { tl } from "@mtcute/core"
import { ACTION_PAST, checkInTopic, checkTopicChat } from "./action-checks"
import { applyRead } from "./ingest-chats"
import { inTransaction, type Mirror } from "./mirror"
import { findChat } from "./mirror-rows"
import type { MarkReadParams, MarkReadResult } from "./service-requests"
import type { ServiceCall } from "./service-server"
import { handOverAffected, performAction, recordAction, type ActionContext } from "./sync-action"
import { anyMessageOf } from "./sync-action-mirror"
import { MESSAGE_GONE, type ActionRefusals, type ActionWords } from "./sync-action-outcome"
import { writing } from "./sync-ending"
import { viaTelegram } from "./sync-request-calls"
import { cancelled } from "./sync-request-errors"
import { parseMarkReadParams } from "./sync-request-params"
import type { RequestQueue } from "./sync-request-queue"

const MARK_READ_WORDS: ActionWords = {
  name: "mark read",
  gerund: "marking",
  past: ACTION_PAST.markRead,
  untouched: `nothing was ${ACTION_PAST.markRead}`,
}

/**
 * How a failed mark read is told. No name says "already": the calls are
 * idempotent at Telegram, which answers a read mark at or below the one it has
 * with success.
 */
const MARK_READ_REFUSALS: ActionRefusals = {
  words: MARK_READ_WORDS,
  already: [],
  named: [MESSAGE_GONE, { names: ["TOPIC_ID_INVALID"], code: "not_found", what: "Telegram has no such topic" }],
}

/** The calls that mark messages read: a topic's, a supergroup's or channel's, and the account's own. */
type MarkReadRequest =
  tl.messages.RawReadDiscussionRequest | tl.channels.RawReadHistoryRequest | tl.messages.RawReadHistoryRequest

/** What Telegram answers a read mark with: the events counted for the account's own chats, a plain yes for the others. */
type MarkReadAnswer = tl.messages.TypeAffectedMessages | boolean

/** The call that reads up to message `up_to`: of the topic when one is named (the General topic included), else of the whole chat. */
function requestOf(peer: tl.TypeInputPeer, { up_to, topic }: MarkReadParams): MarkReadRequest {
  if (topic !== undefined) return { _: "messages.readDiscussion", peer, msgId: topic, readMaxId: up_to }
  if (peer._ !== "inputPeerChannel") return { _: "messages.readHistory", peer, maxId: up_to }
  const { channelId, accessHash } = peer
  return { _: "channels.readHistory", channel: { _: "inputChannel", channelId, accessHash }, maxId: up_to }
}

/** How many messages of `chat` the mirror holds from others past `readMax`: the ones the chat shows unread. */
function unreadPast(mirror: Mirror, chat: string, readMax: number): number {
  const row = mirror
    .prepare("SELECT COUNT(*) AS unread FROM messages WHERE chat = ? AND from_me = 0 AND id > ?")
    .get(chat, readMax) as { unread: number }
  return row.unread
}

/**
 * Moves the chat's read mark to message `upTo` in one transaction, as a read
 * on another device does: it only grows, and `unread` is what the mirror holds
 * from others past it (none when the mark reaches the newest message). A topic
 * has no read mark in the mirror, so a call for one records nothing.
 */
function recordRead(ctx: ActionContext, { chat, up_to: upTo }: MarkReadParams): void {
  recordAction(ctx, "mark read", () => {
    const { mirror } = ctx
    writing(() =>
      inTransaction(mirror, () => {
        const row = findChat(mirror, chat)
        const readMax = Math.max(row?.read_max ?? 0, upTo)
        const unread = readMax >= (row?.top_id ?? Infinity) ? 0 : unreadPast(mirror, chat, readMax)
        applyRead(mirror, { chat, maxId: upTo, unread })
      }),
    )
  })
}

/** Checks the read mark against the mirror, then asks for it once. See `markReadRequest`. */
async function markRead(
  ctx: ActionContext,
  call: ServiceCall,
  signal: AbortSignal,
  params: MarkReadParams,
): Promise<MarkReadResult> {
  const { chat, up_to, topic } = params
  const { chat: row, message } = anyMessageOf(ctx.mirror, chat, up_to, MARK_READ_WORDS)
  checkTopicChat(row, topic, MARK_READ_WORDS.past)
  checkInTopic(message.topic, topic, MARK_READ_WORDS.past)
  const done: MarkReadResult = { chat, up_to, ...(topic === undefined ? {} : { topic }) }
  // Never back: a read mark only moves forward, so a chat read this far is done. A topic has no mark in the mirror to look at.
  if (topic === undefined && row.read_max !== null && row.read_max >= up_to) return { ...done, already: true }

  const peer = await viaTelegram(ctx, call, "mark read", () => ctx.client.resolvePeer(Number(chat)))
  if (signal.aborted) throw cancelled()

  const request = requestOf(peer, params)
  const answer: MarkReadAnswer | undefined = await performAction(ctx, signal, MARK_READ_REFUSALS, (options) =>
    ctx.client.call(request, options),
  )
  // Only the account's own chats answer with events counted; a supergroup's, a channel's and a topic's answer is a bool.
  if (typeof answer === "object") handOverAffected(ctx, "mark read", answer)
  if (topic === undefined) recordRead(ctx, params)
  return done
}

/**
 * Answers a `mark_read` request: a chat, or one forum topic of it, marked read
 * up to a message of any author that the mirror holds, through one low-level
 * call, and the chat's read mark moved in the mirror. Checked against the
 * mirror first, and failing as `forbidden`, `invalid_argument` or `not_found`
 * with nothing marked (see `anyMessageOf`, `checkTopicChat` and
 * `checkInTopic`). A chat the mirror shows read up to the message or beyond is
 * done without a call, so that a read mark never goes back. The outcome is
 * never guessed: see `actionFailureOf`. Read marks run one at a time through
 * `queue`, which the sends share.
 */
export function markReadRequest(
  ctx: ActionContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<MarkReadResult> {
  const params = parseMarkReadParams(raw)
  const signal = AbortSignal.any([call.signal, ctx.signal])
  return queue.run(signal, () => markRead(ctx, call, signal, params))
}
