import { ToolError } from "../errors"
import { checkEmojiOrRemove, checkPinFlagsWithUnpin, checkReactionEmoji } from "../telegram/action-checks"
import { CAPTION_MAX_UNITS, type PinParams, TEXT_MAX_UNITS } from "../telegram/service-requests"

/** The flags of a pin call. */
export type PinFlags = Pick<PinParams, "unpin" | "notify" | "both_sides">

/**
 * The text as it will be sent: trimmed, and then not blank and at most
 * `TEXT_MAX_UNITS` UTF-16 units, as Telegram counts a message's length; else
 * `invalid_argument`.
 */
export function checkedText(text: string): string {
  const trimmed = text.trim()
  if (trimmed === "") throw new ToolError("invalid_argument", "text is blank; give the text to send.")
  if (trimmed.length > TEXT_MAX_UNITS) {
    throw new ToolError(
      "invalid_argument",
      `text is ${trimmed.length} characters after trimming; at most ${TEXT_MAX_UNITS}. Send it as several messages.`,
    )
  }
  return trimmed
}

/**
 * The caption as it will be sent: trimmed and at most `CAPTION_MAX_UNITS`
 * UTF-16 units, else `invalid_argument`; absent, or blank after trimming, it
 * is none (`undefined`), and only the files are sent.
 */
export function checkedCaption(caption: string | undefined): string | undefined {
  const trimmed = caption?.trim()
  if (trimmed === undefined || trimmed === "") return undefined
  if (trimmed.length > CAPTION_MAX_UNITS) {
    throw new ToolError(
      "invalid_argument",
      `caption is ${trimmed.length} characters after trimming; at most ${CAPTION_MAX_UNITS}. Shorten it, or send the rest as a message.`,
    )
  }
  return trimmed
}

/**
 * The reaction a call asks for, as the sync service checks it: exactly one of
 * `emoji` and `remove: true` (`remove: false` counts as not given), and the
 * emoji one standard emoji. Returns the emoji, or `undefined` for a removal;
 * anything off is `invalid_argument`.
 */
export function checkedReaction(emoji: string | undefined, remove: boolean | undefined): string | undefined {
  checkEmojiOrRemove(emoji !== undefined, remove === true)
  if (emoji !== undefined) checkReactionEmoji(emoji)
  return emoji
}

/** Refuses `notify` and `both_sides` on an unpin, as the sync service does: they go with a pin only (`invalid_argument`). */
export function checkedPinFlags({ unpin, notify, both_sides }: PinFlags): void {
  checkPinFlagsWithUnpin(unpin, notify, both_sides)
}
