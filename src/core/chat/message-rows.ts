import type { Mirror } from "../telegram/mirror"
import type { MessageInput } from "../telegram/mirror-input"
import type { ChatRow } from "../telegram/mirror-rows"
import { findChats } from "./chat-rows"
import { placeholders } from "./sql"

/** The columns of `messages` that a message entry is built from. */
export const MESSAGE_COLUMNS =
  "chat, id, topic, ts, from_me, sender, sender_name, kind, body, entities, media, action, reply, forward, grouped, reactions, edited, expires, view_once, self_destruct"

/** A stored message as `MESSAGE_COLUMNS` selects it. */
export type StoredMessage = {
  chat: string
  id: number
  topic: number | null
  ts: number
  from_me: number
  sender: string | null
  sender_name: string | null
  kind: MessageInput["kind"]
  body: string | null
  entities: string | null
  media: string | null
  action: string | null
  reply: string | null
  forward: string | null
  grouped: string | null
  reactions: string | null
  edited: number | null
  expires: number | null
  view_once: number
  self_destruct: number | null
}

/**
 * The SQL condition on `messages` for the rows a read may show at `now`: those
 * with no timer, whose timer has not run out, or that are kept. A message whose
 * timer ran out leaves with the next sweep of the service; until then a read
 * does not show it.
 */
export function liveMessages(now: number): { condition: string; params: number[] } {
  return { condition: "(expires IS NULL OR expires > ? OR kept = 1)", params: [now] }
}

/** A JSON column, read; null when it is empty or does not parse. */
export function readJson(json: string | null): unknown {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** A JSON column that holds a list; an empty one when it holds anything else. */
export function readList<T>(json: string | null): T[] {
  const value = readJson(json)
  return Array.isArray(value) ? (value as T[]) : []
}

/** One earlier version of an edited message, as `edits` stores it. */
export type StoredVersion = { at: number; body: string | null; media: string | null }

/** What a set of messages names or answers to, which other tables hold. */
export type Related = {
  /** The chats the messages are in, and the senders and forwards they name, by chat id. */
  chats: Map<string, ChatRow>
  /** The earlier versions of the edited ones, by `messageKey`. */
  versions: Map<string, StoredVersion[]>
  /** The text of the messages that others reply to, by `messageKey`. */
  replied: Map<string, RepliedText>
}

/** The key of a message across chats: its chat and its id in it. */
export function messageKey(chat: string, id: number): string {
  return `${chat}:${id}`
}

/** The ids by chat. */
type IdsByChat = Map<string, Set<number>>

function addId(ids: IdsByChat, chat: string, id: number): void {
  const found = ids.get(chat)
  if (found) found.add(id)
  else ids.set(chat, new Set([id]))
}

/** The earlier versions of messages, oldest first, one query per chat. */
function loadVersions(mirror: Mirror, wanted: IdsByChat): Map<string, StoredVersion[]> {
  const versions = new Map<string, StoredVersion[]>()
  for (const [chat, ids] of wanted) {
    const rows = mirror
      .prepare(
        `SELECT id, at, body, media FROM edits WHERE chat = ? AND id IN (${placeholders(ids.size)}) ORDER BY id, seq`,
      )
      .all(chat, ...ids) as (StoredVersion & { id: number })[]
    for (const { id, ...version } of rows) {
      const key = messageKey(chat, id)
      versions.set(key, [...(versions.get(key) ?? []), version])
    }
  }
  return versions
}

/** The text of a message replied to, and whether its sender meant it not to be kept (a timer, view-once or self-destruct). */
export type RepliedText = { text: string; private: boolean }

/** The text of the messages a read may show at `now`, by `messageKey`; a message without text is left out. */
function loadTexts(mirror: Mirror, wanted: IdsByChat, now: number): Map<string, RepliedText> {
  const live = liveMessages(now)
  const texts = new Map<string, RepliedText>()
  for (const [chat, ids] of wanted) {
    const rows = mirror
      .prepare(
        `SELECT id, body, (expires IS NOT NULL OR view_once = 1 OR coalesce(self_destruct, 0) > 0) AS private FROM messages WHERE chat = ? AND id IN (${placeholders(ids.size)}) AND body IS NOT NULL AND ${live.condition}`,
      )
      .all(chat, ...ids, ...live.params) as { id: number; body: string; private: number }[]
    for (const row of rows) texts.set(messageKey(chat, row.id), { text: row.body, private: row.private === 1 })
  }
  return texts
}

/**
 * The text of the messages among `rows` that a read may show at `now`, by
 * `messageKey`, as `loadTexts` finds them in the mirror. A kept message whose
 * timer ran out is left to the mirror, which knows it is kept.
 */
export function pageTexts(rows: readonly StoredMessage[], now: number): Map<string, RepliedText> {
  const texts = new Map<string, RepliedText>()
  for (const row of rows) {
    if (row.body === null || (row.expires !== null && row.expires <= now)) continue
    const isPrivate = row.expires !== null || row.view_once === 1 || (row.self_destruct ?? 0) > 0
    texts.set(messageKey(row.chat, row.id), { text: row.body, private: isPrivate })
  }
  return texts
}

/** A message of some chat, by its chat and its id in it. */
export type MessageRef = { chat: string; id: number }

/**
 * What `rows` need besides themselves, read in a few queries: the rows of the
 * chats `chats` names (each row's own chat too), the earlier versions of the
 * edited rows, and the text of the messages `replies` points at that a read
 * may show at `now` (see `liveMessages`).
 */
export function loadRelated(
  mirror: Mirror,
  rows: readonly StoredMessage[],
  chats: readonly string[],
  replies: readonly MessageRef[],
  now: number,
): Related {
  const edited: IdsByChat = new Map()
  for (const row of rows) if (row.edited !== null) addId(edited, row.chat, row.id)
  const replied: IdsByChat = new Map()
  for (const { chat, id } of replies) addId(replied, chat, id)
  return {
    chats: findChats(mirror, [...new Set([...rows.map((row) => row.chat), ...chats])]),
    versions: loadVersions(mirror, edited),
    replied: loadTexts(mirror, replied, now),
  }
}
