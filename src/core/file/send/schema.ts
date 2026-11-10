import { z } from "zod"
import { accountArgument } from "../../chat/schema"
import { input as messageInput } from "../../message/schema"
import { MAX_FILES } from "../../outgoing/limits"
import { CAPTION_MAX_UNITS } from "../../telegram/service-requests"
import { localTimeSchema } from "../../time"

/** The pattern of a SHA-256 given as 64 hexadecimal digits, in either case. */
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/

const fileArgument = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The file's path, absolute or relative to the working directory; a leading ~ is not expanded. It must be in the working directory or a send directory, and not a key, secret, program or installer.",
    ),
  sha256: z
    .string()
    .regex(SHA256_PATTERN, "must be 64 hexadecimal digits")
    .optional()
    .describe(
      "The SHA-256 of the file as the user approved it, 64 hexadecimal digits. A file that differs is refused as `stale`. Without it the file is sent as it is when the call runs.",
    ),
})

/** The input schema for `telegram_file_send`. */
export const input = z.object({
  account: accountArgument,
  chat: messageInput.shape.chat,
  files: z
    .array(fileArgument)
    .min(1)
    .max(MAX_FILES)
    .describe(`1 to ${MAX_FILES} files, each at most once; all together within the size a send takes (100 MB).`),
  caption: z
    .string()
    .optional()
    .describe(
      `A caption sent with the files, exactly as it should arrive; it is never read as Markdown or HTML. Surrounding blank space is trimmed, and what is left is at most ${CAPTION_MAX_UNITS} characters. Left out or blank, only the files are sent.`,
    ),
  topic: messageInput.shape.topic,
  reply_to: messageInput.shape.reply_to,
})

const sentFile = z.object({
  path: z.string().describe("The file's real path, with links resolved."),
  name: z.string().describe("The name it was sent under."),
  size: z.number().int().describe("Its size in bytes."),
  sha256: z.string().describe("Its SHA-256 as it was sent, in lower-case hexadecimal."),
})

/** The output schema for `telegram_file_send`. */
export const output = z.object({
  chat: z.string().describe("The chat the files were sent to."),
  messages: z
    .array(z.object({ id: z.number().int(), name: z.string() }))
    .optional()
    .describe(
      "The sent messages' ids in that chat, one per file, with the name it was sent under; after a `duplicate`, only those the mirror already has.",
    ),
  time: localTimeSchema.optional().describe("When Telegram dated the first message, in local time with offset."),
  duplicate: z
    .literal(true)
    .optional()
    .describe(
      "Set when Telegram had already received this same call: the files went out once, and no second copy exists.",
    ),
  files: sentFile.array().describe("The files that were sent, in the order given."),
  note: z.string().describe("What the result means."),
})

/** The arguments of `telegram_file_send`, parsed. */
export type FileSendArguments = z.output<typeof input>

/** What the `telegram_file_send` tool returns on success. */
export type FileSendOutput = z.input<typeof output>
