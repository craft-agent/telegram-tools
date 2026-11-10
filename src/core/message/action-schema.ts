import { z } from "zod"
import { accountArgument } from "../chat/schema"
import { CAPTION_MAX_UNITS, TEXT_MAX_UNITS } from "../telegram/service-requests"
import { localTimeSchema } from "../time"

const chatArgument = z
  .string()
  .describe(
    "The id of the chat the message is in, from `telegram_chat_read`, such as 123456789 or -1001234567890. Saved Messages is the user's own chat (`kind` `self`). A name, username or phone number is not a chat.",
  )

const idArgument = z
  .number()
  .int()
  .positive()
  .describe("The id of the user's own message in that chat, as `telegram_chat_read` gives it.")

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
