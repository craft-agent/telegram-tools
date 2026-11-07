import {
  isChatId,
  isChatInput,
  isCount,
  isReadInput,
  isTopicInput,
  type ChatInput,
  type ReadInput,
  type TopicInput,
} from "./mirror-input"
import type { Mirror } from "./mirror"
import { findChat, type ChatRow } from "./mirror-rows"

/** The larger of two optional numbers; null when neither is given. */
function grown(stored: number | null, given: number | null | undefined): number | null {
  if (!isCount(given)) return stored
  return stored === null ? given : Math.max(stored, given)
}

/** A flag from the input, else the stored one, else off. */
function flag(given: boolean | undefined, stored: number | undefined): number {
  return given === undefined ? (stored ?? 0) : Number(given)
}

/** A flag that can be unknown: absent keeps the stored one, `null` makes it unknown. */
function nullableFlag(given: boolean | null | undefined, stored: number | null | undefined): number | null {
  if (given === undefined) return stored ?? null
  return given === null ? null : Number(given)
}

/** The row a chat becomes: the stored one with what the input gives, or a new one. */
function mergeChat(stored: ChatRow | null, chat: ChatInput, now: number): Omit<ChatRow, "followed"> {
  return {
    id: chat.id,
    kind: chat.kind,
    name: chat.name ?? stored?.name ?? null,
    username: chat.username ?? null,
    forum: flag(chat.forum, stored?.forum),
    left: flag(chat.left, stored?.left),
    can_send: nullableFlag(chat.canSend, stored?.can_send),
    archived: flag(chat.archived, stored?.archived),
    unread: isCount(chat.unread) ? chat.unread : (stored?.unread ?? 0),
    read_max: grown(stored?.read_max ?? null, chat.readMax),
    top_id: grown(stored?.top_id ?? null, chat.topId),
    last_ts: grown(stored?.last_ts ?? null, chat.lastTs),
    ttl: chat.ttl === undefined ? (stored?.ttl ?? null) : isCount(chat.ttl) ? chat.ttl : null,
    updated: now,
  }
}

/**
 * Inserts or updates chats. An optional field the input leaves out keeps its
 * stored value; `topId`, `lastTs` and `readMax` only grow; a missing `name`
 * keeps the stored one, while `username` is taken as given since a chat can
 * lose it. Never touches `followed`. Malformed chats are skipped.
 */
export function upsertChats(mirror: Mirror, chats: ChatInput[], now: number): void {
  const upsert = mirror.prepare(
    `INSERT INTO chats (id, kind, name, username, forum, left, can_send, archived, unread, read_max, top_id,
       last_ts, ttl, updated)
     VALUES (:id, :kind, :name, :username, :forum, :left, :can_send, :archived, :unread, :read_max, :top_id,
       :last_ts, :ttl, :updated)
     ON CONFLICT (id) DO UPDATE SET
       kind = excluded.kind, name = excluded.name, username = excluded.username, forum = excluded.forum,
       left = excluded.left, can_send = excluded.can_send, archived = excluded.archived, unread = excluded.unread,
       read_max = excluded.read_max, top_id = excluded.top_id, last_ts = excluded.last_ts, ttl = excluded.ttl,
       updated = excluded.updated`,
  )
  for (const chat of chats) {
    if (!isChatInput(chat)) continue
    upsert.run(mergeChat(findChat(mirror, chat.id), chat, now))
  }
}

/**
 * Sets whether the mirror keeps a chat's messages. Turning it off deletes the
 * chat's messages and their earlier versions, since the mirror holds only what
 * it keeps current; the chat's row and its topics stay. Does nothing for a
 * chat the mirror does not know. A chat that is `left` keeps its history: only
 * this call deletes.
 */
export function setFollowed(mirror: Mirror, chat: string, followed: boolean): void {
  if (!isChatId(chat) || !findChat(mirror, chat)) return
  mirror.prepare("UPDATE chats SET followed = ? WHERE id = ?").run(Number(followed), chat)
  if (followed) return
  mirror.prepare("DELETE FROM edits WHERE chat = ?").run(chat)
  mirror.prepare("DELETE FROM messages WHERE chat = ?").run(chat)
}

/** Inserts or updates forum topics; absent fields keep stored values. Malformed topics are skipped. */
export function upsertTopics(mirror: Mirror, topics: TopicInput[], now: number): void {
  const upsert = mirror.prepare(
    `INSERT INTO topics (chat, id, title, closed, updated) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (chat, id) DO UPDATE SET
        title = CASE WHEN ? THEN excluded.title ELSE topics.title END,
        closed = CASE WHEN ? THEN excluded.closed ELSE topics.closed END, updated = excluded.updated`,
  )
  for (const topic of topics) {
    if (!isTopicInput(topic)) continue
    upsert.run(
      topic.chat,
      topic.id,
      topic.title ?? null,
      Number(topic.closed ?? false),
      now,
      Number(topic.title !== undefined),
      Number(topic.closed !== undefined),
    )
  }
}

/** The user read a chat on another device: `read_max` grows, and `unread` is set when the input knows it. */
export function applyRead(mirror: Mirror, read: ReadInput): void {
  if (!isReadInput(read)) return
  const unread = isCount(read.unread) ? read.unread : null
  mirror
    .prepare("UPDATE chats SET read_max = MAX(COALESCE(read_max, 0), ?), unread = COALESCE(?, unread) WHERE id = ?")
    .run(read.maxId, unread, read.chat)
}
