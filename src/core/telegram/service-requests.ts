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
  /** Supergroups and channels put on the sync list: `SyncChangeParams` → `SyncAddResult`. */
  sync_add: "sync_add",
  /** Supergroups and channels taken off the sync list: `SyncChangeParams` → `SyncRemoveResult`. */
  sync_remove: "sync_remove",
  /** One message's file taken from Telegram into a fresh folder of the label's `incoming/`: `DownloadParams` → `DownloadResult`. */
  download: "download",
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

/** The most chats on the sync list. */
export const SYNC_LIST_LIMIT = 30

/** Chats to put on or take off the sync list; the whole call is refused when one of them cannot be. */
export type SyncChangeParams = {
  /** 1 to `SYNC_LIST_LIMIT` distinct supergroups or channels the mirror lists. */
  chats: string[]
}

/**
 * What adding changed: the chats now on the list that were not (`added`, to
 * be seeded within seconds), those that already were (`listed`), and how many
 * chats the list holds now.
 */
export type SyncAddResult = { added: string[]; listed: string[]; size: number }

/**
 * What removing changed: the chats taken off, their mirrored messages deleted
 * (`removed`), those that were not on the list (`absent`), and how many chats
 * the list holds now.
 */
export type SyncRemoveResult = { removed: string[]; absent: string[]; size: number }

/** Bytes in the megabyte the download limit is told in. */
export const BYTES_PER_MB = 1024 * 1024

/** The largest download limit a request may send (2000 MB): Telegram takes files of several gigabytes. */
export const DOWNLOAD_MAX_BYTES = 2000 * BYTES_PER_MB

/** The file of one message, taken from Telegram again, since the mirror keeps no file id or reference. */
export type DownloadParams = {
  /** A chat the mirror lists, mirrored or not. */
  chat: string
  /** The message in that chat. */
  id: number
  /** 1 to `DOWNLOAD_MAX_BYTES`: a file declaring more is refused, and a download that passes it stops. */
  max_bytes: number
}

/** What Telegram declares of a message's file; the sender chose the name and the type. */
export type DeclaredFile = {
  /** The file name as Telegram gives it, unchanged; `null` when it has none (a photo). */
  name: string | null
  /** The declared MIME type. */
  type: string | null
  /** The declared size in bytes; `null` when Telegram gives none. */
  size: number | null
  /** The media type as the mirror names it: `photo`, `video`, `document`, `audio`, `voice`, `sticker`. */
  kind: string
}

/**
 * A file downloaded as `file` into a folder of its own, mode 700, under the
 * label's `incoming/`: `path` is absolute, and `size` is the bytes written.
 * The caller reads that folder and removes it. `disappears_at` (Unix
 * milliseconds) is set when the message disappears by its chat's timer.
 */
export type SavedFile = Omit<DeclaredFile, "size"> & { path: string; size: number; disappears_at?: number }

/** A file the service did not download, and why; a refusal is an answer, not an error. */
export type RefusedFile = DeclaredFile & { reason: string }

/** Either the file was downloaded, or it was refused with nothing left on disk. */
export type DownloadResult = { saved: SavedFile } | { refused: RefusedFile }
