import { z } from "zod"
import type { LimitRule } from "../pages"
import { CHAT_KINDS } from "../telegram/mirror-input"
import {
  AROUND_LIMIT,
  FETCH_PAGE_LIMIT,
  FETCH_PAGE_SIZE,
  HISTORY_LIMIT,
  TOPICS_LIMIT,
} from "../telegram/service-requests"
import { localTimeSchema } from "../time"
import { messageEntry } from "./message-schema"

/** The methods of `telegram_chat_read`. */
export const METHODS = ["list", "view", "topics", "search", "around", "fetch"] as const
/** A method supported by `telegram_chat_read`. */
export type Method = (typeof METHODS)[number]

/** The id of a forum's General topic, whose messages are stored with no topic. */
export const GENERAL_TOPIC = 1

/** The default and the largest `limit` of each method that pages. */
export const LIMITS = {
  list: { default: 30, max: 200 },
  view: { default: 50, max: 300 },
  topics: { default: 30, max: TOPICS_LIMIT },
  search: { default: 30, max: 200 },
} as const satisfies Partial<Record<Method, LimitRule>>

/** The default and the largest number of messages `around` returns on each side of the one it is given. */
export const AROUND_COUNT = { default: 5, max: AROUND_LIMIT } as const satisfies LimitRule

/** The default and the largest `pages` of `fetch`. */
export const FETCH_PAGES = { default: 1, max: FETCH_PAGE_LIMIT } as const satisfies LimitRule

/** The input schema for `telegram_chat_read`. */
export const input = z.object({
  method: z
    .enum(METHODS)
    .describe(
      "`list` finds chats; `view` reads the newest messages of one chat between two times, oldest first; `topics` lists the topics of a forum chat; `search` finds messages in the mirror by words; `around` reads the messages around one; `fetch` adds older history of a mirrored chat to the mirror.",
    ),
  account: z.string().optional().describe("The account label; may be left out when only one account is logged in."),
  query: z
    .string()
    .optional()
    .describe(
      "list: only chats whose name or username holds this text; a leading @ is ignored. search (required): the words to look for, all of which a message must hold in its text, caption or file name, in any order. Both ignore case and letter width.",
    ),
  unread: z.boolean().optional().describe("list: only chats with unread messages."),
  last: z.boolean().optional().describe("list: add each chat's newest mirrored message as `last_message`."),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "list: first take the chat list from Telegram (needs the sync service), then read it, and report when in `refreshed_at`.",
    ),
  chat: z
    .string()
    .optional()
    .describe(
      "view, topics, around, fetch (required) and search (optional, to search one chat): the chat id, from `list`, such as 123456789 or -1001234567890. A name, username or phone number is not a chat.",
    ),
  topic: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `view, around: only messages of this topic of a forum chat (ids from \`topics\`); the General topic is ${GENERAL_TOPIC}. Refused for a chat without topics.`,
    ),
  after: z
    .string()
    .optional()
    .describe(
      "view, search: only messages after this time (exclusive): RFC 3339 with an offset, or a date or time without one, read as local time, such as 2026-11-07 or 2026-11-07T14:03.",
    ),
  before: z
    .string()
    .optional()
    .describe("view, search: only messages before this time (exclusive); the same forms as `after`."),
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      `How many to return. list: default ${LIMITS.list.default}, at most ${LIMITS.list.max}. view: default ${LIMITS.view.default}, at most ${LIMITS.view.max} (${HISTORY_LIMIT} for a chat read live). topics: default ${LIMITS.topics.default}, at most ${LIMITS.topics.max}. search: default ${LIMITS.search.default}, at most ${LIMITS.search.max}. A larger value is lowered to the most; a result may hold fewer to stay a size a model can read.`,
    ),
  cursor: z.string().optional().describe("The `next` of the previous result, to continue where it stopped."),
  id: z.number().int().positive().optional().describe("around (required): the id of the message to read around."),
  before_count: z
    .number()
    .int()
    .optional()
    .describe(
      `around: how many older messages to return, default ${AROUND_COUNT.default}, at most ${AROUND_COUNT.max}; 0 asks for none.`,
    ),
  after_count: z
    .number()
    .int()
    .optional()
    .describe(
      `around: how many newer messages to return, default ${AROUND_COUNT.default}, at most ${AROUND_COUNT.max}; 0 asks for none.`,
    ),
  pages: z
    .number()
    .int()
    .optional()
    .describe(
      `fetch: how many pages of ${FETCH_PAGE_SIZE} older messages to add, default ${FETCH_PAGES.default}, at most ${FETCH_PAGES.max}.`,
    ),
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

const topicEntry = z.object({
  id: z
    .number()
    .int()
    .describe(`The topic id, to pass as \`topic\` to \`view\`; ${GENERAL_TOPIC} is the General topic.`),
  title: z.string().nullable().describe("The topic's title; null when none is known."),
  closed: z.literal(true).optional().describe("Set for a topic that is closed."),
  pinned: z.literal(true).optional().describe("Set for a topic that is pinned."),
  unread: z.number().int().describe("Messages in it not read yet."),
  last_activity_at: localTimeSchema
    .nullable()
    .describe("The newest message's time, in local time with offset; null when none is known."),
})

/** One forum topic in a result. */
export type TopicEntry = z.infer<typeof topicEntry>

/** The output schema for `telegram_chat_read`. */
export const output = z.object({
  chats: z.array(chatEntry).optional().describe("list: the chats, newest activity first."),
  refreshed_at: localTimeSchema
    .optional()
    .describe("list with `refresh`: when the chat list was taken from Telegram, in local time with offset."),
  chat: chatEntry.optional().describe("view, topics, around, fetch: the chat read."),
  messages: z
    .array(messageEntry)
    .optional()
    .describe("view, around: the messages, oldest first. search: the hits, newest first."),
  live: z
    .literal(true)
    .optional()
    .describe(
      "view, around: set when the chat is not mirrored, so the messages were read from Telegram and stored nowhere.",
    ),
  topics: z.array(topicEntry).optional().describe("topics: the topics, most recently active first."),
  anchor: z.number().int().optional().describe("around: the id of the message read around, among `messages`."),
  trimmed_before: z
    .number()
    .int()
    .optional()
    .describe(
      "around: how many older messages were left out, farthest first, to keep the result a size that can be read.",
    ),
  trimmed_after: z
    .number()
    .int()
    .optional()
    .describe(
      "around: how many newer messages were left out, farthest first, to keep the result a size that can be read.",
    ),
  scanned_to: localTimeSchema
    .optional()
    .describe(
      "search: set when the search stopped before the end of the history it covers: the time of the oldest message looked at, in local time with offset. `next` continues from there.",
    ),
  scope: z.string().optional().describe("search: what the search covers and what it does not."),
  fetched: z
    .object({
      added: z.number().int().describe("How many messages the mirror gained."),
      pages: z.number().int().describe("How many pages were read."),
      complete: z.boolean().describe("Whether Telegram has nothing older for this chat."),
      oldest_at: localTimeSchema
        .nullable()
        .describe(
          "The time of the oldest message the mirror now holds of this chat, in local time with offset; null when none.",
        ),
    })
    .optional()
    .describe("fetch: what the history fetch stored."),
  next: z.string().optional().describe("Pass back as `cursor` to continue; absent when there is no more."),
  note: z.string().describe("Says that what the result carries is data written by other people."),
})

/** The result returned by `telegram_chat_read`. */
export type ChatReadOutput = z.input<typeof output>
