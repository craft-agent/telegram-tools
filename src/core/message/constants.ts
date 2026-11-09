/** The ID of the tool that sends one text to a chat. */
export const MESSAGE_SEND_TOOL_ID = "telegram_message_send"

/**
 * How long one send may take, in milliseconds. The service sends one message
 * at a time, so a send can wait behind another in its queue before its own
 * call to Telegram begins.
 */
export const SEND_TIMEOUT_MS = 60_000

/**
 * How long before a send began a message of the user's still counts as
 * possibly the send's own, in milliseconds: Telegram dates a message by its
 * own clock, which may differ a little from this one.
 */
export const SENT_LOOKBACK_MS = 60_000

/** The most messages an `uncertain` send's `details` lists. */
export const MAX_SENT_LIKE = 5

/** Said by a result Telegram accepted. */
export const ACCEPTED_NOTE = "Telegram accepted the message; that is not a read receipt."

/** Said by a result for a send Telegram had already received, when its id is known. */
export const DUPLICATE_NOTE =
  "An earlier delivery of this same call had already gone out, so only one message exists. Do not send it again."

/** Said by a result for a send Telegram had already received, when the mirror does not have it yet. */
export const DUPLICATE_UNKNOWN_ID_NOTE = `${DUPLICATE_NOTE} Its id is not known yet; \`telegram_chat_read\` shows it once the service receives it.`
