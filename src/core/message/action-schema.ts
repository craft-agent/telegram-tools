import { z } from "zod"
import { accountArgument } from "../chat/schema"
import { CAPTION_MAX_UNITS, GENERAL_TOPIC, REACTION_MAX_UNITS, TEXT_MAX_UNITS } from "../telegram/service-requests"
import { localTimeSchema } from "../time"

const chatArgument = z
  .string()
  .describe(
    "The id of the chat the message is in, from `telegram_chat_read`, such as 123456789 or -1001234567890. Saved Messages is the user's own chat (`kind` `self`). A name, username or phone number is not a chat.",
  )

/** A message's id in its chat; `whose` says whose messages the tool takes. */
function messageIdArgument(whose: string) {
  return z.number().int().positive().describe(`The id of ${whose} in that chat, as \`telegram_chat_read\` gives it.`)
}

const idArgument = messageIdArgument("the user's own message")

const anyIdArgument = messageIdArgument("a message, anyone's,")

/** The input schema for `telegram_message_edit`. */
export const editInput = z.object({
  account: accountArgument,
  chat: chatArgument,
  id: idArgument,
  text: z
    .string()
    .describe(
      `The whole new text, or the new caption of a message with media, exactly as it should arrive; it is never read as Markdown or HTML. Surrounding blank space is trimmed, and what is left is 1 to ${TEXT_MAX_UNITS} characters (${CAPTION_MAX_UNITS} for a caption).`,
    ),
})

/** The output schema for `telegram_message_edit`. */
export const editOutput = z.strictObject({
  chat: z.string().describe("The chat the message is in."),
  id: z.number().int().describe("The edited message's id; an edit does not change it."),
  edited: localTimeSchema
    .optional()
    .describe(
      "When Telegram made the edit, in local time with offset; absent when it had already been made and the time is not known.",
    ),
  already: z
    .literal(true)
    .optional()
    .describe("Set when the message already had this text: an earlier delivery of this edit went through."),
  note: z.string().describe("What the result means."),
})

/** What `telegram_message_edit` returns. */
export type EditOutput = z.input<typeof editOutput>

/** The input schema for `telegram_message_delete`. */
export const deleteInput = z.object({
  account: accountArgument,
  chat: chatArgument,
  id: idArgument,
})

/** The output schema for `telegram_message_delete`. */
export const deleteOutput = z.strictObject({
  chat: z.string().describe("The chat the message was in."),
  id: z.number().int().describe("The deleted message's id."),
  deleted: z.literal(true).describe("Always set: the message is gone for everyone."),
  already: z.literal(true).optional().describe("Set when the message was already gone before this call."),
  note: z.string().describe("What the result means."),
})

/** What `telegram_message_delete` returns. */
export type DeleteOutput = z.input<typeof deleteOutput>

/** The input schema for `telegram_message_react`. */
export const reactInput = z.object({
  account: accountArgument,
  chat: chatArgument,
  id: anyIdArgument,
  emoji: z
    .string()
    .optional()
    .describe(
      `One standard emoji to react with, such as 👍, at most ${REACTION_MAX_UNITS} characters, with no letters, digits or blank space. It replaces any earlier reaction of the user's on the message. Custom emoji and paid reactions are refused. Give exactly one of \`emoji\` and \`remove\`.`,
    ),
  remove: z
    .boolean()
    .optional()
    .describe(
      "`true` removes the user's own reaction from the message. `false` counts as not given. Give exactly one of `emoji` and `remove`.",
    ),
})

/** The output schema for `telegram_message_react`. */
export const reactOutput = z.strictObject({
  chat: z.string().describe("The chat the message is in."),
  id: z.number().int().describe("The message's id."),
  emoji: z.string().optional().describe("The user's reaction on the message now; absent when it was removed."),
  removed: z.literal(true).optional().describe("Set when the user's reaction was removed."),
  already: z
    .literal(true)
    .optional()
    .describe("Set when the reaction was already so: the mirror showed it, or Telegram found it unchanged."),
  note: z.string().describe("What the result means."),
})

/** What `telegram_message_react` returns. */
export type ReactOutput = z.input<typeof reactOutput>

/** The input schema for `telegram_message_pin`. */
export const pinInput = z.object({
  account: accountArgument,
  chat: chatArgument,
  id: anyIdArgument,
  unpin: z
    .boolean()
    .optional()
    .describe("`true` unpins the message instead of pinning it. `false` counts as not given."),
  notify: z
    .boolean()
    .optional()
    .describe(
      "`true` tells the members of a group that the message was pinned; left out, the pin is silent. Only with a pin.",
    ),
  both_sides: z
    .boolean()
    .optional()
    .describe(
      "`true` pins in a chat with a person or a bot for the other person too; left out, only the user sees it pinned. Only with a pin, and only in such a chat.",
    ),
})

/** The output schema for `telegram_message_pin`. */
export const pinOutput = z.strictObject({
  chat: z.string().describe("The chat the message is in."),
  id: z.number().int().describe("The message's id."),
  pinned: z.boolean().describe("Whether the message is pinned now: false after an unpin."),
  already: z
    .literal(true)
    .optional()
    .describe("Set when Telegram found the message already pinned, or not pinned, as asked."),
  note: z.string().describe("What the result means."),
})

/** What `telegram_message_pin` returns. */
export type PinOutput = z.input<typeof pinOutput>

/** The input schema for `telegram_chat_mark_read`. */
export const markReadInput = z.object({
  account: accountArgument,
  chat: chatArgument,
  up_to: messageIdArgument("the last message to mark read"),
  topic: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Mark only this forum topic read, an id from \`telegram_chat_read\` \`topics\`; the General topic is ${GENERAL_TOPIC}. \`up_to\` must be a message of that topic. Only for a chat with topics; left out, the whole chat is marked read.`,
    ),
})

/** The output schema for `telegram_chat_mark_read`. */
export const markReadOutput = z.strictObject({
  chat: z.string().describe("The chat that was marked read."),
  up_to: z.number().int().describe("The id of the last message marked read."),
  topic: z.number().int().optional().describe("The forum topic that was marked read, when one was named."),
  already: z
    .literal(true)
    .optional()
    .describe("Set when the chat was already read up to that message or beyond, so nothing was asked of Telegram."),
  note: z.string().describe("What the result means."),
})

/** What `telegram_chat_mark_read` returns. */
export type MarkReadOutput = z.input<typeof markReadOutput>
