import { z } from "zod"
import { clampLimit, encodeCursor, fitItems, notACursor, readCursor } from "../pages"
import { ToolError } from "../errors"
import type { Mirror } from "../telegram/mirror"
import type { ChatRow } from "../telegram/mirror-rows"
import { HISTORY_LIMIT, type HistoryParams, type HistoryResult } from "../telegram/service-requests"
import { chatEntry, existingChat, NO_TOPICS_MESSAGE, requireChatId } from "./chat-rows"
import { fingerprint } from "./filter"
import { storedMessage } from "./live"
import { messageEntries } from "./message"
import { cuttableMessage } from "./message-cut"
import { liveMessages, MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { DATA_NOTE } from "./message-schema"
import { olderThan, rangeConditions, readRange } from "./range"
import { GENERAL_TOPIC, LIMITS, type ChatReadInput, type ChatReadOutput } from "./schema"

/**
 * Where a page of messages stops: the id of its oldest message, the chat it was
 * read from, the range and topic it was made under, and whether it was read
 * live, since a cursor continues one read and no other.
 */
const viewCursor = z.strictObject({ id: z.number().int(), chat: z.string(), filter: z.string(), live: z.boolean() })

/** A page of a chat the mirror does not keep, to be asked of the service: what to ask, and what the result needs of the question. */
export type LiveRead = { chat: ChatRow; request: HistoryParams; filter: string }

/** What `view` could answer from the mirror alone, or the live read it needs the service for. */
export type ViewPlan = { output: ChatReadOutput } | { live: LiveRead }

/** The messages of a page as the result carries them, with a `next` when older ones remain or the page was cut to fit. */
function viewPage(
  mirror: Mirror,
  chat: ChatRow,
  page: readonly StoredMessage[],
  more: boolean,
  filter: string,
  live: boolean,
  now: number,
): ChatReadOutput {
  const header = chatEntry(chat)
  const entries = messageEntries(mirror, page, now)
  const assemble = (shown: typeof entries): ChatReadOutput => ({
    chat: header,
    messages: [...shown].reverse(),
    ...(live ? { live: true as const } : {}),
    note: DATA_NOTE,
  })
  const { items, stopped } = fitItems(assemble, entries, { cuttable: cuttableMessage })
  const result = assemble(items)
  const oldest = page[items.length - 1]
  if (oldest && (stopped || more)) {
    result.next = encodeCursor({ id: oldest.id, chat: chat.id, filter, live })
  }
  return result
}

/**
 * The `view` method: the newest messages of one chat between `after` and
 * `before` (both exclusive), returned oldest first, only those of `topic`
 * when it is given. `next` continues with older ones, from the oldest message
 * returned. A chat the mirror keeps is read from the mirror; one it lists and
 * does not keep needs a live read (`liveView` finishes it).
 */
export function viewChat(
  mirror: Mirror,
  args: Pick<ChatReadInput, "chat" | "topic" | "after" | "before" | "limit" | "cursor">,
  now: number,
): ViewPlan {
  const chatId = requireChatId(args.chat, "view")
  const limit = clampLimit(args.limit, LIMITS.view, "limit")
  const range = readRange(args)
  const filter = fingerprint(range.after, range.before, args.topic)
  const older = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", viewCursor)
  if (older && (older.chat !== chatId || older.filter !== filter)) throw notACursor("cursor")
  const chat = existingChat(mirror, chatId)
  if (args.topic !== undefined && !chat.forum) throw new ToolError("invalid_argument", NO_TOPICS_MESSAGE)
  const live = !chat.followed
  if (older && older.live !== live) throw notACursor("cursor")

  if (live) {
    const request: HistoryParams = { chat: chat.id, limit: Math.min(limit, HISTORY_LIMIT) }
    if (args.topic !== undefined) request.topic = args.topic
    if (older) request.before_id = older.id
    if (range.after !== undefined) request.after = range.after
    if (range.before !== undefined) request.before = range.before
    return { live: { chat, request, filter } }
  }

  const bounds = rangeConditions(range)
  const shown = liveMessages(now)
  const where = ["chat = ?", ...bounds.conditions, shown.condition]
  const params: (string | number)[] = [chat.id, ...bounds.params, ...shown.params]
  if (args.topic !== undefined) {
    where.push(args.topic === GENERAL_TOPIC ? "(topic IS NULL OR topic = ?)" : "topic = ?")
    params.push(args.topic)
  }
  if (older) {
    const keyset = olderThan(older.id)
    where.push(keyset.condition)
    params.push(...keyset.params)
  }
  const fetched = mirror
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit + 1) as StoredMessage[]
  const output = viewPage(mirror, chat, fetched.slice(0, limit), fetched.length > limit, filter, false, now)
  return { output }
}

/**
 * The result of a live `view`, from what the service returned (newest first).
 * The mirror is read only for the names and texts the messages refer to.
 */
export function liveView(mirror: Mirror, read: LiveRead, page: HistoryResult, now: number): ChatReadOutput {
  return viewPage(mirror, read.chat, page.messages.map(storedMessage), page.more, read.filter, true, now)
}
