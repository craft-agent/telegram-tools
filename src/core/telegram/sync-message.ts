import type { Message } from "@mtcute/core"
import { chatInputOf, messageInputOf, topicInputOfAction } from "./from-mtcute"
import { readOrNull } from "./from-mtcute-parts"
import { upsertTopics } from "./ingest-chats"
import { storeMessage, type StoreOutcome } from "./ingest-messages"
import type { Mirror } from "./mirror"
import type { ChatInput, IngestContext, MessageInput, TopicInput } from "./mirror-input"
import { keepsKind, rememberChats } from "./sync-follow"

/** What a message from Telegram becomes before it is written. */
export type ReadMessage = {
  /** The chat it was sent in, when mtcute can tell. */
  chat: ChatInput | null
  message: MessageInput
  /** The forum topic a service message created or edited. */
  topic: TopicInput | null
}

/**
 * Turns a message into what the mirror takes, or null when it is not for the
 * mirror: a chat of a kind it does not keep, or a channel with `channels` off.
 */
export function readMessage(message: Message, channels: boolean): ReadMessage | null {
  const input = messageInputOf(message)
  if (!input) return null
  const peer = readOrNull(() => message.chat)
  const chat = peer ? chatInputOf(peer) : null
  if (chat && !keepsKind(chat.kind, channels)) return null
  return { chat, message: input, topic: topicInputOfAction(message) }
}

/** Writes a message the way a pushed one is: its chat first (followed if it is of a followed kind), its topic, then the message. */
export function writeMessage(mirror: Mirror, ctx: IngestContext, read: ReadMessage, channels: boolean): StoreOutcome {
  if (read.chat) rememberChats(mirror, [read.chat], ctx.now, channels)
  if (read.topic) upsertTopics(mirror, [read.topic], ctx.now)
  return storeMessage(mirror, ctx, read.message)
}
