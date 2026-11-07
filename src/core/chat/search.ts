import { z } from "zod"
import { ToolError } from "../errors"
import { clampLimit, cutText, encodeCursor, fitItems, notACursor, readCursor } from "../pages"
import type { Mirror } from "../telegram/mirror"
import type { ChatRow } from "../telegram/mirror-rows"
import { formatLocalTime } from "../time"
import { existingChat, findChats, MAX_NAME_LENGTH, requireChatId } from "./chat-rows"
import { fingerprint } from "./filter"
import { messageEntries } from "./message"
import { cuttableMessage } from "./message-cut"
import { liveMessages, MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { DATA_NOTE, type MessageEntry } from "./message-schema"
import { rangeConditions, readRange } from "./range"
import { LIMITS, type ChatReadInput, type ChatReadOutput } from "./schema"
import { matchesAllWords, searchWords } from "./search-match"

/** How a search walks the history: this many messages per query, and at most this many looked through per call. */
export type ScanLimits = { chunk: number; maxScanned: number }

/** Default limits on a search scan: rows per chunk and maximum rows looked through per call. */
export const SCAN_LIMITS: ScanLimits = { chunk: 1000, maxScanned: 20_000 }

/** What a search result says it covers: the mirror, and so not the chats or the history the mirror lacks. */
export const SEARCH_SCOPE =
  "The mirror only: chats it does not keep, and history from before it began keeping a chat, are not searched; a history fetch adds older history."

/** What a search of one chat that the mirror does not keep says. */
const NOT_MIRRORED_MESSAGE = "Search reads the mirror only, which does not keep this chat; read it with view."

/** Where a search stands in its order, newest first: a message's time, chat and id. */
type Position = { ts: number; chat: string; id: number }

/** Where a page of hits stops: the position of the last message looked through, and the search it belongs to. */
const searchCursor = z.strictObject({
  ts: z.number().int(),
  chat: z.string(),
  id: z.number().int(),
  filter: z.string(),
})

/** What a search looks through: the conditions on `messages` that every chunk shares, and their parameters. */
export type ScanScope = { conditions: string[]; params: (string | number)[] }

function positionOf(row: StoredMessage): Position {
  return { ts: row.ts, chat: row.chat, id: row.id }
}

/**
 * The query for the chunk of messages, newest first, that follows `after`.
 * Across every chat it is served in order by the `messages_time` index, which
 * also seeks to `after`, so a chunk costs its own rows and not the history
 * before it.
 */
export function chunkStatement(
  scope: ScanScope,
  after: Position | undefined,
): { sql: string; params: (string | number)[] } {
  const conditions = [...scope.conditions]
  const params = [...scope.params]
  if (after) {
    conditions.push("(ts, chat, id) < (?, ?, ?)")
    params.push(after.ts, after.chat, after.id)
  }
  const sql = `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${conditions.join(" AND ")} ORDER BY ts DESC, chat DESC, id DESC LIMIT ?`
  return { sql, params }
}

/** The messages, newest first, that may hold hits, a chunk at a time from `after`; `more` says whether older ones remain. */
function nextChunk(
  mirror: Mirror,
  scope: ScanScope,
  after: Position | undefined,
  chunk: number,
): { rows: StoredMessage[]; more: boolean } {
  const { sql, params } = chunkStatement(scope, after)
  const rows = mirror.prepare(sql).all(...params, chunk + 1) as StoredMessage[]
  return { rows: rows.slice(0, chunk), more: rows.length > chunk }
}

/** The chat a search is limited to: unknown is `not_found`, one the mirror does not keep `invalid_argument`. */
function searchedChat(mirror: Mirror, chat: string | undefined): ChatRow | undefined {
  if (chat === undefined) return undefined
  const found = existingChat(mirror, requireChatId(chat, "search"))
  if (!found.followed) throw new ToolError("invalid_argument", NOT_MIRRORED_MESSAGE)
  return found
}

/** The entries for `hits` with the id and the name of the chat each is in. */
function hitEntries(mirror: Mirror, hits: readonly StoredMessage[], now: number): MessageEntry[] {
  const entries = messageEntries(mirror, hits, now)
  const chats = findChats(mirror, [...new Set(hits.map((hit) => hit.chat))])
  entries.forEach((entry, index) => {
    const id = hits[index]!.chat
    entry.chat = id
    const name = chats.get(id)?.name
    if (name) entry.chat_name = cutText(name, MAX_NAME_LENGTH)
  })
  return entries
}

/**
 * The `search` method: messages, newest first, whose text, caption or file
 * name hold every word of `query` (case and width folded), in one chat of the
 * mirror or in all, between `after` and `before`.
 *
 * The history is walked in chunks by (time, chat, id) until the page is full,
 * the history ends, or `scan.maxScanned` messages have been looked through.
 * A full page returns a `next` from its last hit, which may lead to an empty
 * page when nothing older matches. Stopping at the scan limit returns the hits
 * found so far with `scanned_to`, the time reached, and a `next` that
 * continues from there.
 */
export function searchMessages(
  mirror: Mirror,
  args: Pick<ChatReadInput, "query" | "chat" | "after" | "before" | "limit" | "cursor">,
  now: number,
  scan: ScanLimits = SCAN_LIMITS,
): ChatReadOutput {
  const words = searchWords(args.query)
  const chat = searchedChat(mirror, args.chat)
  const limit = clampLimit(args.limit, LIMITS.search, "limit")
  const range = readRange(args)
  const filter = fingerprint([...words].sort(), chat?.id ?? null, range.after ?? null, range.before ?? null)
  const resume = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", searchCursor)
  if (resume && resume.filter !== filter) throw notACursor("cursor")

  const shown = liveMessages(now)
  const bounds = rangeConditions(range)
  const base: ScanScope = {
    conditions: ["kind = 'message'", shown.condition, ...(chat ? ["chat = ?"] : []), ...bounds.conditions],
    params: [...shown.params, ...(chat ? [chat.id] : []), ...bounds.params],
  }
  const hits: StoredMessage[] = []
  let position: Position | undefined = resume && { ts: resume.ts, chat: resume.chat, id: resume.id }
  let scanned = 0
  let lastScanned: StoredMessage | undefined
  let exhausted = false
  let full = false
  walk: for (;;) {
    const { rows, more } = nextChunk(mirror, base, position, scan.chunk)
    for (const [index, row] of rows.entries()) {
      scanned += 1
      lastScanned = row
      if (matchesAllWords(row, words)) hits.push(row)
      const rowsRemain = more || index < rows.length - 1
      if (hits.length >= limit && rowsRemain) {
        full = true
        break walk
      }
      if (scanned >= scan.maxScanned && rowsRemain) break walk
    }
    if (!more) {
      exhausted = true
      break
    }
    position = lastScanned && positionOf(lastScanned)
  }

  const entries = hitEntries(mirror, hits, now)
  const { items, stopped } = fitItems(
    (fitting) => ({ messages: fitting, scope: SEARCH_SCOPE, note: DATA_NOTE }),
    entries,
    { cuttable: cuttableMessage },
  )
  const result: ChatReadOutput = { messages: items, scope: SEARCH_SCOPE, note: DATA_NOTE }
  let next: Position | undefined
  if (stopped || full) next = positionOf(hits[items.length - 1]!)
  else if (!exhausted && lastScanned) {
    next = positionOf(lastScanned)
    result.scanned_to = formatLocalTime(lastScanned.ts)
  }
  if (next) result.next = encodeCursor({ ...next, filter })
  return result
}
