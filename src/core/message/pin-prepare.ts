import { checkBothSides } from "../telegram/action-checks"
import type { Mirror } from "../telegram/mirror"
import type { PinFlags } from "./arguments"
import { findAnyMessage, type LiveTarget } from "./own"

/**
 * Checks in the mirror, as the sync service does, that a message can be pinned
 * or unpinned: `not_found` for a message that is deleted and `invalid_argument`
 * for a pin for both sides outside a chat with a person or a bot. See
 * `findAnyMessage` for the rest.
 */
export function preparePin(mirror: Mirror, chatId: string, id: number, flags: PinFlags): LiveTarget {
  const target = findAnyMessage(mirror, chatId, id, flags.unpin ? "unpin" : "pin")
  checkBothSides(target.chat.kind, flags.both_sides)
  return target
}
