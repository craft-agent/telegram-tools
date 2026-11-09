import type { SendResult } from "../telegram/service-requests"
import { formatLocalTime } from "../time"
import { ACCEPTED_NOTE, DUPLICATE_NOTE, DUPLICATE_UNKNOWN_ID_NOTE } from "./constants"
import type { SendOutput } from "./schema"

/** The result of a send Telegram accepted, or had already received: the message's id and time when the service gave them. */
export function sendResult(chat: string, sent: SendResult): SendOutput {
  const result: SendOutput = { chat, note: ACCEPTED_NOTE }
  if (sent.id !== undefined) result.id = sent.id
  if (sent.date !== undefined) result.time = formatLocalTime(sent.date)
  if (sent.duplicate) {
    result.duplicate = true
    result.note = sent.id === undefined ? DUPLICATE_UNKNOWN_ID_NOTE : DUPLICATE_NOTE
  }
  return result
}
