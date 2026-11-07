import { z } from "zod"
import type { LimitRule } from "../pages"
import { CHAT_KINDS } from "../telegram/mirror-input"
import { localTimeSchema } from "../time"
import { messageEntry } from "./message-schema"

/** The methods of `telegram_chat_read`. */
export const METHODS = ["list", "view"] as const
/** A method supported by `telegram_chat_read`. */
export type Method = (typeof METHODS)[number]

/** The default and the largest `limit` of each method that pages. */
export const LIMITS = {
  list: { default: 30, max: 200 },
  view: { default: 50, max: 300 },
} as const satisfies Partial<Record<Method, LimitRule>>

/** The input schema for `telegram_chat_read`. */
export const input = z.object({
  method: z
    .enum(METHODS)
    .describe("`list` finds chats; `view` reads the newest messages of one chat between two times, oldest first."),
  account: z.string().optional().describe("The account label; may be left out when only one account is logged in."),
  query: z
    .string()
    .optional()
    .describe(
      "list: only chats whose name or username holds this text; a leading @ is ignored. Ignores case and letter width.",
    ),
  unread: z.boolean().optional().describe("list: only chats with unread messages."),
  last: z.boolean().optional().describe("list: add each chat's newest mirrored message as `last_message`."),
  chat: z
    .string()
    .optional()
    .describe(
      "view (required): the chat id, from `list`, such as 123456789 or -1001234567890. A name, username or phone number is not a chat.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "view: only messages after this time (exclusive): RFC 3339 with an offset, or a date or time without one, read as local time, such as 2026-11-07 or 2026-11-07T14:03.",
    ),
  before: z
    .string()
    .optional()
    .describe("view: only messages before this time (exclusive); the same forms as `after`."),
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      `How many to return. list: default ${LIMITS.list.default}, at most ${LIMITS.list.max}. view: default ${LIMITS.view.default}, at most ${LIMITS.view.max}. A larger value is lowered to the most; a result may hold fewer to stay a size a model can read.`,
    ),
  cursor: z.string().optional().describe("The `next` of the previous result, to continue where it stopped."),
})

/** The parsed input to `telegram_chat_read`. */
export type ChatReadInput = z.output<typeof input>

const nameCut = z
  .literal(true)
  .optional()
  .describe("Set when the name was longer than the most a result carries and was cut.")

const chatEntry = z.object({
  id: z.string().describe("The chat id: Telegram's signed id as text, such as `123456789` or `-1001234567890`."),
  kind: z.enum(CHAT_KINDS).describe("`self` is Saved Messages."),
  name: z.string().nullable().describe("The person's or chat's name; null when none is known."),
  name_cut: nameCut,
  username: z.string().optional(),
  mirrored: z.boolean().describe("Whether the mirror keeps this chat's messages."),
  unread: z.number().int().describe("Incoming messages not read yet."),
  last_activity_at: localTimeSchema
    .nullable()
    .describe("The latest message's time, in local time with offset; null when none is known."),
  forum: z.literal(true).optional().describe("Set for a supergroup with topics."),
  archived: z.literal(true).optional(),
  left: z.literal(true).optional().describe("Set for a group or channel the user has left or been removed from."),
  can_send: z.literal(false).optional().describe("Set when the user is known not to be able to write here."),
  auto_delete_seconds: z.number().int().optional().describe("The chat's auto-delete period, when on."),
  last_message: messageEntry
    .nullable()
    .optional()
    .describe("With `last`: the newest mirrored message of the chat, or null when none is mirrored."),
})

/** One chat in a result. */
export type ChatEntry = z.infer<typeof chatEntry>

/** The output schema for `telegram_chat_read`. */
export const output = z.object({
  chats: z.array(chatEntry).optional().describe("list: the chats, newest activity first."),
  chat: chatEntry.optional().describe("view: the chat read."),
  messages: z.array(messageEntry).optional().describe("view: the messages, oldest first."),
  next: z.string().optional().describe("Pass back as `cursor` to continue; absent when there is no more."),
  note: z.string().describe("Says that what the result carries is data written by other people."),
})

/** The result returned by `telegram_chat_read`. */
export type ChatReadOutput = z.input<typeof output>
