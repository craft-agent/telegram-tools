import type { MessageInput } from "../telegram/mirror-input"
import { toJson } from "../telegram/mirror-rows"
import { callService } from "../telegram/service"
import {
  SERVICE_REQUESTS,
  type AroundParams,
  type AroundResult,
  type FetchParams,
  type FetchResult,
  type HistoryParams,
  type HistoryResult,
  type RefreshResult,
  type TopicsParams,
  type TopicsResult,
} from "../telegram/service-requests"
import type { StoredMessage } from "./message-rows"

/** How long a refresh of the chat list may take: the service reads every dialog from Telegram, paced. */
export const REFRESH_TIMEOUT_MS = 120_000

/** How long a history fetch may take: up to five pages from Telegram, paced. */
export const FETCH_TIMEOUT_MS = 180_000

/** Milliseconds in a second: `ttl` is in seconds, times in milliseconds. */
const MS_PER_S = 1000

/** A live read of a chat the mirror does not keep. */
export function requestHistory(socket: string, params: HistoryParams, signal?: AbortSignal): Promise<HistoryResult> {
  return callService<HistoryResult>(socket, SERVICE_REQUESTS.history, params, { effect: "read", signal })
}

/** A forum's topics, read live. */
export function requestTopics(socket: string, params: TopicsParams, signal?: AbortSignal): Promise<TopicsResult> {
  return callService<TopicsResult>(socket, SERVICE_REQUESTS.topics, params, { effect: "read", signal })
}

/** A live read of the messages around one, in a chat the mirror does not keep. */
export function requestAround(socket: string, params: AroundParams, signal?: AbortSignal): Promise<AroundResult> {
  return callService<AroundResult>(socket, SERVICE_REQUESTS.around, params, { effect: "read", signal })
}

/** Older history of a mirrored chat, fetched by the service into the mirror. */
export function requestFetch(socket: string, params: FetchParams, signal?: AbortSignal): Promise<FetchResult> {
  return callService<FetchResult>(socket, SERVICE_REQUESTS.fetch, params, {
    effect: "read",
    signal,
    timeoutMs: FETCH_TIMEOUT_MS,
  })
}

/** The chat list taken from Telegram into the mirror. */
export function requestRefresh(socket: string, signal?: AbortSignal): Promise<RefreshResult> {
  return callService<RefreshResult>(socket, SERVICE_REQUESTS.refresh, undefined, {
    effect: "read",
    signal,
    timeoutMs: REFRESH_TIMEOUT_MS,
  })
}

/**
 * A message of a live read as a row of `messages` would hold it, so that the
 * code that builds entries from the mirror builds these too: JSON columns as
 * text, flags as 0 and 1, `expires` from the chat's timer, and never kept.
 */
export function storedMessage(message: MessageInput): StoredMessage {
  return {
    chat: message.chat,
    id: message.id,
    topic: message.topic,
    ts: message.ts,
    from_me: Number(message.fromMe),
    sender: message.sender,
    sender_name: message.senderName,
    kind: message.kind,
    body: message.body,
    entities: toJson(message.entities),
    media: toJson(message.media),
    action: toJson(message.action),
    reply: toJson(message.reply),
    forward: toJson(message.forward),
    grouped: message.grouped,
    reactions: toJson(message.reactions),
    edited: message.edited,
    expires: message.ttl ? message.ts + message.ttl * MS_PER_S : null,
    view_once: Number(message.viewOnce),
    self_destruct: message.selfDestruct,
  }
}
