import { z } from "zod"
import { clampLimit, encodeCursor, fitItems, notACursor, readCursor } from "../pages"
import { ToolError } from "../errors"
import type { Mirror } from "../telegram/mirror"
import { chatEntry, existingChat, requireChatId } from "./chat-rows"
import { fingerprint } from "./filter"
import { messageEntries } from "./message"
import { cuttableMessage } from "./message-cut"
import { liveMessages, MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { DATA_NOTE } from "./message-schema"
import { olderThan, rangeConditions, readRange } from "./range"
import { LIMITS, type ChatReadInput, type ChatReadOutput } from "./schema"

/** Where a page of messages stops: the id of its oldest message, the chat it was read from, and the range it was made under. */
const viewCursor = z.strictObject({ id: z.number().int(), chat: z.string(), filter: z.string() })

/**
 * The `view` method: the newest messages of one chat between `after` and
 * `before` (both exclusive), returned oldest first. `next` continues with
 * older ones, from the oldest message returned.
 */
export function viewChat(
  mirror: Mirror,
  args: Pick<ChatReadInput, "chat" | "after" | "before" | "limit" | "cursor">,
  now: number,
): ChatReadOutput {
  const chatId = requireChatId(args.chat, "view")
  const limit = clampLimit(args.limit, LIMITS.view, "limit")
  const range = readRange(args)
  const filter = fingerprint(range.after, range.before)
  const older = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", viewCursor)
  if (older && (older.chat !== chatId || older.filter !== filter)) throw notACursor("cursor")
  const chat = existingChat(mirror, chatId)
  if (!chat.followed) {
    throw new ToolError("invalid_argument", "This chat is not mirrored; reading it live is not available yet.")
  }

  const bounds = rangeConditions(range)
  const live = liveMessages(now)
  const where = ["chat = ?", ...bounds.conditions, live.condition]
  const params: (string | number)[] = [chat.id, ...bounds.params, ...live.params]
  if (older) {
    const keyset = olderThan(older.id)
    where.push(keyset.condition)
    params.push(...keyset.params)
  }
  const fetched = mirror
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit + 1) as StoredMessage[]
  const page = fetched.slice(0, limit)

  const header = chatEntry(chat)
  const entries = messageEntries(mirror, page, now)
  const assemble = (shown: typeof entries) => ({ chat: header, messages: [...shown].reverse(), note: DATA_NOTE })
  const { items, stopped } = fitItems(assemble, entries, { cuttable: cuttableMessage })
  const result: ChatReadOutput = assemble(items)
  const oldest = page[items.length - 1]
  if (oldest && (stopped || fetched.length > limit)) {
    result.next = encodeCursor({ id: oldest.id, chat: chat.id, filter })
  }
  return result
}
