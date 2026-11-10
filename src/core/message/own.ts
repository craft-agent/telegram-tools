import { existingChat, messageMedia } from "../chat/chat-rows"
import { ACTION_PAST, leftChat, noSuchMessage, notOwnMessage } from "../telegram/action-checks"
import type { Mirror } from "../telegram/mirror"
import type { MediaInfo } from "../telegram/mirror-input"
import { isDeleted, type ChatRow } from "../telegram/mirror-rows"

/** What the user does to a message of their own, for the words of a refusal. */
export type OwnAction = keyof typeof ACTION_PAST

/** What an action needs to know of the user's own message in the mirror. */
export type OwnMessage = {
  /** When it was sent, in milliseconds. */
  ts: number
  kind: "message" | "service"
  /** The text, or the caption of media. */
  body: string | null
  media: MediaInfo | null
  /** When it was last edited, in milliseconds; null for a message never edited. */
  edited: number | null
}

/** The chat an action is aimed at, and its message: null when the mirror was told the message is deleted. */
export type OwnTarget = { chat: ChatRow; message: OwnMessage | null }

type StoredOwn = { ts: number; from_me: number; kind: OwnMessage["kind"]; body: string | null }

/**
 * The chat and the message an action on the user's own message is aimed at,
 * as the sync service checks them before it asks Telegram, so that a call it
 * would refuse is refused here without a request. The chat must be one the
 * mirror has (`not_found`) and the account must not have left it
 * (`forbidden`). The message must be the user's own (`forbidden`) and one the
 * mirror holds: a message it has as deleted gives a null `message`, and any
 * other missing one is `not_found`, since a chat the mirror does not keep
 * holds no messages to check.
 */
export function findOwnMessage(mirror: Mirror, chatId: string, id: number, action: OwnAction): OwnTarget {
  const past = ACTION_PAST[action]
  const chat = existingChat(mirror, chatId)
  if (chat.left) throw leftChat(past)
  const row = mirror
    .prepare("SELECT ts, from_me, kind, body FROM messages WHERE chat = ? AND id = ?")
    .get(chatId, id) as StoredOwn | undefined
  if (!row) {
    if (isDeleted(mirror, chat, id)) return { chat, message: null }
    throw noSuchMessage(id, chat.followed, past)
  }
  if (row.from_me !== 1) throw notOwnMessage(past)
  const { media, edited } = messageMedia(mirror, chatId, id)!
  return { chat, message: { ts: row.ts, kind: row.kind, body: row.body, media, edited } }
}
