import { ToolError } from "../errors"
import type { Mirror } from "./mirror"
import type { SendParams } from "./service-requests"
import { listedChat } from "./sync-request-calls"

/** How long before a call started a message of the user's still counts as that call's own delivery, in milliseconds. */
const DUPLICATE_LOOKBACK_MS = 60_000

/** Whether the mirror has message `id` of `chat`; a message deleted for everyone has no row. */
function hasMessage(mirror: Mirror, chat: string, id: number): boolean {
  return mirror.prepare("SELECT 1 FROM messages WHERE chat = ? AND id = ?").get(chat, id) !== undefined
}

/**
 * Refuses a send that the mirror shows cannot succeed, before anything is
 * sent. The chat must be one the mirror lists (`not_found`); one the account
 * left, or knows it cannot write in, is `forbidden`. A topic needs a forum
 * (`invalid_argument`); a closed topic is left to Telegram, since an admin may
 * still post there. A reply to a message the mirror lacks is `not_found`, but
 * only in a chat the mirror keeps: of any other it holds no messages, and
 * Telegram decides.
 */
export function checkSendable(mirror: Mirror, { chat, topic, reply_to }: SendParams): void {
  const row = listedChat(mirror, chat)
  if (row.left) throw new ToolError("forbidden", "You are no longer in this chat; nothing was sent.")
  if (row.can_send === 0) throw new ToolError("forbidden", "You cannot write in this chat; nothing was sent.")
  if (topic !== undefined && !row.forum) {
    throw new ToolError("invalid_argument", "This chat has no topics; nothing was sent.")
  }
  if (reply_to !== undefined && row.followed && !hasMessage(mirror, chat, reply_to)) {
    throw new ToolError("not_found", `No message ${reply_to} in this chat to reply to; nothing was sent.`)
  }
}

/**
 * The id of the message an earlier delivery of a send left in the mirror: the
 * only message the user sent in `chat` with exactly this `text` since a minute
 * before the call began (`startedAt`, in milliseconds). Undefined when the
 * mirror has none, or has several that it cannot tell apart.
 */
export function deliveredId(mirror: Mirror, chat: string, text: string, startedAt: number): number | undefined {
  const rows = mirror
    .prepare("SELECT id FROM messages WHERE chat = ? AND from_me = 1 AND body = ? AND ts >= ? LIMIT 2")
    .all(chat, text, startedAt - DUPLICATE_LOOKBACK_MS) as { id: number }[]
  return rows.length === 1 ? rows[0]!.id : undefined
}
