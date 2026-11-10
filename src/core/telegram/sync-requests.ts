import type { ForumTopic, Message } from "@mtcute/core"
import { ToolError } from "../errors"
import { messageInputOf } from "./from-mtcute"
import type { Mirror } from "./mirror"
import type { MessageInput } from "./mirror-input"
import { findChat } from "./mirror-rows"
import {
  FETCH_PAGE_SIZE,
  SERVICE_REQUESTS,
  type AroundParams,
  type AroundResult,
  type FetchResult,
  type HistoryParams,
  type HistoryResult,
  type RefreshResult,
  type TopicInfo,
  type TopicsResult,
} from "./service-requests"
import { afterAnswered, type ServiceCall, type ServiceHandler } from "./service-server"
import type { ChatListRefresh } from "./sync-chat-refresh"
import { pace, storeFetched } from "./sync-fetch"
import { downloadRequest } from "./sync-download"
import { syncAdd, syncRemove } from "./sync-list-requests"
import type { ResolvedSyncOptions } from "./sync-options"
import { errorLabel } from "./sync-outcome"
import { listedChat, viaTelegram } from "./sync-request-calls"
import {
  INT32_MAX,
  expectNoParams,
  parseAroundParams,
  parseFetchParams,
  parseHistoryParams,
  parseTopicsParams,
} from "./sync-request-params"
import { RequestQueue } from "./sync-request-queue"
import { deleteRequest } from "./sync-delete"
import { editRequest } from "./sync-edit"
import { pinRequest } from "./sync-pin"
import { reactRequest } from "./sync-react"
import { sendRequest } from "./sync-send"
import { sendFilesRequest } from "./sync-send-files"
import type { SyncTelegram } from "./sync-telegram"

const SECOND_MS = 1000

/** What the requests work with; the service has all of it when it starts answering. */
export type SyncRequestsContext = {
  client: SyncTelegram
  mirror: Mirror
  settings: ResolvedSyncOptions
  /** Aborts when the run ends. */
  signal: AbortSignal
  refresh: ChatListRefresh
  /** Runs the downloads one at a time: the `download` requests and the files kept as they arrive share it. */
  downloads: RequestQueue
  /** Ends the run, since Telegram ended the session. */
  endSession(): void
  /** Ends the run for a failure of the service's own, such as a mirror that cannot be written. */
  failRun(error: unknown): void
  /** Removes the kept files of chats whose messages the mirror no longer has. */
  forgetChats(chats: readonly string[]): void
}

/**
 * `ctx` for one call: whatever it does to end the run (the session found
 * ended, a mirror that cannot be written) waits until the call's answer has
 * been written, since ending the run closes the sockets and would lose it.
 * A session found ended still stops the rest of this call at once, as ending
 * the run did: its `signal` aborts, while the run itself ends after the answer.
 */
function callContext(ctx: SyncRequestsContext, call: ServiceCall): SyncRequestsContext {
  const sessionEnded = new AbortController()
  return {
    ...ctx,
    signal: AbortSignal.any([ctx.signal, sessionEnded.signal]),
    endSession: () => {
      sessionEnded.abort()
      afterAnswered(call, ctx.endSession)
    },
    failRun: (error) => afterAnswered(call, () => ctx.failRun(error)),
  }
}

/** Milliseconds as the Telegram second at or after them. */
function secondsAtOrAfter(ms: number): number {
  return Math.min(Math.ceil(ms / SECOND_MS), INT32_MAX)
}

/** Milliseconds as the Telegram second at or before them. */
function secondsAtOrBefore(ms: number): number {
  return Math.min(Math.floor(ms / SECOND_MS), INT32_MAX)
}

/** Refuses a live read of a chat the mirror keeps: that one is read from the mirror. */
function expectUnmirrored(mirror: Mirror, id: string): void {
  if (listedChat(mirror, id).followed) {
    throw new ToolError("invalid_argument", "This chat is mirrored; read it from the mirror.")
  }
}

/** The messages of a page that the mirror's shape can describe; one that cannot be read is left out. */
function inputsOf(page: Message[]): MessageInput[] {
  const inputs: MessageInput[] = []
  for (const message of page) {
    try {
      const input = messageInputOf(message)
      if (input) inputs.push(input)
    } catch {
      // One unreadable message does not cost the page.
    }
  }
  return inputs
}

/** Whether no message can match the bounds: ids start at 1 and times are whole milliseconds. */
function matchesNothing({ after, before, before_id }: HistoryParams): boolean {
  return before_id === 1 || (before !== undefined && before <= (after ?? -1) + 1)
}

/** The page of a live read, as Telegram gives it for these parameters. */
function fetchPage(ctx: SyncRequestsContext, params: HistoryParams): Promise<Message[]> {
  const { chat, limit, topic, before_id, after, before } = params
  const chatId = Number(chat)
  if (topic === undefined) {
    const offset = { id: before_id ?? 0, date: before === undefined ? 0 : secondsAtOrAfter(before) }
    return ctx.client.getHistory(chatId, { limit, offset })
  }
  return ctx.client.searchMessages({
    chatId,
    query: "",
    threadId: topic,
    offset: before_id ?? 0,
    limit,
    ...(after === undefined ? {} : { minDate: secondsAtOrBefore(after) }),
    ...(before === undefined ? {} : { maxDate: secondsAtOrAfter(before) }),
  })
}

async function history(ctx: SyncRequestsContext, raw: unknown, call: ServiceCall): Promise<HistoryResult> {
  const params = parseHistoryParams(raw)
  expectUnmirrored(ctx.mirror, params.chat)
  if (matchesNothing(params)) return { messages: [], more: false }

  const page = await viaTelegram(ctx, call, "history", () => fetchPage(ctx, params))
  const { after, before, before_id } = params
  const inputs = inputsOf(page)
  const messages = inputs
    .filter(
      (message) =>
        (after === undefined || message.ts > after) &&
        (before === undefined || message.ts < before) &&
        (before_id === undefined || message.id < before_id),
    )
    .sort((a, b) => b.id - a.id)
  // Newest first: once a message is not after `after`, nothing older is either.
  const reachedAfter = after !== undefined && inputs.some((message) => message.ts <= after)
  return { messages, more: page.length >= params.limit && !reachedAfter }
}

/** The last time anything was sent in a topic, or null when Telegram did not bring its newest message. */
function lastTsOf(topic: ForumTopic): number | null {
  try {
    return topic.lastMessage.date.getTime()
  } catch {
    return null
  }
}

function topicInfoOf(topic: ForumTopic): TopicInfo {
  return {
    id: topic.id,
    title: topic.titleMissing ? null : topic.title,
    closed: Boolean(topic.isClosed),
    pinned: Boolean(topic.isPinned),
    unread: topic.unreadCount ?? 0,
    last_ts: lastTsOf(topic),
  }
}

async function topics(ctx: SyncRequestsContext, raw: unknown, call: ServiceCall): Promise<TopicsResult> {
  const { chat, limit, offset } = parseTopicsParams(raw)
  const row = listedChat(ctx.mirror, chat)
  if (row.kind !== "supergroup" || !row.forum) throw new ToolError("invalid_argument", "This chat has no topics.")

  const page = await viaTelegram(ctx, call, "topics", () =>
    ctx.client.getForumTopics(Number(chat), { limit, ...(offset ? { offset } : {}) }),
  )
  // mtcute sets `next` from the last topic even on the final page; a short page is the last.
  const next = page.length < limit ? undefined : page.next
  return {
    topics: page.map(topicInfoOf),
    ...(next ? { next: { date: next.date, id: next.id, topic: next.topic } } : {}),
  }
}

async function refresh(ctx: SyncRequestsContext, raw: unknown, call: ServiceCall): Promise<RefreshResult> {
  expectNoParams(raw, "The refresh request")
  const refreshedAt = await viaTelegram(ctx, call, "refresh", (signal) => ctx.refresh.request(signal))
  return { refreshed_at: refreshedAt }
}

/**
 * The page of Telegram's history that holds message `id` with `before_count`
 * older and `after_count` newer messages. Telegram's offset id is exclusive
 * (it counts from the message below it), so `id + 1` puts the anchor first
 * and the negative `addOffset` moves the window up over the newer ones.
 */
function aroundPage(ctx: SyncRequestsContext, params: AroundParams): Promise<Message[]> {
  const { chat, id, before_count, after_count, topic } = params
  const chatId = Number(chat)
  const offset = Math.min(id + 1, INT32_MAX)
  const addOffset = 0 - after_count
  const limit = before_count + after_count + 1
  if (topic === undefined) return ctx.client.getHistory(chatId, { offset: { id: offset, date: 0 }, addOffset, limit })
  return ctx.client.searchMessages({ chatId, query: "", threadId: topic, offset, addOffset, limit })
}

async function around(ctx: SyncRequestsContext, raw: unknown, call: ServiceCall): Promise<AroundResult> {
  const params = parseAroundParams(raw)
  expectUnmirrored(ctx.mirror, params.chat)

  const page = await viaTelegram(ctx, call, "around", () => aroundPage(ctx, params))
  const inputs = inputsOf(page)
  const anchor = inputs.find((message) => message.id === params.id)
  if (!anchor) throw new ToolError("not_found", "No message with this id in this chat.")
  // Telegram may fill a page that ran out on one side from the other; only the nearest of each side are kept.
  const older = inputs.filter((message) => message.id < params.id).sort((a, b) => b.id - a.id)
  const newer = inputs.filter((message) => message.id > params.id).sort((a, b) => a.id - b.id)
  return {
    messages: [...newer.slice(0, params.after_count).reverse(), anchor, ...older.slice(0, params.before_count)],
  }
}

function isFollowed(mirror: Mirror, chat: string): boolean {
  return Boolean(findChat(mirror, chat)?.followed)
}

/** The id and the time of the oldest message stored of a chat; both null when it has none. */
function oldestStored(mirror: Mirror, chat: string): { id: number | null; ts: number | null } {
  const row = mirror.prepare("SELECT MIN(id) AS id, MIN(ts) AS ts FROM messages WHERE chat = ?").get(chat)
  return row as { id: number | null; ts: number | null }
}

/**
 * Takes up to `pages` pages of history older than what the mirror has of
 * `chat`, storing each as the service stores what it fills gaps with, a pause
 * between pages. Stops early when the chat is no longer kept or Telegram has
 * nothing older. A failure of Telegram before any page is the request's
 * failure; after some, it ends the fetch with what was stored, and a flood
 * wait is not waited out.
 */
async function fetchPages(
  ctx: SyncRequestsContext,
  call: ServiceCall,
  signal: AbortSignal,
  chat: string,
  pages: number,
): Promise<FetchResult> {
  const { mirror, settings } = ctx
  // Paging from the oldest id seen, not the oldest stored, so that a page the mirror dropped is not asked for again.
  let oldestId = oldestStored(mirror, chat).id
  let added = 0
  let taken = 0
  let complete = false
  while (taken < pages) {
    if (taken > 0) await pace({ settings, signal })
    if (!isFollowed(mirror, chat)) break
    let page: Message[]
    try {
      page = await viaTelegram(ctx, call, "history fetch", () =>
        ctx.client.getHistory(Number(chat), { limit: FETCH_PAGE_SIZE, offset: { id: oldestId ?? 0, date: 0 } }),
      )
    } catch (error) {
      if (taken === 0 || signal.aborted) throw error
      settings.log(`history fetch stopped after ${taken} pages: ${errorLabel(error)}`)
      break
    }
    taken++
    try {
      added += storeFetched(ctx, chat, page)
    } catch (error) {
      ctx.failRun(error)
      throw error
    }
    oldestId = Math.min(oldestId ?? Infinity, ...page.map((message) => message.id))
    if (page.length < FETCH_PAGE_SIZE) {
      complete = isFollowed(mirror, chat)
      break
    }
  }
  return { added, pages: taken, oldest_ts: oldestStored(mirror, chat).ts, complete }
}

async function fetchRequest(
  ctx: SyncRequestsContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<FetchResult> {
  const { chat, pages } = parseFetchParams(raw)
  if (!listedChat(ctx.mirror, chat).followed) {
    throw new ToolError("invalid_argument", "This chat is not mirrored; read it live with view.")
  }
  const signal = AbortSignal.any([call.signal, ctx.signal])
  return queue.run(signal, () => fetchPages(ctx, call, signal, chat, pages))
}

/**
 * The handlers of the requests besides `status` (`SERVICE_REQUESTS`). Each
 * checks its parameters first, since they are untrusted JSON. `history`,
 * `topics` and `around` are reads from Telegram that are stored nowhere;
 * `refresh` is the chat list refresh the housekeeping runs, shared with it;
 * `fetch` writes the mirror through the path the gap filling uses, one fetch
 * at a time for the whole service; `sync_add` and `sync_remove` change the
 * sync list and what the mirror keeps, with no call to Telegram; `download`
 * takes one message's file into the label's `incoming/`, from the copy kept as
 * it arrived or from Telegram, one download at a time (shared with the files
 * being kept) and apart from the fetches; `send` sends one text and records it,
 * and `send_files` uploads and sends files and records them, one send at a time
 * on a queue of their own, so that they wait behind neither a fetch nor a
 * download; `edit` and `delete` change one of the user's own messages and
 * record it, `react` changes the user's reaction on a message and records it,
 * and `pin` pins or unpins a message, on that same queue.
 */
export function syncRequestHandlers(ctx: SyncRequestsContext): Record<string, ServiceHandler> {
  const fetches = new RequestQueue()
  const sends = new RequestQueue()
  return {
    [SERVICE_REQUESTS.history]: (params, call) => history(callContext(ctx, call), params, call),
    [SERVICE_REQUESTS.topics]: (params, call) => topics(callContext(ctx, call), params, call),
    [SERVICE_REQUESTS.refresh]: (params, call) => refresh(callContext(ctx, call), params, call),
    [SERVICE_REQUESTS.around]: (params, call) => around(callContext(ctx, call), params, call),
    [SERVICE_REQUESTS.fetch]: (params, call) => fetchRequest(callContext(ctx, call), fetches, params, call),
    [SERVICE_REQUESTS.sync_add]: (params, call) => syncAdd(callContext(ctx, call), params),
    [SERVICE_REQUESTS.sync_remove]: (params, call) => syncRemove(callContext(ctx, call), params),
    [SERVICE_REQUESTS.download]: (params, call) => downloadRequest(callContext(ctx, call), ctx.downloads, params, call),
    [SERVICE_REQUESTS.send]: (params, call) => sendRequest(callContext(ctx, call), sends, params, call),
    [SERVICE_REQUESTS.sendFiles]: (params, call) => sendFilesRequest(callContext(ctx, call), sends, params, call),
    [SERVICE_REQUESTS.edit]: (params, call) => editRequest(callContext(ctx, call), sends, params, call),
    [SERVICE_REQUESTS.delete]: (params, call) => deleteRequest(callContext(ctx, call), sends, params, call),
    [SERVICE_REQUESTS.react]: (params, call) => reactRequest(callContext(ctx, call), sends, params, call),
    [SERVICE_REQUESTS.pin]: (params, call) => pinRequest(callContext(ctx, call), sends, params, call),
  }
}
