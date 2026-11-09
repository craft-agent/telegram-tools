import { z } from "zod"
import { accountArgument } from "../chat/schema"
import { GENERAL_TOPIC, TEXT_MAX_UNITS } from "../telegram/service-requests"
import { localTimeSchema } from "../time"

/** The input schema for `telegram_message_send`. */
export const input = z.object({
  account: accountArgument,
  chat: z
    .string()
    .describe(
      "The chat id, from `telegram_chat_read`, such as 123456789 or -1001234567890. Saved Messages is the user's own chat (`kind` `self`). A name, username or phone number is not a chat.",
    ),
  text: z
    .string()
    .describe(
      `The text exactly as it should arrive; it is never read as Markdown or HTML. Surrounding blank space is trimmed, and what is left is 1 to ${TEXT_MAX_UNITS} characters.`,
    ),
  topic: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `The forum topic to send to, an id from \`telegram_chat_read\` \`topics\`; the General topic is ${GENERAL_TOPIC}. Only for a chat with topics.`,
    ),
  reply_to: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The id of a message of that chat to reply to, as `telegram_chat_read` gives it."),
})

/** The output schema for `telegram_message_send`. */
export const output = z.object({
  chat: z.string().describe("The chat the message was sent to."),
  id: z
    .number()
    .int()
    .optional()
    .describe("The sent message's id in that chat; absent when Telegram had already received it and it is not known."),
  time: localTimeSchema.optional().describe("When Telegram dated it, in local time with offset."),
  duplicate: z
    .literal(true)
    .optional()
    .describe(
      "Set when Telegram had already received this same call: the message went out once, and no second exists.",
    ),
  note: z.string().describe("What the result means."),
})

/** What the tool returns. */
export type SendOutput = z.input<typeof output>
