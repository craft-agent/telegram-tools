import type { ForumTopic, Message } from "@mtcute/core"
import { ToolError } from "../errors"
import { messageInputOf } from "./from-mtcute"
import type { Mirror } from "./mirror"
import type { MessageInput } from "./mirror-input"
import { findChat, type ChatRow } from "./mirror-rows"
import {
  SERVICE_REQUESTS,
  type HistoryParams,
  type HistoryResult,
  type RefreshResult,
  type TopicInfo,
  type TopicsResult,
} from "./service-requests"
import type { ServiceCall, ServiceHandler } from "./service-server"
import type { ChatListRefresh } from "./sync-chat-refresh"
import type { ResolvedSyncOptions } from "./sync-options"
import { abortable, cancelled, requestFailure } from "./sync-request-errors"
import { INT32_MAX, expectNoParams, parseHistoryParams, parseTopicsParams } from "./sync-request-params"
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
  /** Ends the run, since Telegram ended the session. */
  endSession(): void
}

/** Milliseconds as the Telegram second at or after them. */
function secondsAtOrAfter(ms: number): number {
  return Math.min(Math.ceil(ms / SECOND_MS), INT32_MAX)
}

/** Milliseconds as the Telegram second at or before them. */
function secondsAtOrBefore(ms: number): number {
  return Math.min(Math.floor(ms / SECOND_MS), INT32_MAX)
}

/**
 * Runs a call to Telegram for a request: it gives up the moment the request's
 * client leaves or the run ends, and a failure of it becomes the error the
 * request answers with. `what` names the request in the log.
 */
async function viaTelegram<T>(
  ctx: SyncRequestsContext,
  call: ServiceCall,
  what: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.any([call.signal, ctx.signal])
  if (signal.aborted) throw cancelled()
  try {
    return await abortable(work(signal), signal)
  } catch (error) {
    throw requestFailure(error, what, { endSession: ctx.endSession, log: ctx.settings.log })
  }
}

/** The mirror's row for a chat the mirror lists; `not_found` when it does not. */
function listedChat(mirror: Mirror, id: string): ChatRow {
  const row = findChat(mirror, id)
  if (!row) throw new ToolError("not_found", "The chat list has no such chat; refresh it, or check the id.")
  return row
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
  const row = listedChat(ctx.mirror, params.chat)
  if (row.followed) throw new ToolError("invalid_argument", "This chat is mirrored; read it from the mirror.")
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
 * The handlers of the requests besides `status` (`SERVICE_REQUESTS`). Each
 * checks its parameters first, since they are untrusted JSON, and none writes
 * the mirror or marks anything read: `history` and `topics` are reads from
 * Telegram that are stored nowhere, and `refresh` is the chat list refresh the
 * housekeeping runs, shared with it.
 */
export function syncRequestHandlers(ctx: SyncRequestsContext): Record<string, ServiceHandler> {
  return {
    [SERVICE_REQUESTS.history]: (params, call) => history(ctx, params, call),
    [SERVICE_REQUESTS.topics]: (params, call) => topics(ctx, params, call),
    [SERVICE_REQUESTS.refresh]: (params, call) => refresh(ctx, params, call),
  }
}
