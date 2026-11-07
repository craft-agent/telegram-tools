import { z } from "zod"
import { ToolError } from "../errors"
import { clampLimit, encodeCursor, notACursor, readCursor } from "../pages"
import type { Mirror } from "../telegram/mirror"
import type { ChatRow } from "../telegram/mirror-rows"
import type { TopicInfo, TopicsOffset, TopicsParams, TopicsResult } from "../telegram/service-requests"
import { formatLocalTime } from "../time"
import { chatEntry, existingChat, NO_TOPICS_MESSAGE, requireChatId } from "./chat-rows"
import { DATA_NOTE } from "./message-schema"
import { LIMITS, type ChatReadInput, type ChatReadOutput, type TopicEntry } from "./schema"

const topicsOffsetSchema: z.ZodType<TopicsOffset> = z.strictObject({
  date: z.number().int(),
  id: z.number().int(),
  topic: z.number().int(),
})

/** Where a page of topics stops, as Telegram pages them, and the chat it was read from. */
const topicsCursor = z.strictObject({
  chat: z.string(),
  offset: topicsOffsetSchema,
})

/** A request for a page of a forum's topics, and the chat it is for. */
export type TopicsRead = { chat: ChatRow; request: TopicsParams }

function topicEntry(topic: TopicInfo): TopicEntry {
  const entry: TopicEntry = {
    id: topic.id,
    title: topic.title,
    unread: topic.unread,
    last_activity_at: topic.last_ts === null ? null : formatLocalTime(topic.last_ts),
  }
  if (topic.closed) entry.closed = true
  if (topic.pinned) entry.pinned = true
  return entry
}

/**
 * The `topics` method, first part: checks that the mirror lists the chat as a
 * forum and works out what to ask the service. The mirror is not needed
 * afterwards, so it can be closed before the request.
 */
export function planTopics(mirror: Mirror, args: Pick<ChatReadInput, "chat" | "limit" | "cursor">): TopicsRead {
  const chatId = requireChatId(args.chat, "topics")
  const limit = clampLimit(args.limit, LIMITS.topics, "limit")
  const from = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", topicsCursor)
  if (from && from.chat !== chatId) throw notACursor("cursor")
  const chat = existingChat(mirror, chatId)
  if (!chat.forum) throw new ToolError("not_found", NO_TOPICS_MESSAGE)
  const request: TopicsParams = { chat: chat.id, limit }
  if (from) request.offset = from.offset
  return { chat, request }
}

/** The `topics` method, second part: the service's page of topics as a result, with a `next` when more remain. */
export function topicsResult(read: TopicsRead, page: TopicsResult): ChatReadOutput {
  const result: ChatReadOutput = {
    chat: chatEntry(read.chat),
    topics: page.topics.map(topicEntry),
    note: DATA_NOTE,
  }
  if (page.next) {
    result.next = encodeCursor({ chat: read.chat.id, offset: page.next })
  }
  return result
}
