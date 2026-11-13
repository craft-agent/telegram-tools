import { ToolError } from "../errors"
import { cutText } from "../pages"
import type { Mirror } from "../telegram/mirror"
import type { MediaInfo } from "../telegram/mirror-input"
import { findChat, type ChatRow } from "../telegram/mirror-rows"
import { isRecord } from "../telegram/service-errors"
import { formatLocalTime } from "../time"
import type { ChatEntry } from "./schema"
import { placeholders } from "./sql"

/** The most characters of a chat's name a result carries; a longer title is cut and says so. */
export const MAX_NAME_LENGTH = 1000

/** What a call that names a topic, or lists topics, says of a chat that is not a forum. */
export const NO_TOPICS_MESSAGE = "This chat has no topics."

export const UNKNOWN_CHAT_MESSAGE = "No chat with this id in this account's mirror; take a chat id from list."

/** A chat id: Telegram's signed id, such as `123456789` or `-1001234567890`. */
const CHAT_ID_PATTERN = /^-?\d+$/

/** A chat's name as a result carries it: cut to `MAX_NAME_LENGTH` characters, with `name_cut` set when it was. */
export function shownName(name: string | null): { name: string | null; name_cut?: true } {
  if (name === null || name.length <= MAX_NAME_LENGTH) return { name }
  return { name: cutText(name, MAX_NAME_LENGTH), name_cut: true }
}

/** A chat as a result carries it; `last_message` is added by the caller that has it. */
export function chatEntry(chat: ChatRow): ChatEntry {
  const entry: ChatEntry = {
    id: chat.id,
    kind: chat.kind,
    ...shownName(chat.name),
    mirrored: chat.followed === 1,
    unread: chat.unread,
    last_activity_at: chat.last_ts === null ? null : formatLocalTime(chat.last_ts),
  }
  if (chat.username) entry.username = chat.username
  if (chat.forum) entry.forum = true
  if (chat.archived) entry.archived = true
  if (chat.left) entry.left = true
  if (chat.can_send === 0) entry.can_send = false
  if (chat.ttl) entry.auto_delete_seconds = chat.ttl
  return entry
}

/** `chat` as a method's required argument: a chat id, else `invalid_argument` (a name, username or number is never a chat). */
export function requireChatId(chat: string | undefined, method: string): string {
  if (chat === undefined) {
    throw new ToolError("invalid_argument", `chat is required for ${method}: pass a chat id from list.`)
  }
  if (!CHAT_ID_PATTERN.test(chat)) {
    throw new ToolError(
      "invalid_argument",
      `chat must be a chat id (a number such as 123456789 or -1001234567890) from list; a name, username or phone number is not accepted by ${method}.`,
    )
  }
  return chat
}

/** The chat with this id, or `not_found` when this account's mirror has none. */
export function existingChat(mirror: Mirror, id: string): ChatRow {
  const chat = findChat(mirror, id)
  if (!chat) throw new ToolError("not_found", UNKNOWN_CHAT_MESSAGE)
  return chat
}

/** The title the mirror holds for a topic of a chat, or `undefined` when it has no such topic or no title for it. */
export function topicTitle(mirror: Mirror, chat: string, topic: number): string | undefined {
  const row = mirror.prepare("SELECT title FROM topics WHERE chat = ? AND id = ?").get(chat, topic) as
    { title: string | null } | undefined
  return row?.title ?? undefined
}

/** The media and the last edit time of a message the mirror has; `undefined` when it has no such message. */
export function messageMedia(
  mirror: Mirror,
  chat: string,
  id: number,
): { media: MediaInfo | null; edited: number | null } | undefined {
  const row = mirror.prepare("SELECT media, edited FROM messages WHERE chat = ? AND id = ?").get(chat, id) as
    { media: string | null; edited: number | null } | undefined
  if (!row) return undefined
  let media: unknown = null
  try {
    media = row.media ? JSON.parse(row.media) : null
  } catch {
    media = null
  }
  return { media: isRecord(media) && typeof media.type === "string" ? (media as MediaInfo) : null, edited: row.edited }
}

/** The chats with these ids that this mirror has, by id. */
export function findChats(mirror: Mirror, ids: readonly string[]): Map<string, ChatRow> {
  if (ids.length === 0) return new Map()
  const rows = mirror.prepare(`SELECT * FROM chats WHERE id IN (${placeholders(ids.length)})`).all(...ids) as ChatRow[]
  return new Map(rows.map((row) => [row.id, row]))
}
