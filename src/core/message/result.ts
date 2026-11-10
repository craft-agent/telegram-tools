import type { DeleteResult, EditResult, PinResult, ReactResult, SendResult } from "../telegram/service-requests"
import { formatLocalTime } from "../time"
import type { DeleteOutput, EditOutput, PinOutput, ReactOutput } from "./action-schema"
import {
  ACCEPTED_NOTE,
  DELETE_ALREADY_NOTE,
  DELETE_DONE_NOTE,
  DUPLICATE_NOTE,
  DUPLICATE_UNKNOWN_ID_NOTE,
  EDIT_ACCEPTED_NOTE,
  EDIT_ALREADY_NOTE,
  PIN_ALREADY_NOTE,
  PIN_DONE_NOTE,
  PIN_ONE_SIDED_NOTE,
  PIN_SILENT_NOTE,
  REACT_ALREADY_NOTE,
  REACT_REMOVED_NOTE,
  REACT_SET_NOTE,
  UNPIN_DONE_NOTE,
} from "./constants"
import type { SendOutput } from "./schema"

/** How a pin reached the people in the chat, which its note says: whether it told the members, and whether only the user sees it. */
export type PinReach = { notify: boolean; oneSided: boolean }

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

/** The result of an edit Telegram accepted, or found already made: the time of the edit when the service gave it. */
export function editResult(chat: string, edited: EditResult): EditOutput {
  const result: EditOutput = { chat, id: edited.id, note: EDIT_ACCEPTED_NOTE }
  if (edited.edited !== undefined) result.edited = formatLocalTime(edited.edited)
  if (edited.already) {
    result.already = true
    result.note = EDIT_ALREADY_NOTE
  }
  return result
}

/** The result of a delete: the message is gone, and `already` says it was before this call. */
export function deleteResult(chat: string, deleted: DeleteResult): DeleteOutput {
  const result: DeleteOutput = { chat, id: deleted.id, deleted: true, note: DELETE_DONE_NOTE }
  if (deleted.already) {
    result.already = true
    result.note = DELETE_ALREADY_NOTE
  }
  return result
}

/** The result of a reaction set or removed: what the message has from the user now, and `already` when it was so before this call. */
export function reactResult(chat: string, reacted: ReactResult): ReactOutput {
  const result: ReactOutput = { chat, id: reacted.id, note: reacted.removed ? REACT_REMOVED_NOTE : REACT_SET_NOTE }
  if (reacted.emoji !== undefined) result.emoji = reacted.emoji
  if (reacted.removed) result.removed = true
  if (reacted.already) {
    result.already = true
    result.note = REACT_ALREADY_NOTE
  }
  return result
}

/** The result of a pin or an unpin: whether the message is pinned now, with a note on who was told and who sees a pin, and `already` when it was so before this call. */
export function pinResult(chat: string, pinned: PinResult, reach: PinReach): PinOutput {
  const result: PinOutput = { chat, id: pinned.id, pinned: pinned.pinned, note: UNPIN_DONE_NOTE }
  if (pinned.pinned) {
    result.note = `${PIN_DONE_NOTE}${reach.notify ? "" : PIN_SILENT_NOTE}${reach.oneSided ? PIN_ONE_SIDED_NOTE : ""}.`
  }
  if (pinned.already) {
    result.already = true
    result.note = PIN_ALREADY_NOTE
  }
  return result
}
