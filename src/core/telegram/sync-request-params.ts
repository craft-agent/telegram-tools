import { Buffer } from "node:buffer"
import { isAbsolute } from "node:path"
import { ToolError } from "../errors"
import { checkEmojiOrRemove, checkPinFlagsWithUnpin, checkReactionEmoji } from "./action-checks"
import { isChatId, isCount } from "./mirror-input"
import { isRecord } from "./service-errors"
import {
  AROUND_LIMIT,
  CAPTION_MAX_UNITS,
  DOWNLOAD_MAX_BYTES,
  FETCH_PAGE_LIMIT,
  HISTORY_LIMIT,
  SEND_FILES_MAX,
  SYNC_LIST_LIMIT,
  TEXT_MAX_UNITS,
  TOPICS_LIMIT,
  type AroundParams,
  type DeleteParams,
  type DownloadParams,
  type EditParams,
  type FetchParams,
  type HistoryParams,
  type MarkReadParams,
  type PinParams,
  type ReactParams,
  type SendFile,
  type SendFilesParams,
  type SendParams,
  type SyncChangeParams,
  type TopicsOffset,
  type TopicsParams,
} from "./service-requests"

/** The largest number Telegram takes for an id, a count or a time in seconds (a signed 32-bit integer). */
export const INT32_MAX = 2 ** 31 - 1

const HISTORY_KEYS = ["chat", "limit", "topic", "before_id", "after", "before"]
const TOPICS_KEYS = ["chat", "limit", "offset"]
const OFFSET_KEYS = ["date", "id", "topic"]
const AROUND_KEYS = ["chat", "id", "before_count", "after_count", "topic"]
const FETCH_KEYS = ["chat", "pages"]
const DOWNLOAD_KEYS = ["chat", "id", "max_bytes"]
const SEND_KEYS = ["chat", "text", "topic", "reply_to"]
const SEND_FILES_KEYS = ["chat", "files", "caption", "topic", "reply_to"]
const SEND_FILE_KEYS = ["path", "name"]
const EDIT_KEYS = ["chat", "id", "text"]
const DELETE_KEYS = ["chat", "id"]
const REACT_KEYS = ["chat", "id", "emoji", "remove"]
const PIN_KEYS = ["chat", "id", "unpin", "notify", "both_sides"]
const MARK_READ_KEYS = ["chat", "up_to", "topic"]

/** The most bytes a file name may take: what every file system takes. */
const FILE_NAME_MAX_BYTES = 255
const SYNC_CHANGE_KEYS = ["chats"]

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
const isCountUpTo = (max: number) => (value: number) => isCount(value) && value <= max

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

/** The parameters of an `around` request, checked; anything off is `invalid_argument`. */
export function parseAroundParams(params: unknown): AroundParams {
  const fields = recordOf(params, AROUND_KEYS, "The around parameters")
  const countText = `an integer from 0 to ${AROUND_LIMIT}`
  const parsed: AroundParams = {
    chat: chatAt(fields),
    id: numberAt(fields, "id", isIdNumber, ID_TEXT),
    before_count: numberAt(fields, "before_count", isCountUpTo(AROUND_LIMIT), countText),
    after_count: numberAt(fields, "after_count", isCountUpTo(AROUND_LIMIT), countText),
  }
  const topic = optionalNumberAt(fields, "topic", isIdNumber, ID_TEXT)
  if (topic !== undefined) parsed.topic = topic
  return parsed
}

/** The parameters of a `fetch` request, checked; anything off is `invalid_argument`. */
export function parseFetchParams(params: unknown): FetchParams {
  const fields = recordOf(params, FETCH_KEYS, "The fetch parameters")
  return {
    chat: chatAt(fields),
    pages: numberAt(fields, "pages", isLimitUpTo(FETCH_PAGE_LIMIT), `an integer from 1 to ${FETCH_PAGE_LIMIT}`),
  }
}

/** The parameters of a `download` request, checked; anything off is `invalid_argument`. */
export function parseDownloadParams(params: unknown): DownloadParams {
  const fields = recordOf(params, DOWNLOAD_KEYS, "The download parameters")
  return {
    chat: chatAt(fields),
    id: numberAt(fields, "id", isIdNumber, ID_TEXT),
    max_bytes: numberAt(
      fields,
      "max_bytes",
      isLimitUpTo(DOWNLOAD_MAX_BYTES),
      `an integer from 1 to ${DOWNLOAD_MAX_BYTES}`,
    ),
  }
}

/** The text of a `send` or `edit` request: not blank, already trimmed, and within Telegram's length. Never echoed in an error. */
function sendTextAt(fields: Record<string, unknown>): string {
  const { text } = fields
  if (typeof text !== "string") throw invalid("text must be a string.")
  if (text.trim() === "") throw invalid("text must not be blank.")
  if (text !== text.trim()) throw invalid("text must not start or end with blank space.")
  if (text.length > TEXT_MAX_UNITS) throw invalid(`text must be at most ${TEXT_MAX_UNITS} characters.`)
  return text
}

/** The parameters of a `send` request, checked; anything off is `invalid_argument`. */
export function parseSendParams(params: unknown): SendParams {
  const fields = recordOf(params, SEND_KEYS, "The send parameters")
  const parsed: SendParams = { chat: chatAt(fields), text: sendTextAt(fields) }
  const topic = optionalNumberAt(fields, "topic", isIdNumber, ID_TEXT)
  const replyTo = optionalNumberAt(fields, "reply_to", isIdNumber, ID_TEXT)
  if (topic !== undefined) parsed.topic = topic
  if (replyTo !== undefined) parsed.reply_to = replyTo
  return parsed
}

/** The parameters of an `edit` request, checked; anything off is `invalid_argument`. */
export function parseEditParams(params: unknown): EditParams {
  const fields = recordOf(params, EDIT_KEYS, "The edit parameters")
  return { chat: chatAt(fields), id: numberAt(fields, "id", isIdNumber, ID_TEXT), text: sendTextAt(fields) }
}

/** The parameters of a `delete` request, checked; anything off is `invalid_argument`. */
export function parseDeleteParams(params: unknown): DeleteParams {
  const fields = recordOf(params, DELETE_KEYS, "The delete parameters")
  return { chat: chatAt(fields), id: numberAt(fields, "id", isIdNumber, ID_TEXT) }
}

/** Whether the flag at `key` is set: a missing one is not, and anything but a boolean is refused. */
function flagAt(fields: Record<string, unknown>, key: string): boolean {
  const value = fields[key]
  if (value === undefined) return false
  if (typeof value !== "boolean") throw invalid(`${key} must be true or false.`)
  return value
}

/**
 * The parameters of a `react` request, checked; anything off is
 * `invalid_argument`. Exactly one of `emoji` and `remove: true` is given;
 * `remove: false` counts as not given. The emoji is never echoed.
 */
export function parseReactParams(params: unknown): ReactParams {
  const fields = recordOf(params, REACT_KEYS, "The react parameters")
  const parsed: ReactParams = { chat: chatAt(fields), id: numberAt(fields, "id", isIdNumber, ID_TEXT) }
  const { emoji } = fields
  const remove = flagAt(fields, "remove")
  checkEmojiOrRemove(emoji !== undefined, remove)
  if (remove) return { ...parsed, remove }
  if (typeof emoji !== "string") throw invalid("emoji must be a string.")
  checkReactionEmoji(emoji)
  return { ...parsed, emoji }
}

/**
 * The parameters of a `pin` request, checked; anything off is
 * `invalid_argument`. A flag that is `false` counts as not given, and `notify`
 * and `both_sides` go with a pin only.
 */
export function parsePinParams(params: unknown): PinParams {
  const fields = recordOf(params, PIN_KEYS, "The pin parameters")
  const unpin = flagAt(fields, "unpin")
  const notify = flagAt(fields, "notify")
  const bothSides = flagAt(fields, "both_sides")
  checkPinFlagsWithUnpin(unpin, notify, bothSides)
  return {
    chat: chatAt(fields),
    id: numberAt(fields, "id", isIdNumber, ID_TEXT),
    ...(unpin ? { unpin } : {}),
    ...(notify ? { notify } : {}),
    ...(bothSides ? { both_sides: bothSides } : {}),
  }
}

/** The parameters of a `mark_read` request, checked; anything off is `invalid_argument`. */
export function parseMarkReadParams(params: unknown): MarkReadParams {
  const fields = recordOf(params, MARK_READ_KEYS, "The mark_read parameters")
  const parsed: MarkReadParams = { chat: chatAt(fields), up_to: numberAt(fields, "up_to", isIdNumber, ID_TEXT) }
  const topic = optionalNumberAt(fields, "topic", isIdNumber, ID_TEXT)
  if (topic !== undefined) parsed.topic = topic
  return parsed
}

/** The file name of a `send_files` file: plain, trimmed, and within what file systems and Telegram take. Never echoed in an error. */
function fileNameAt(file: Record<string, unknown>, position: number): string {
  const { name } = file
  const what = `The name of file ${position}`
  if (typeof name !== "string" || name === "") throw invalid(`${what} must be a file name.`)
  if (name !== name.trim()) throw invalid(`${what} must not start or end with blank space.`)
  if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw invalid(`${what} must be a plain file name.`)
  }
  if (Buffer.byteLength(name) > FILE_NAME_MAX_BYTES) {
    throw invalid(`${what} must be at most ${FILE_NAME_MAX_BYTES} bytes.`)
  }
  return name
}

/** The files of a `send_files` request: 1 to `SEND_FILES_MAX`, each an absolute path and a plain name, no path twice. */
function sendFilesAt(fields: Record<string, unknown>): SendFile[] {
  const { files } = fields
  if (!Array.isArray(files) || files.length < 1 || files.length > SEND_FILES_MAX) {
    throw invalid(`files must be a list of 1 to ${SEND_FILES_MAX} files.`)
  }
  const parsed = files.map((entry: unknown, index): SendFile => {
    const file = recordOf(entry, SEND_FILE_KEYS, `File ${index + 1}`)
    const { path } = file
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
      throw invalid(`The path of file ${index + 1} must be an absolute path.`)
    }
    return { path, name: fileNameAt(file, index + 1) }
  })
  if (new Set(parsed.map((file) => file.path)).size !== parsed.length) {
    throw invalid("files must not name a path twice.")
  }
  return parsed
}

/** The caption of a `send_files` request: not blank, already trimmed, and within Telegram's length. Never echoed in an error. */
function captionAt(fields: Record<string, unknown>): string | undefined {
  const { caption } = fields
  if (caption === undefined) return undefined
  if (typeof caption !== "string") throw invalid("caption must be a string.")
  if (caption.trim() === "") throw invalid("caption must not be blank.")
  if (caption !== caption.trim()) throw invalid("caption must not start or end with blank space.")
  if (caption.length > CAPTION_MAX_UNITS) throw invalid(`caption must be at most ${CAPTION_MAX_UNITS} characters.`)
  return caption
}

/** The parameters of a `send_files` request, checked; anything off is `invalid_argument`. */
export function parseSendFilesParams(params: unknown): SendFilesParams {
  const fields = recordOf(params, SEND_FILES_KEYS, "The send_files parameters")
  const parsed: SendFilesParams = { chat: chatAt(fields), files: sendFilesAt(fields) }
  const caption = captionAt(fields)
  const topic = optionalNumberAt(fields, "topic", isIdNumber, ID_TEXT)
  const replyTo = optionalNumberAt(fields, "reply_to", isIdNumber, ID_TEXT)
  if (caption !== undefined) parsed.caption = caption
  if (topic !== undefined) parsed.topic = topic
  if (replyTo !== undefined) parsed.reply_to = replyTo
  return parsed
}

/** The parameters of a `sync_add` or `sync_remove` request, checked; anything off is `invalid_argument`. */
export function parseSyncChangeParams(params: unknown): SyncChangeParams {
  const fields = recordOf(params, SYNC_CHANGE_KEYS, "The sync list parameters")
  const { chats } = fields
  if (!Array.isArray(chats) || chats.length < 1 || chats.length > SYNC_LIST_LIMIT) {
    throw invalid(`chats must be a list of 1 to ${SYNC_LIST_LIMIT} chat ids.`)
  }
  if (!chats.every(isChatId)) throw invalid("chats must hold chat ids as text.")
  if (new Set(chats).size !== chats.length) throw invalid("chats must not name a chat twice.")
  return { chats }
}

/** Checks that a request that takes no parameters got none. */
export function expectNoParams(params: unknown, what: string): void {
  if (params !== undefined) recordOf(params, [], what)
}
