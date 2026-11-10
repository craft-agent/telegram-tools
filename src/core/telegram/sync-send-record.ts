import { MessageEntity } from "@mtcute/core"
import { entitiesOf } from "./from-mtcute-parts"
import { inTransaction, type Mirror } from "./mirror"
import type { IngestContext, MessageInput, ReplyInfo } from "./mirror-input"
import { GENERAL_TOPIC, type SendParams } from "./service-requests"
import { writing } from "./sync-ending"
import { readMessage, writeMessage, type ReadMessage } from "./sync-message"
import type { FullSentMessage, SentMessage } from "./sync-send-outcome"

/** The topic a message of the send is in, as the mirror records it: the General topic's messages carry none. */
function topicOfSend({ topic }: SendParams): number | null {
  return topic === undefined || topic === GENERAL_TOPIC ? null : topic
}

/** What the sent message replies to, as the mirror records a reply: a plain post in a topic replies to nothing. */
function replyOfSend(params: SendParams): ReplyInfo | null {
  if (params.reply_to === undefined) return null
  const topic = topicOfSend(params)
  return topic === null ? { id: params.reply_to } : { id: params.reply_to, topic }
}

/**
 * The message of the short form, which carries only its id, time, timer and
 * entities, completed from the send itself the way mtcute's own text sender
 * does. Its chat is known: the send named it, and the mirror lists it.
 */
function shortInput(params: SendParams, sent: Extract<SentMessage, { form: "short" }>): MessageInput {
  const entities = sent.entities.map((raw) => new MessageEntity(raw, params.text))
  return {
    chat: params.chat,
    id: sent.id,
    topic: topicOfSend(params),
    ts: sent.date,
    fromMe: true,
    sender: null,
    senderName: null,
    kind: "message",
    body: params.text,
    entities: entitiesOf({ entities }),
    media: null,
    action: null,
    reply: replyOfSend(params),
    forward: null,
    grouped: null,
    reactions: null,
    edited: null,
    ttl: sent.ttl,
    viewOnce: false,
    selfDestruct: null,
  }
}

/**
 * The sent message as the mirror takes it. A full message goes the way a
 * received one does, so `from_me`, the topic and the reply are filled from
 * Telegram's own object; the short form is completed from the send. Null when
 * the message is not for the mirror (a channel with `channels` off).
 */
export function readSent(sent: SentMessage, params: SendParams, channels: boolean): ReadMessage | null {
  if (sent.form === "full") return readFullSent(sent, channels)
  return { chat: null, message: shortInput(params, sent), topic: null }
}

/** A sent message that came as itself, as the mirror takes it: its file's facts are stored as a received file's are. */
export function readFullSent(sent: FullSentMessage, channels: boolean): ReadMessage | null {
  return readMessage(sent.message, channels)
}

/**
 * Writes the sent message in one transaction, the way a pushed one is written:
 * a message the mirror already has (an update that came first) is an upsert,
 * not a second row. Throws `StorageFailure` when the mirror cannot be written.
 */
export function recordSent(mirror: Mirror, ctx: IngestContext, read: ReadMessage, channels: boolean): void {
  writing(() => inTransaction(mirror, () => writeMessage(mirror, ctx, read, channels)))
}
