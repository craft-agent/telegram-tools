import { z } from "zod"
import { foldCase } from "../fold"
import { clampLimit, encodeCursor, fitItems, notACursor, readCursor, type Cuttable } from "../pages"
import type { Mirror } from "../telegram/mirror"
import type { ChatRow } from "../telegram/mirror-rows"
import { chatEntry } from "./chat-rows"
import { fingerprint } from "./filter"
import { messageEntries } from "./message"
import { cutMessage, dropMetadata, messageTextLength } from "./message-cut"
import { liveMessages, MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { DATA_NOTE } from "./message-schema"
import { LIMITS, type ChatEntry, type ChatReadInput, type ChatReadOutput } from "./schema"

/** Where a list stands in its order: the activity time (null for a chat with no message) and the id. */
type Position = { ts: number | null; id: string }

/**
 * Where a page of chats stops: the position of its last chat, and the filters
 * it was made under, since a cursor continues one list and no other.
 */
const listCursor = z.strictObject({ ts: z.number().int().nullable(), id: z.string(), filter: z.string() })

/** The chat's last message when it alone exceeds a result's budget is cut like any message. */
const cuttableChat: Cuttable<ChatEntry> = {
  size: (chat) => (chat.last_message ? messageTextLength(chat.last_message) : 0),
  cut: (chat, keep) => (chat.last_message ? { ...chat, last_message: cutMessage(chat.last_message, keep) } : chat),
  drop(chat) {
    const last = chat.last_message ? dropMetadata(chat.last_message) : null
    return last ? { ...chat, last_message: last } : null
  },
}

function positionOf(chat: ChatRow): Position {
  return { ts: chat.last_ts, id: chat.id }
}

/** Whether `a` comes before `b` in a list: newer activity first, a chat with none last, the smaller id among equals. */
function byActivity(a: Position, b: Position): number {
  if (a.ts !== b.ts) {
    if (a.ts === null) return 1
    if (b.ts === null) return -1
    return b.ts - a.ts
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The query as it is matched: folded, without blank space around it or a leading `@`. */
function foldQuery(query: string | undefined): string {
  return foldCase(query ?? "")
    .trim()
    .replace(/^@/, "")
}

/** Whether a chat's name or username holds the folded query. */
function matches(chat: ChatRow, query: string): boolean {
  return foldCase(chat.name ?? "").includes(query) || foldCase(chat.username ?? "").includes(query)
}

/** The newest mirrored message of each of `chats` that has one. */
function lastMessages(mirror: Mirror, chats: readonly ChatRow[], now: number): StoredMessage[] {
  const live = liveMessages(now)
  const newest = mirror.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat = ? AND ${live.condition} ORDER BY id DESC LIMIT 1`,
  )
  return chats.flatMap((chat) => (newest.get(chat.id, ...live.params) as StoredMessage | undefined) ?? [])
}

/** Adds `last_message` to each entry: its chat's newest mirrored message, or null. */
function addLastMessages(mirror: Mirror, chats: readonly ChatRow[], entries: ChatEntry[], now: number): void {
  const rows = lastMessages(mirror, chats, now)
  const built = new Map(messageEntries(mirror, rows, now).map((entry, index) => [rows[index]!.chat, entry]))
  for (const entry of entries) entry.last_message = built.get(entry.id) ?? null
}

/**
 * The `list` method: chats newest activity first, a chat with none last,
 * optionally those whose name or username holds `query`, or that have unread
 * messages, each with its last message on request. Pages by a keyset cursor
 * over (activity, id), so a chat that gains a message between pages is not
 * shown twice.
 */
export function listChats(
  mirror: Mirror,
  args: Pick<ChatReadInput, "query" | "unread" | "last" | "limit" | "cursor">,
  now: number,
): ChatReadOutput {
  const limit = clampLimit(args.limit, LIMITS.list, "limit")
  const query = foldQuery(args.query)
  const unreadOnly = args.unread === true
  const after = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", listCursor)
  const filter = fingerprint(query, unreadOnly)
  if (after && after.filter !== filter) throw notACursor("cursor")
  let chats = (mirror.prepare("SELECT * FROM chats").all() as ChatRow[]).sort((a, b) =>
    byActivity(positionOf(a), positionOf(b)),
  )
  if (after) chats = chats.filter((chat) => byActivity(positionOf(chat), after) > 0)
  if (unreadOnly) chats = chats.filter((chat) => chat.unread > 0)
  if (query !== "") chats = chats.filter((chat) => matches(chat, query))
  const page = chats.slice(0, limit)
  const entries = page.map(chatEntry)
  if (args.last) addLastMessages(mirror, page, entries, now)
  const { items, stopped } = fitItems((fitting) => ({ chats: fitting, note: DATA_NOTE }), entries, {
    cuttable: cuttableChat,
  })
  const result: ChatReadOutput = { chats: items, note: DATA_NOTE }
  const lastShown = page[items.length - 1]
  if (lastShown && (stopped || chats.length > limit)) {
    result.next = encodeCursor({ ...positionOf(lastShown), filter })
  }
  return result
}
