import { ToolError } from "../errors"
import { clampLimit } from "../pages"
import type { Mirror } from "../telegram/mirror"
import type { ChatRow } from "../telegram/mirror-rows"
import type { FetchParams, FetchResult } from "../telegram/service-requests"
import { formatLocalTime } from "../time"
import { chatEntry, existingChat, requireChatId } from "./chat-rows"
import { DATA_NOTE } from "./message-schema"
import { FETCH_PAGES, type ChatReadInput, type ChatReadOutput } from "./schema"

/** What a fetch of a chat the mirror does not keep says. */
const NOT_MIRRORED_MESSAGE = "This chat is not mirrored; read it live with view."

/** A request for older history of a mirrored chat, and the chat it is for. */
export type FetchRead = { chat: ChatRow; request: FetchParams }

/**
 * The `fetch` method, first part: checks that the mirror keeps the chat and
 * works out what to ask the service. The mirror is not needed afterwards, so
 * it can be closed before the request.
 */
export function planFetch(mirror: Mirror, args: Pick<ChatReadInput, "chat" | "pages">): FetchRead {
  const chatId = requireChatId(args.chat, "fetch")
  const pages = clampLimit(args.pages, FETCH_PAGES, "pages")
  const chat = existingChat(mirror, chatId)
  if (!chat.followed) throw new ToolError("invalid_argument", NOT_MIRRORED_MESSAGE)
  return { chat, request: { chat: chat.id, pages } }
}

/** The `fetch` method, second part: what the service stored as a result. */
export function fetchResult(read: FetchRead, stored: FetchResult): ChatReadOutput {
  return {
    chat: chatEntry(read.chat),
    fetched: {
      added: stored.added,
      pages: stored.pages,
      complete: stored.complete,
      oldest_at: stored.oldest_ts === null ? null : formatLocalTime(stored.oldest_ts),
    },
    note: DATA_NOTE,
  }
}
