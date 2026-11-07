import { ToolError } from "../errors"
import { isChatId, isCount } from "./mirror-input"
import { isRecord } from "./service-errors"
import {
  HISTORY_LIMIT,
  TOPICS_LIMIT,
  type HistoryParams,
  type TopicsOffset,
  type TopicsParams,
} from "./service-requests"

/** The largest number Telegram takes for an id, a count or a time in seconds (a signed 32-bit integer). */
export const INT32_MAX = 2 ** 31 - 1

const HISTORY_KEYS = ["chat", "limit", "topic", "before_id", "after", "before"]
const TOPICS_KEYS = ["chat", "limit", "offset"]
const OFFSET_KEYS = ["date", "id", "topic"]

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** `value` as an object holding only the `allowed` keys; an unknown key is refused without being echoed. */
function recordOf(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${what} must be an object.`)
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid(`${what} has a field it does not take.`)
  return value
}

/** The number at `key`, when it is one `fits`; `what` says what it must be. */
function numberAt(
  fields: Record<string, unknown>,
  key: string,
  fits: (value: number) => boolean,
  what: string,
): number {
  const value = fields[key]
  if (typeof value !== "number" || !fits(value)) throw invalid(`${key} must be ${what}.`)
  return value
}

/** Like `numberAt`, but a missing field gives undefined. */
function optionalNumberAt(
  fields: Record<string, unknown>,
  key: string,
  fits: (value: number) => boolean,
  what: string,
): number | undefined {
  return fields[key] === undefined ? undefined : numberAt(fields, key, fits, what)
}

const isIdNumber = (value: number) => isCount(value) && value >= 1 && value <= INT32_MAX
const isTelegramCount = (value: number) => isCount(value) && value <= INT32_MAX
const isLimitUpTo = (max: number) => (value: number) => isCount(value) && value >= 1 && value <= max

const ID_TEXT = "a positive integer"
const COUNT_TEXT = "a non-negative integer"

function chatAt(fields: Record<string, unknown>): string {
  const { chat } = fields
  if (!isChatId(chat)) throw invalid("chat must be a chat id as text.")
  return chat
}

/** The parameters of a `history` request, checked; anything off is `invalid_argument`. */
export function parseHistoryParams(params: unknown): HistoryParams {
  const fields = recordOf(params, HISTORY_KEYS, "The history parameters")
  const parsed: HistoryParams = {
    chat: chatAt(fields),
    limit: numberAt(fields, "limit", isLimitUpTo(HISTORY_LIMIT), `an integer from 1 to ${HISTORY_LIMIT}`),
  }
  const topic = optionalNumberAt(fields, "topic", isIdNumber, ID_TEXT)
  const beforeId = optionalNumberAt(fields, "before_id", isIdNumber, ID_TEXT)
  const after = optionalNumberAt(fields, "after", isCount, COUNT_TEXT)
  const before = optionalNumberAt(fields, "before", isCount, COUNT_TEXT)
  if (topic !== undefined) parsed.topic = topic
  if (beforeId !== undefined) parsed.before_id = beforeId
  if (after !== undefined) parsed.after = after
  if (before !== undefined) parsed.before = before
  return parsed
}

function offsetAt(fields: Record<string, unknown>): TopicsOffset | undefined {
  if (fields.offset === undefined) return undefined
  const offset = recordOf(fields.offset, OFFSET_KEYS, "offset")
  return {
    date: numberAt(offset, "date", isTelegramCount, COUNT_TEXT),
    id: numberAt(offset, "id", isTelegramCount, COUNT_TEXT),
    topic: numberAt(offset, "topic", isTelegramCount, COUNT_TEXT),
  }
}

/** The parameters of a `topics` request, checked; anything off is `invalid_argument`. */
export function parseTopicsParams(params: unknown): TopicsParams {
  const fields = recordOf(params, TOPICS_KEYS, "The topics parameters")
  const parsed: TopicsParams = {
    chat: chatAt(fields),
    limit: numberAt(fields, "limit", isLimitUpTo(TOPICS_LIMIT), `an integer from 1 to ${TOPICS_LIMIT}`),
  }
  const offset = offsetAt(fields)
  if (offset) parsed.offset = offset
  return parsed
}

/** Checks that a request that takes no parameters got none. */
export function expectNoParams(params: unknown, what: string): void {
  if (params !== undefined) recordOf(params, [], what)
}
