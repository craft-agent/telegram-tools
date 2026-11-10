import { Message, PeersIndex, tl, type Long } from "@mtcute/core"
import { ToolError, type ErrorCode } from "../errors"
import { floodWaitSecondsOf, isSessionEnded } from "./rpc-errors"
import { UNCERTAIN_ADVICE } from "./service-errors"

const MS_PER_S = 1000

/** Telegram's answer to a send whose `random_id` an earlier delivery of the same call already used. */
const RANDOM_ID_DUPLICATE = "RANDOM_ID_DUPLICATE"

/** The pseudo-error mtcute answers with when its own time limit for a call passed: no refusal, an answer that never came. */
const CALL_TIMEOUT = "TIMEOUT"

/** The error codes of a refusal: bad request, forbidden and not acceptable. Telegram gives them before it stores anything. */
const REFUSAL_CODES: readonly number[] = [400, 403, 406]

/** The flood and slow-mode waits, as mtcute names them once it has taken the seconds out. */
const RATE_LIMIT_ERRORS: readonly string[] = ["FLOOD_WAIT_%d", "SLOWMODE_WAIT_%d", "FLOOD_PREMIUM_WAIT_%d"]

/** The refusals that say this account may not write here. */
const FORBIDDEN_ERRORS: readonly string[] = [
  "CHAT_WRITE_FORBIDDEN",
  "CHAT_SEND_PLAIN_FORBIDDEN",
  "CHAT_SEND_MEDIA_FORBIDDEN",
  "CHAT_SEND_DOCS_FORBIDDEN",
  "CHAT_RESTRICTED",
  "USER_BANNED_IN_CHANNEL",
  "CHAT_ADMIN_REQUIRED",
  "USER_IS_BLOCKED",
  "YOU_BLOCKED_USER",
  "PRIVACY_PREMIUM_REQUIRED",
  "TOPIC_CLOSED",
]

/**
 * The refusals that say the chat, the topic or the message to reply to is not
 * there for this account. `USER_DEACTIVATED` is not one: it is the account's
 * own, and ends the session.
 */
const NOT_FOUND_ERRORS: readonly string[] = [
  "PEER_ID_INVALID",
  "CHANNEL_PRIVATE",
  "CHANNEL_INVALID",
  "CHAT_ID_INVALID",
  "INPUT_USER_DEACTIVATED",
  "REPLY_MESSAGE_ID_INVALID",
  "MSG_ID_INVALID",
  "TOPIC_DELETED",
]

/** The refusals that say the text cannot be sent. */
const INVALID_TEXT_ERRORS: readonly string[] = ["MESSAGE_TOO_LONG", "MESSAGE_EMPTY"]

/** The refusals that say the caption cannot be sent. */
const INVALID_CAPTION_ERRORS: readonly string[] = ["MEDIA_CAPTION_TOO_LONG"]

/** What went with a send besides the answer. */
export type SendTrouble = {
  /** The connection left `connected` while the call was out: an earlier delivery of it may have landed. */
  reconnected: boolean
  /** The call was abandoned (the caller left or the service closed) after it went out. */
  aborted: boolean
}

/** The message Telegram accepted, as the response carries it. */
export type SentMessage =
  | {
      /** `updateShortSentMessage`: the id and the time, and no more of the message than its entities and timer. */
      form: "short"
      id: number
      /** Unix milliseconds. */
      date: number
      ttl: number | null
      entities: tl.TypeMessageEntity[]
    }
  | {
      /** An updates group that holds the message itself. */
      form: "full"
      id: number
      /** Unix milliseconds. */
      date: number
      message: Message
    }

/** The message of a response that holds the message itself. */
export type FullSentMessage = Extract<SentMessage, { form: "full" }>

/** Whether Telegram answered that an earlier delivery of this very call already landed. */
export function isRandomIdDuplicate(error: unknown): boolean {
  return tl.RpcError.is(error, RANDOM_ID_DUPLICATE)
}

/** The error of a send that may have gone out: `reason` says why in words without content, ids or names. */
export function uncertainSend(reason: string): ToolError {
  return new ToolError("uncertain", `The message may have been sent (${reason}). ${UNCERTAIN_ADVICE}`)
}

/** The error of a send Telegram refused before storing anything, with Telegram's name for the refusal. */
function refusedSend(code: ErrorCode, what: string, name: string): ToolError {
  return new ToolError(code, `${what} (${name}); nothing was sent.`)
}

/** The seconds a rate-limit refusal asks to wait, or undefined when the refusal is not one. */
function rateLimitSecondsOf(error: tl.RpcError): number | undefined {
  const text = String(error.text)
  if (!RATE_LIMIT_ERRORS.includes(text.replace(/\d+$/, "%d"))) return undefined
  const digits = /\d+$/.exec(text)
  return floodWaitSecondsOf(error) ?? (digits ? Number(digits[0]) : undefined)
}

/** The error for a refusal that Telegram gave, when it can be told from its name; undefined for any other. */
export function refusalOf(error: tl.RpcError): ToolError | undefined {
  const name = String(error.text)
  const seconds = rateLimitSecondsOf(error)
  if (seconds !== undefined) {
    return new ToolError(
      "rate_limited",
      `Telegram is limiting sends from this account; nothing was sent. Try again in ${seconds} seconds.`,
    )
  }
  if (FORBIDDEN_ERRORS.includes(name)) {
    return refusedSend("forbidden", "Telegram does not let this account send here", name)
  }
  if (NOT_FOUND_ERRORS.includes(name)) {
    return refusedSend("not_found", "Telegram has no such chat, topic or message to reply to", name)
  }
  if (INVALID_TEXT_ERRORS.includes(name)) return refusedSend("invalid_argument", "Telegram refused the text", name)
  if (INVALID_CAPTION_ERRORS.includes(name)) {
    return refusedSend("invalid_argument", "Telegram refused the caption", name)
  }
  if (REFUSAL_CODES.includes(error.code) && name !== CALL_TIMEOUT) {
    return refusedSend("upstream_error", "Telegram refused the send", name)
  }
  return undefined
}

/**
 * The error a failed send answers with. A refusal Telegram gave stands as
 * what it says (the message was not sent), unless the connection was
 * re-established while the call was out: then an earlier delivery may have
 * landed and the refusal may answer the repeat. Everything else leaves the
 * outcome open and is `uncertain`: a server error, mtcute's own timeout, a
 * session that ended, a connection that failed, a call that was abandoned.
 * `RANDOM_ID_DUPLICATE` is not a failure; see `isRandomIdDuplicate`.
 */
export function sendFailureOf(error: unknown, { reconnected, aborted }: SendTrouble): ToolError {
  if (isSessionEnded(error)) return uncertainSend("Telegram ended the session")
  if (!tl.RpcError.is(error)) {
    return uncertainSend(aborted ? "the request was cancelled" : "the connection to Telegram failed")
  }
  const name = String(error.text)
  if (reconnected) return uncertainSend(`the connection came back while Telegram was answering ${name}`)
  return refusalOf(error) ?? uncertainSend(`Telegram answered ${name}`)
}

/**
 * The message Telegram accepted for the send with `randomId`, found in its
 * response; undefined when the response does not hold it. Of an updates group
 * only the message that the `updateMessageID` carrying `randomId` names
 * counts: the first new message of the group is not taken for ours.
 */
export function sentMessageOf(response: tl.TypeUpdates, randomId: Long): SentMessage | undefined {
  if (response._ === "updateShortSentMessage") {
    return {
      form: "short",
      id: response.id,
      date: response.date * MS_PER_S,
      ttl: response.ttlPeriod ?? null,
      entities: response.entities ?? [],
    }
  }
  return fullSentMessageOf(response, randomId)
}

/**
 * The message of a file send, one for each of `randomIds` in their order,
 * found in the response by its own `random_id`; undefined when the response
 * does not name every one. Media never comes in the short form, which would
 * carry no file: it names none.
 */
export function sentFilesOf(response: tl.TypeUpdates, randomIds: readonly Long[]): FullSentMessage[] | undefined {
  const found = randomIds.map((randomId) => fullSentMessageOf(response, randomId))
  return found.every((sent) => sent !== undefined) ? found : undefined
}

/** The message of an updates group that the `updateMessageID` carrying `randomId` names, with the message itself. */
function fullSentMessageOf(response: tl.TypeUpdates, randomId: Long): FullSentMessage | undefined {
  if (response._ !== "updates" && response._ !== "updatesCombined") return undefined
  const named = response.updates.find(
    (update): update is tl.RawUpdateMessageID => update._ === "updateMessageID" && update.randomId.eq(randomId),
  )
  if (!named) return undefined
  for (const update of response.updates) {
    if (update._ !== "updateNewMessage" && update._ !== "updateNewChannelMessage") continue
    if (update.message._ !== "message" || update.message.id !== named.id) continue
    const message = new Message(update.message, PeersIndex.from(response))
    return { form: "full", id: named.id, date: message.date.getTime(), message }
  }
  return undefined
}
