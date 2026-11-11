import { ToolError } from "../errors"
import type { ChatKind, ReactionInfo } from "./mirror-input"
import type { ChatRow } from "./mirror-rows"
import { CAPTION_MAX_UNITS, GENERAL_TOPIC, REACTION_MAX_UNITS } from "./service-requests"

/** The type the mirror records for a message's link preview, which belongs to the text. */
const LINK_PREVIEW = "webpage"

/** The kinds of chat that are a private chat with another account: a person or a bot. */
const PRIVATE_KINDS: readonly ChatKind[] = ["user", "bot"]

/** What no standard emoji holds: a letter, a digit or blank space. */
const TEXT_CHARACTER = /[\p{L}\p{N}\s]/u

/** The action as a refusal says it was (not) done. */
export const ACTION_PAST = {
  edit: "edited",
  delete: "deleted",
  react: "changed",
  pin: "pinned",
  unpin: "unpinned",
  markRead: "marked read",
} as const

/** What an edit looks at of a message: its kind, its text, and whether it has media a caption goes with. */
export type EditableMessage = { kind: "message" | "service"; body: string | null; captioned: boolean }

/** Whether media of `type` is one a caption goes with: a link preview is part of a text, not media of its own. */
export function takesCaption(type: string): boolean {
  return type !== LINK_PREVIEW
}

/** The refusal for a chat the account has left. */
export function leftChat(past: string): ToolError {
  return new ToolError("forbidden", `You are no longer in this chat; nothing was ${past}.`)
}

/** The refusal for a message the mirror does not hold and was not told is deleted. */
export function noSuchMessage(id: number, followed: ChatRow["followed"], past: string): ToolError {
  return new ToolError(
    "not_found",
    followed
      ? `No message ${id} in this chat; nothing was ${past}.`
      : `This chat is not mirrored, so its messages cannot be checked; nothing was ${past}.`,
  )
}

/** The refusal for a message that is not the user's own. */
export function notOwnMessage(past: string): ToolError {
  return new ToolError("forbidden", `Only your own messages can be ${past}.`)
}

/**
 * Whether a stored message is the user's own: sent by them, or in Saved
 * Messages (`self`). Telegram marks no message in Saved Messages as sent, so
 * rows mirrored before that was accounted for carry `from_me` 0.
 */
export function isOwnMessage(fromMe: number, chatKind: ChatKind): boolean {
  return fromMe === 1 || chatKind === "self"
}

/** The refusal for an action on a message the mirror was told is deleted. */
export function goneMessage(past: string): ToolError {
  return new ToolError("not_found", `This message was deleted; nothing was ${past}.`)
}

/** The refusal for an edit of a message the mirror was told is deleted. */
export function deletedMessage(): ToolError {
  return goneMessage(ACTION_PAST.edit)
}

/** Whether `kind` is a private chat with another account, the only chat a pin can be made for both sides of. */
export function isPrivateChat(kind: ChatKind): boolean {
  return PRIVATE_KINDS.includes(kind)
}

/** Refuses a pin for both sides outside a private chat with a person or a bot (`invalid_argument`). */
export function checkBothSides(kind: ChatKind, bothSides: boolean | undefined): void {
  if (bothSides && !isPrivateChat(kind)) {
    throw new ToolError(
      "invalid_argument",
      `A pin can be made for both sides only in a chat with a person or a bot; nothing was ${ACTION_PAST.pin}.`,
    )
  }
}

/** Refuses a topic in a chat that is no forum (`invalid_argument`); a call without a topic passes. */
export function checkTopicChat({ forum }: Pick<ChatRow, "forum">, topic: number | undefined, past: string): void {
  if (topic !== undefined && !forum) {
    throw new ToolError("invalid_argument", `This chat has no topics; nothing was ${past}.`)
  }
}

/**
 * Refuses a message that is not in the topic the call names (`invalid_argument`).
 * `messageTopic` is the topic the mirror holds for the message: none for a
 * message of the General topic, which carries no topic header. A call without
 * a topic passes.
 */
export function checkInTopic(messageTopic: number | null, topic: number | undefined, past: string): void {
  if (topic === undefined) return
  if ((topic === GENERAL_TOPIC ? null : topic) !== messageTopic) {
    throw new ToolError("invalid_argument", `This message is not in that topic; nothing was ${past}.`)
  }
}

/** Refuses a reaction call that gives both `emoji` and `remove: true`, or neither (`invalid_argument`). */
export function checkEmojiOrRemove(emojiGiven: boolean, remove: boolean): void {
  if (emojiGiven === remove) throw new ToolError("invalid_argument", "Give exactly one of emoji and remove.")
}

/** Refuses `notify` and `both_sides` on an unpin: they go with a pin only (`invalid_argument`). */
export function checkPinFlagsWithUnpin(
  unpin: boolean | undefined,
  notify: boolean | undefined,
  bothSides: boolean | undefined,
): void {
  if (unpin && (notify || bothSides)) {
    throw new ToolError("invalid_argument", "notify and both_sides go with a pin, not an unpin.")
  }
}

/**
 * Refuses an emoji that cannot be a standard reaction: one that is empty or
 * over `REACTION_MAX_UNITS`, one with a letter, a digit or blank space, and
 * one of more than one grapheme (`invalid_argument`). The emoji is never echoed.
 */
export function checkReactionEmoji(emoji: string): void {
  if (emoji === "" || emoji.length > REACTION_MAX_UNITS) {
    throw new ToolError("invalid_argument", `emoji must be one emoji of at most ${REACTION_MAX_UNITS} characters.`)
  }
  if (TEXT_CHARACTER.test(emoji) || [...new Intl.Segmenter().segment(emoji)].length > 1) {
    throw new ToolError("invalid_argument", "emoji must be a single emoji, with no letters, digits or blank space.")
  }
}

/** The reactions the mirror stores as JSON, as a list; none when it has none. */
export function storedReactions(json: string | null): ReactionInfo[] {
  return json === null ? [] : (JSON.parse(json) as ReactionInfo[])
}

/** The emoji the user themself reacted with, when the reactions show one. */
export function ownReaction(reactions: readonly ReactionInfo[]): string | undefined {
  return reactions.find((reaction) => reaction.mine)?.emoji
}

/**
 * Refuses an edit of a message the mirror shows cannot succeed: one with no
 * text and no media to caption (a service message), the text it already has,
 * or a caption over `CAPTION_MAX_UNITS` (`invalid_argument`).
 */
export function checkEditable({ kind, body, captioned }: EditableMessage, text: string): void {
  if (kind === "service" || (body === null && !captioned)) {
    throw new ToolError("invalid_argument", "This message has no text or caption to edit; nothing was edited.")
  }
  if (body === text) {
    throw new ToolError("invalid_argument", "The text is the same as the message's; nothing to edit.")
  }
  if (captioned && text.length > CAPTION_MAX_UNITS) {
    throw new ToolError(
      "invalid_argument",
      `A caption must be at most ${CAPTION_MAX_UNITS} characters; nothing was edited.`,
    )
  }
}
