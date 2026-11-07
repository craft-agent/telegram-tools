import { PER_CHAT_KINDS, type ChatKind } from "./mirror-input"
import type { Mirror } from "./mirror"

/** The columns of a stored chat. */
export type ChatRow = {
  id: string
  kind: ChatKind
  name: string | null
  username: string | null
  forum: number
  left: number
  can_send: number | null
  archived: number
  followed: number
  unread: number
  read_max: number | null
  top_id: number | null
  last_ts: number | null
  ttl: number | null
  updated: number
}

/** The kinds whose message ids are numbered within the chat, as a SQL list; built from constants, never from input. */
export const PER_CHAT_KINDS_SQL = PER_CHAT_KINDS.map((kind) => `'${kind}'`).join(", ")

/** Whether the ids of this kind of chat are numbered within the chat (otherwise once for the account). */
export function isNumberedPerChat(kind: ChatKind): boolean {
  return PER_CHAT_KINDS.includes(kind)
}

/** A chat by id, or null. */
export function findChat(mirror: Mirror, id: string): ChatRow | null {
  return (mirror.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined) ?? null
}

/** JSON for a column, or null when there is nothing to store: no value, or an empty list. */
export function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return Array.isArray(value) && value.length === 0 ? null : JSON.stringify(value)
}

/**
 * Whether the mirror was told that this message of `chat` was deleted for
 * everyone: by a delete that named the chat, or, for a chat whose ids are
 * numbered for the whole account, by one that named none.
 */
export function isDeleted(mirror: Mirror, chat: ChatRow, id: number): boolean {
  const accountWide = Number(!isNumberedPerChat(chat.kind))
  const row = mirror
    .prepare("SELECT 1 FROM deleted WHERE id = ? AND (chat = ? OR (chat IS NULL AND ? = 1))")
    .get(id, chat.id, accountWide)
  return row !== undefined
}

/** Records that a message was deleted for everyone (`chat` null: in no named chat), so that nothing of it is stored if it arrives later. */
export function recordDeleted(mirror: Mirror, chat: string | null, id: number, now: number): void {
  mirror.prepare("INSERT OR REPLACE INTO deleted (chat, id, at) VALUES (?, ?, ?)").run(chat, id, now)
}
