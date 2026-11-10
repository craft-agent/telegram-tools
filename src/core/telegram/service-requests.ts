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
  /** One message's file, kept or taken from Telegram, in a fresh folder of the label's `incoming/`: `DownloadParams` → `DownloadResult`. */
  download: "download",
  /** One text sent to a chat, with one `random_id`, and recorded in the mirror: `SendParams` → `SendResult`. */
  send: "send",
  /** Files of the label's `outbox/` uploaded and sent to a chat in one call, and recorded in the mirror: `SendFilesParams` → `SendFilesResult`. */
  sendFiles: "send_files",
  /** The text or caption of one of the user's own messages replaced, and recorded in the mirror: `EditParams` → `EditResult`. */
  edit: "edit",
  /** One of the user's own messages deleted for everyone, and removed from the mirror: `DeleteParams` → `DeleteResult`. */
  delete: "delete",
  /** The user's own reaction on a message set to one emoji, or removed, and recorded in the mirror: `ReactParams` → `ReactResult`. */
  react: "react",
  /** A message pinned or unpinned; a pin that tells the members is recorded in the mirror as the service message it makes: `PinParams` → `PinResult`. */
  pin: "pin",
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
 * `kept` is set when the file is a copy that `keep_disappearing` kept as the
 * message arrived, served without asking Telegram.
 */
export type SavedFile = Omit<DeclaredFile, "size"> & {
  path: string
  size: number
  disappears_at?: number
  kept?: true
}

/** A file the service did not download, and why; a refusal is an answer, not an error. */
export type RefusedFile = DeclaredFile & { reason: string }

/** Either the file was downloaded, or it was refused with nothing left on disk. */
export type DownloadResult = { saved: SavedFile } | { refused: RefusedFile }

/** The most UTF-16 units a text may have, as Telegram counts the length of a message. */
export const TEXT_MAX_UNITS = 4096

/** The id of the General topic of a forum: its messages carry no topic header. */
export const GENERAL_TOPIC = 1

/** One text sent to a chat, exactly as written. */
export type SendParams = {
  /** A chat the mirror lists. */
  chat: string
  /** Not blank, equal to itself trimmed, and at most `TEXT_MAX_UNITS` UTF-16 units long. */
  text: string
  /** The forum topic to send to; the chat must be a forum, and the General topic is `GENERAL_TOPIC`. */
  topic?: number
  /** The message in that chat to reply to. */
  reply_to?: number
}

/**
 * What Telegram accepted: the sent message's `id` and its time (Unix
 * milliseconds) when Telegram gave them. `duplicate` is set when Telegram
 * answered `RANDOM_ID_DUPLICATE`: an earlier delivery of this call landed and
 * no second message exists; `id` is then given only when the mirror has the
 * message, and `date` is left out.
 */
export type SendResult = { id?: number; date?: number; duplicate?: true }

/** The most UTF-16 units a caption may have, as Telegram counts it (the limit of an account without Premium). */
export const CAPTION_MAX_UNITS = 1024

/** The most files one send carries: Telegram groups at most 10. */
export const SEND_FILES_MAX = 10

/** The most bytes the files of one send may have together. */
export const SEND_FILES_MAX_BYTES = 100 * BYTES_PER_MB

/** One file of a send: where it is, and the name it arrives with. */
export type SendFile = {
  /** An absolute path of a regular file in the label's `outbox/`; links are refused. */
  path: string
  /** A plain file name: no `/`, not `.` or `..`, equal to itself trimmed, at most 255 bytes. */
  name: string
}

/** Files sent to a chat as files, in one group, with an optional caption on the last. */
export type SendFilesParams = {
  /** A chat the mirror lists. */
  chat: string
  /** 1 to `SEND_FILES_MAX` files with distinct paths, each not empty, `SEND_FILES_MAX_BYTES` together. */
  files: SendFile[]
  /** Not blank, equal to itself trimmed, and at most `CAPTION_MAX_UNITS` UTF-16 units long. */
  caption?: string
  /** The forum topic to send to; the chat must be a forum, and the General topic is `GENERAL_TOPIC`. */
  topic?: number
  /** The message in that chat to reply to. */
  reply_to?: number
}

/** One message of a file send Telegram accepted: its id, and the file name it carries. */
export type SentFile = { id: number; name: string }

/**
 * What Telegram accepted: the sent messages' ids by file name, in the order of
 * the files, and the time of the first (Unix milliseconds). `duplicate` is set
 * when Telegram answered `RANDOM_ID_DUPLICATE`: an earlier delivery of this
 * call landed and no second message exists; `messages` then holds only the
 * files the mirror can name, and is left out when it can name none.
 */
export type SendFilesResult = { messages?: SentFile[]; date?: number; duplicate?: true }

/** The text, or the caption, of one of the user's own messages replaced, exactly as written. */
export type EditParams = {
  /** A chat the mirror lists and the account has not left. */
  chat: string
  /** The message in that chat: the user's own, which the mirror holds, with a text or a caption. */
  id: number
  /** Not blank, equal to itself trimmed, at most `TEXT_MAX_UNITS` UTF-16 units long (`CAPTION_MAX_UNITS` for a caption), and not the text the message has. */
  text: string
}

/**
 * What Telegram accepted: the message's `id` and the time of its edit (Unix
 * milliseconds). `already` is set when Telegram answered that the message
 * already has the text, so that an earlier delivery of this call landed; the
 * time is then left out unless the mirror has the message with this text by
 * then, since Telegram does not say when the earlier delivery was made.
 */
export type EditResult = { id: number; edited?: number; already?: true }

/** One of the user's own messages deleted for everyone. */
export type DeleteParams = {
  /** A chat the mirror lists and the account has not left. */
  chat: string
  /** The message in that chat: the user's own, which the mirror holds. */
  id: number
}

/**
 * The message `id` is gone. `already` is set when it was gone before this call
 * deleted anything: the mirror had it as deleted, or Telegram counted no
 * message deleted.
 */
export type DeleteResult = { id: number; deleted: true; already?: true }

/** The most UTF-16 units a reaction's emoji may have: room for a skin tone or a joined sequence, far short of any text. */
export const REACTION_MAX_UNITS = 64

/** The user's own reaction on a message set to one emoji, replacing the one they had, or removed. */
export type ReactParams = {
  /** A chat the mirror lists and the account has not left. */
  chat: string
  /** The message in that chat, anyone's, which the mirror holds. */
  id: number
  /** One standard emoji, at most `REACTION_MAX_UNITS` UTF-16 units, with no letters, digits or blank space; given exactly when `remove` is not. */
  emoji?: string
  /** `true` removes the user's own reaction; given exactly when `emoji` is not. */
  remove?: boolean
}

/**
 * The reaction the message has from the user now: `emoji` when set, `removed`
 * when taken away. `already` is set when it was so before this call: the
 * mirror showed the emoji as the user's own, or Telegram answered that the
 * reaction is unchanged.
 */
export type ReactResult = { id: number; emoji?: string; removed?: true; already?: true }

/** A message pinned or unpinned. */
export type PinParams = {
  /** A chat the mirror lists and the account has not left. */
  chat: string
  /** The message in that chat, anyone's, which the mirror holds. */
  id: number
  /** `true` unpins the message; then `notify` and `both_sides` are not given as `true`. */
  unpin?: boolean
  /** `true` tells the members of a group that the message was pinned; left out, the pin is silent. */
  notify?: boolean
  /** `true` pins in a private chat for the other person too, which only a chat with a person or a bot has; left out, the pin is the user's own. */
  both_sides?: boolean
}

/**
 * Whether the message is pinned now: the opposite of what `unpin` asked.
 * `already` is set when Telegram answered that the chat is unchanged, so that
 * the message was in that state before this call.
 */
export type PinResult = { id: number; pinned: boolean; already?: true }
