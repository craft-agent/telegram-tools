import type { SendFilesResult } from "../../telegram/service-requests"
import { formatLocalTime } from "../../time"
import { FILES_ACCEPTED_NOTE, FILES_DUPLICATE_NOTE, FILES_DUPLICATE_PARTIAL_NOTE } from "./constants"
import type { FileSendOutput } from "./schema"

/**
 * The result of a send Telegram accepted, or had already received: the files
 * as they were sent, and the messages' ids and the time when the service gave
 * them.
 */
export function sendFilesResult(chat: string, sent: SendFilesResult, files: FileSendOutput["files"]): FileSendOutput {
  const result: FileSendOutput = { chat, files, note: FILES_ACCEPTED_NOTE }
  if (sent.messages !== undefined) result.messages = sent.messages
  if (sent.date !== undefined) result.time = formatLocalTime(sent.date)
  if (sent.duplicate) {
    result.duplicate = true
    result.note = sent.messages?.length === files.length ? FILES_DUPLICATE_NOTE : FILES_DUPLICATE_PARTIAL_NOTE
  }
  return result
}
