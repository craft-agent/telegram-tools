import { ToolError } from "../errors"
import { fitItems } from "../pages"
import type { Mirror } from "../telegram/mirror"
import type { ChatRow } from "../telegram/mirror-rows"
import type { AroundParams, AroundResult } from "../telegram/service-requests"
import { chatEntry, existingChat, NO_TOPICS_MESSAGE, requireChatId } from "./chat-rows"
import { storedMessage } from "./live"
import { messageEntries } from "./message"
import { cuttableMessage } from "./message-cut"
import { inTopic, liveMessages, MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { DATA_NOTE, type MessageEntry } from "./message-schema"
import { AROUND_COUNT, type ChatReadInput, type ChatReadOutput } from "./schema"

/** Room kept in an `around` result for the counts of what was left out. */
const TRIMMED_RESERVE = 100

/** What a call that names a message the chat does not have says. */
const NO_MESSAGE = "No message with this id in this chat."

/** A read of the messages around one in a chat the mirror does not keep, to be asked of the service. */
export type LiveAround = { chat: ChatRow; request: AroundParams }

/** What `around` could answer from the mirror alone, or the live read it needs the service for. */
export type AroundPlan = { output: ChatReadOutput } | { live: LiveAround }

/** The messages around the anchor: the anchor, and the older and the newer ones, each nearest the anchor first. */
type Neighbours = { anchor: StoredMessage; older: StoredMessage[]; newer: StoredMessage[] }

/** A count argument: its default when absent, the most when above it, `invalid_argument` below 0. */
function countArgument(count: number | undefined, name: string): number {
  if (count === undefined) return AROUND_COUNT.default
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ToolError(
      "invalid_argument",
      `${name} must be a whole number from 0 to ${AROUND_COUNT.max}; 0 asks for none.`,
    )
  }
  return Math.min(count, AROUND_COUNT.max)
}

/** The anchor and the messages around it in the mirror's chat, as `view` would show them: no hidden message, only the topic given. */
function mirrorNeighbours(
  mirror: Mirror,
  chat: ChatRow,
  args: { id: number; topic?: number; beforeCount: number; afterCount: number },
  now: number,
): Neighbours {
  const shown = liveMessages(now)
  const where = ["chat = ?", shown.condition]
  const params: (string | number)[] = [chat.id, ...shown.params]
  if (args.topic !== undefined) {
    const topic = inTopic(args.topic)
    where.push(topic.condition)
    params.push(...topic.params)
  }
  const anchor = mirror
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where.join(" AND ")} AND id = ?`)
    .get(...params, args.id) as StoredMessage | undefined
  if (!anchor) throw new ToolError("not_found", NO_MESSAGE)
  const side = (comparison: "<" | ">", order: "DESC" | "ASC", count: number) =>
    mirror
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where.join(" AND ")} AND id ${comparison} ? ORDER BY id ${order} LIMIT ?`,
      )
      .all(...params, args.id, count) as StoredMessage[]
  return { anchor, older: side("<", "DESC", args.beforeCount), newer: side(">", "ASC", args.afterCount) }
}

/**
 * The result: the anchor first among the candidates, then the others by
 * distance from it, one side then the other, so that trimming takes the
 * farthest from both ends evenly, and the messages in the order of the chat.
 * An entry may come back cut, so each is looked up by its id.
 */
function aroundResult(
  mirror: Mirror,
  chat: ChatRow,
  { anchor, older, newer }: Neighbours,
  live: boolean,
  now: number,
): ChatReadOutput {
  const entries = messageEntries(mirror, [anchor, ...older, ...newer], now)
  const anchorEntry = entries[0]!
  const olderEntries = entries.slice(1, 1 + older.length)
  const newerEntries = entries.slice(1 + older.length)

  const candidates: MessageEntry[] = [anchorEntry]
  for (let distance = 0; distance < Math.max(olderEntries.length, newerEntries.length); distance += 1) {
    const before = olderEntries[distance]
    const after = newerEntries[distance]
    if (before) candidates.push(before)
    if (after) candidates.push(after)
  }
  // Where each message sits relative to the anchor: negative before it, positive after it.
  const place = new Map<number, number>([
    ...olderEntries.map((entry, distance): [number, number] => [entry.id, -(distance + 1)]),
    [anchorEntry.id, 0],
    ...newerEntries.map((entry, distance): [number, number] => [entry.id, distance + 1]),
  ])
  const header = chatEntry(chat)
  const assemble = (shown: MessageEntry[]): ChatReadOutput => ({
    chat: header,
    anchor: anchorEntry.id,
    messages: [...shown].sort((a, b) => place.get(a.id)! - place.get(b.id)!),
    ...(live ? { live: true as const } : {}),
    note: DATA_NOTE,
  })
  const { items } = fitItems(assemble, candidates, { cuttable: cuttableMessage, reserve: TRIMMED_RESERVE })
  const result = assemble(items)
  const keptBefore = items.filter((entry) => place.get(entry.id)! < 0).length
  const keptAfter = items.filter((entry) => place.get(entry.id)! > 0).length
  if (keptBefore < olderEntries.length) result.trimmed_before = olderEntries.length - keptBefore
  if (keptAfter < newerEntries.length) result.trimmed_after = newerEntries.length - keptAfter
  return result
}

/**
 * The `around` method: the message `id` of a chat with up to `before_count`
 * messages before it and `after_count` after it, oldest first, only those of
 * `topic` when it is given. When they do not fit in a result, the anchor stays
 * and the messages farthest from it go, alternately from the two sides, and
 * the result counts what was left out under `trimmed_before` and
 * `trimmed_after`. There is no cursor: ask again with the id of the message at
 * the edge to read further. A chat the mirror keeps is read from the mirror;
 * one it lists and does not keep needs a live read (`liveAround` finishes it).
 */
export function aroundChat(
  mirror: Mirror,
  args: Pick<ChatReadInput, "chat" | "id" | "before_count" | "after_count" | "topic">,
  now: number,
): AroundPlan {
  const chatId = requireChatId(args.chat, "around")
  if (args.id === undefined) {
    throw new ToolError("invalid_argument", "id is required for around: pass the id of a message.")
  }
  const beforeCount = countArgument(args.before_count, "before_count")
  const afterCount = countArgument(args.after_count, "after_count")
  const chat = existingChat(mirror, chatId)
  if (args.topic !== undefined && !chat.forum) throw new ToolError("invalid_argument", NO_TOPICS_MESSAGE)

  if (!chat.followed) {
    const request: AroundParams = {
      chat: chat.id,
      id: args.id,
      before_count: beforeCount,
      after_count: afterCount,
    }
    if (args.topic !== undefined) request.topic = args.topic
    return { live: { chat, request } }
  }

  const neighbours = mirrorNeighbours(mirror, chat, { id: args.id, topic: args.topic, beforeCount, afterCount }, now)
  return { output: aroundResult(mirror, chat, neighbours, false, now) }
}

/**
 * The result of a live `around`, from what the service returned. The mirror is
 * read only for the names and texts the messages refer to. The messages are
 * ordered by id around the anchor, and a side is held to the count asked for.
 */
export function liveAround(mirror: Mirror, read: LiveAround, found: AroundResult, now: number): ChatReadOutput {
  const rows = found.messages.map(storedMessage)
  const anchor = rows.find((row) => row.id === read.request.id)
  if (!anchor) throw new ToolError("not_found", NO_MESSAGE)
  const older = rows.filter((row) => row.id < anchor.id).sort((a, b) => b.id - a.id)
  const newer = rows.filter((row) => row.id > anchor.id).sort((a, b) => a.id - b.id)
  const neighbours: Neighbours = {
    anchor,
    older: older.slice(0, read.request.before_count),
    newer: newer.slice(0, read.request.after_count),
  }
  return aroundResult(mirror, read.chat, neighbours, true, now)
}
