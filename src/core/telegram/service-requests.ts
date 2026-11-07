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
