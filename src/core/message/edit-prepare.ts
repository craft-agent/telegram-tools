import { checkEditable, deletedMessage, takesCaption } from "../telegram/action-checks"
import type { Mirror } from "../telegram/mirror"
import type { ChatRow } from "../telegram/mirror-rows"
import { findOwnMessage, type OwnMessage } from "./own"

/** The chat and the message of an edit the mirror shows can be made. */
export type EditTarget = { chat: ChatRow; message: OwnMessage }

/**
 * Checks in the mirror, as the sync service does, that the user's message can
 * be edited to `text` (already trimmed and within `TEXT_MAX_UNITS`):
 * `not_found` for a message that is deleted; `invalid_argument` for one with
 * no text and no media to caption (a service message), for the text it
 * already has, and for a caption over `CAPTION_MAX_UNITS`. See
 * `findOwnMessage` for the rest.
 */
export function prepareEdit(mirror: Mirror, chatId: string, id: number, text: string): EditTarget {
  const { chat, message } = findOwnMessage(mirror, chatId, id, "edit")
  if (!message) throw deletedMessage()
  checkEditable({ ...message, captioned: message.media !== null && takesCaption(message.media.type) }, text)
  return { chat, message }
}
