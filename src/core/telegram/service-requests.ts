import type { MessageInput } from "./mirror-input"

/**
 * The requests the sync service answers for the tools besides `status`, by
 * name. Parameters and results are JSON; times are Unix milliseconds, and a
 * chat is its marked id as text.
 */
export const SERVICE_REQUESTS = {
  /** A live read of a chat the mirror does not keep: `HistoryParams` → `HistoryResult`. */
  history: "history",
  /** A forum supergroup's topics, live: `TopicsParams` → `TopicsResult`. */
  topics: "topics",
  /** The chat list taken from Telegram now: no parameters → `RefreshResult`. */
  refresh: "refresh",
  /** A live read of the messages around one, in a chat the mirror does not keep: `AroundParams` → `AroundResult`. */
  around: "around",
  /** Older history of a chat the mirror keeps, fetched into the mirror: `FetchParams` → `FetchResult`. */
  fetch: "fetch",
} as const

/** The most messages one live read returns. */
export const HISTORY_LIMIT = 100

/** The most topics one request returns. */
export const TOPICS_LIMIT = 100

/** A live read: the newest messages of `chat` that match, newest first. */
export type HistoryParams = {
  /** A chat the mirror lists and does not keep. */
  chat: string
  /** 1 to `HISTORY_LIMIT`. */
  limit: number
  /** Only messages of this forum topic; the General topic is 1. */
  topic?: number
  /** Only messages with a smaller id: where the previous page ended. */
  before_id?: number
  /** Only messages sent after this time (exclusive). */
  after?: number
  /** Only messages sent before this time (exclusive). */
  before?: number
}

/** What a live read found, newest first, stored nowhere; `more` when older ones that match remain. */
export type HistoryResult = { messages: MessageInput[]; more: boolean }

/** Where a page of topics ended, as Telegram pages them. */
export type TopicsOffset = { date: number; id: number; topic: number }

/** A forum supergroup's topics, most recently active first. */
export type TopicsParams = {
  /** A forum supergroup the mirror lists. */
  chat: string
  /** 1 to `TOPICS_LIMIT`. */
  limit: number
  /** Where the previous page ended. */
  offset?: TopicsOffset
}

/** One forum topic as Telegram lists it. */
export type TopicInfo = {
  id: number
  title: string | null
  closed: boolean
  pinned: boolean
  /** Messages the user has not read in it. */
  unread: number
  /** When its newest message was sent; `null` when not known. */
  last_ts: number | null
}

/** A page of topics; `next` when more remain. */
export type TopicsResult = { topics: TopicInfo[]; next?: TopicsOffset }

/** When the chat list was taken from Telegram: now, or a moment ago when it was taken within the last minute. */
export type RefreshResult = { refreshed_at: number }

/** The most messages on each side of the one `around` reads. */
export const AROUND_LIMIT = 50

/** A live read of message `id` with up to `before_count` older and `after_count` newer messages of `chat`. */
export type AroundParams = {
  /** A chat the mirror lists and does not keep. */
  chat: string
  /** The message in the middle. */
  id: number
  /** 0 to `AROUND_LIMIT`. */
  before_count: number
  /** 0 to `AROUND_LIMIT`. */
  after_count: number
  /** Only messages of this forum topic; the General topic is 1. */
  topic?: number
}

/** The message `id` and those around it, newest first, stored nowhere; a missing `id` is `not_found`. */
export type AroundResult = { messages: MessageInput[] }

/** A history fetch's page size: Telegram's largest. */
export const FETCH_PAGE_SIZE = 100

/** The most pages one history fetch takes. */
export const FETCH_PAGE_LIMIT = 5

/** Older history of a chat the mirror keeps, page after page from its oldest stored message, paced. */
export type FetchParams = {
  /** A chat the mirror keeps. */
  chat: string
  /** 1 to `FETCH_PAGE_LIMIT`. */
  pages: number
}

/**
 * What a history fetch stored: `added` messages over `pages` pages, the time
 * of the oldest message the mirror now has of the chat (`null` when none), and
 * `complete` once Telegram has nothing older.
 */
export type FetchResult = { added: number; pages: number; oldest_ts: number | null; complete: boolean }
