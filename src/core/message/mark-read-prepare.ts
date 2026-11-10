import { topicTitle } from "../chat/chat-rows"
import { ACTION_PAST, checkInTopic, checkTopicChat } from "../telegram/action-checks"
import type { Mirror } from "../telegram/mirror"
import type { MarkReadParams } from "../telegram/service-requests"
import type { ChatRow } from "../telegram/mirror-rows"
import { findAnyMessage } from "./own"

/** The chat a read mark is aimed at, and the title the mirror holds for the topic it names. */
export type MarkReadTarget = { chat: ChatRow; topicTitle: string | undefined }

/**
 * Checks in the mirror, as the sync service does, that a chat can be marked
 * read up to a message: `invalid_argument` for a topic in a chat without
 * topics and for a message outside the topic. See `findAnyMessage` for the
 * rest.
 */
export function prepareMarkRead(
  mirror: Mirror,
  chatId: string,
  { up_to, topic }: Pick<MarkReadParams, "up_to" | "topic">,
): MarkReadTarget {
  const { chat, message } = findAnyMessage(mirror, chatId, up_to, "markRead")
  checkTopicChat(chat, topic, ACTION_PAST.markRead)
  checkInTopic(message.topic, topic, ACTION_PAST.markRead)
  return { chat, topicTitle: topic === undefined ? undefined : topicTitle(mirror, chatId, topic) }
}
