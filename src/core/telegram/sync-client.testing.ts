import { createRequire } from "node:module"
import {
  MtTimeoutError,
  type ConnectionState,
  type Dialog,
  type ForumTopic,
  type Message,
  type User,
} from "@mtcute/core"
import { fakeAccount } from "./login.testing"
import { fakeSendMethods, type FakeSendMethods } from "./sync-client-send.testing"
import { fakeUploadMethods, type FakeUploadMethods } from "./sync-client-upload.testing"
import type { SyncTelegram } from "./sync-telegram"

/**
 * mtcute's own emitter class. `@fuman/utils` is mtcute's dependency, not ours,
 * so it is found from where `@mtcute/core` lives; the fake's emitters then
 * behave exactly as the real client's do.
 */
const { Emitter } = createRequire(createRequire(import.meta.url).resolve("@mtcute/core"))("@fuman/utils") as {
  Emitter: new () => unknown
}

function newEmitter<E>(): E {
  return new Emitter() as E
}

/** The client's methods the fake records and can make fail. */
export type FakeMethod =
  | "connect"
  | "getMe"
  | "startUpdatesLoop"
  | "iterDialogs"
  | "getHistory"
  | "searchMessages"
  | "getForumTopics"
  | "getMessages"
  | "downloadAsIterable"
  | "uploadFile"
  | "resolvePeer"
  | "call"
  | "handleClientUpdate"
  | "destroy"
  | "freezeStorage"

/** One call the service made: the method and its arguments. */
export type FakeCall = { method: FakeMethod; arg?: unknown }

/** The emitters whose listeners the fake counts. */
const EMITTERS = ["onNewMessage", "onEditMessage", "onDeleteMessage", "onHistoryRead", "onError"] as const

/** How many listeners each emitter had at a moment. */
export type ListenerCounts = Record<(typeof EMITTERS)[number], number>

/**
 * The page Telegram gives out of `messages` for its paging arguments: newest
 * first, starting below `offsetId` (exclusive; none means the newest), moved
 * by `addOffset` messages (a negative one up over newer messages, to the
 * newest at most), at most `limit` long.
 */
function windowOf(
  messages: Message[],
  { offsetId = 0, addOffset = 0, limit = 100 }: { offsetId?: number; addOffset?: number; limit?: number },
): Message[] {
  const newestFirst = [...messages].sort((a, b) => b.id - a.id)
  const below = offsetId > 0 ? newestFirst.findIndex((message) => message.id < offsetId) : 0
  const start = Math.max(0, (below === -1 ? newestFirst.length : below) + addOffset)
  return newestFirst.slice(start, start + limit)
}

/** How a scripted download ends once its chunks are served: an error is thrown, `stall` waits until the stall limit passes or the download is aborted. */
export type FakeDownloadEnd = Error | "stall"

/** The scripting and the record of a test. */
type FakeScripting = {
  /** Every call the service made, in order. */
  calls: FakeCall[]
  /** The arguments of the calls to one method, in order. */
  argsOf(method: FakeMethod): unknown[]
  /** The listeners registered when `connect` was called; undefined until it was. */
  listenersAtConnect: ListenerCounts | undefined
  /** The listeners registered when `startUpdatesLoop` was called; undefined until it was. */
  listenersAtStart: ListenerCounts | undefined
  /** Whether `destroy` was called. */
  destroyed: boolean
  /** Sets the account `getMe` answers with; a made-up one by default. */
  setMe(user: User): void
  /** Makes the next `times` calls of a method throw `error`. */
  fail(method: FakeMethod, error: Error, times?: number): void
  /** Makes `connect` wait until the client is destroyed, which rejects it. */
  holdConnect(): void
  /** Sets the dialogs `iterDialogs` yields, newest first. */
  setDialogs(...dialogs: Dialog[]): void
  /** Sets the messages `getHistory` and `getMessages` have for a chat, by its marked id. */
  setHistory(chat: number | string, ...messages: Message[]): void
  /** Sets the chunks every download yields, and how it ends after them; it ends normally by default. */
  setDownload(chunks: Uint8Array[], end?: FakeDownloadEnd): void
  /** Sets the messages `searchMessages` has for a forum topic of a chat, by the chat's marked id. */
  setThread(chat: number | string, topic: number, ...messages: Message[]): void
  /** Sets the topics `getForumTopics` lists for a chat, most recently active first. */
  setTopics(chat: number | string, ...topics: ForumTopic[]): void
  /** Makes calls of a method wait until the returned function is called (or forever, if it never is). */
  hold(method: FakeMethod): () => void
  /** The connection goes down. */
  drop(): void
  /** The connection comes back, as the client reports it. */
  regain(): void
}

/** A fake mtcute client for the sync service, with the scripting and the record of a test. */
export type FakeSyncClient = SyncTelegram & FakeSendMethods & FakeUploadMethods & FakeScripting

/** A client that answers from what a test scripted, records its calls, and has mtcute's real emitters. */
export function createFakeSyncClient(): FakeSyncClient {
  const calls: FakeCall[] = []
  const failures = new Map<FakeMethod, Error[]>()
  const history = new Map<number, Message[]>()
  const threads = new Map<string, Message[]>()
  const topicLists = new Map<number, ForumTopic[]>()
  const gates = new Map<FakeMethod, Promise<void>>()
  let download: { chunks: Uint8Array[]; end?: FakeDownloadEnd } = { chunks: [] }
  let dialogs: Dialog[] = []
  let me: User = fakeAccount()
  let holdingConnect = false
  let releaseHeld: (() => void) | undefined

  const emitters = {
    onNewMessage: newEmitter<SyncTelegram["onNewMessage"]>(),
    onEditMessage: newEmitter<SyncTelegram["onEditMessage"]>(),
    onDeleteMessage: newEmitter<SyncTelegram["onDeleteMessage"]>(),
    onHistoryRead: newEmitter<SyncTelegram["onHistoryRead"]>(),
    onConnectionState: newEmitter<SyncTelegram["onConnectionState"]>(),
    onError: newEmitter<SyncTelegram["onError"]>(),
  }

  const listeners = (): ListenerCounts =>
    Object.fromEntries(EMITTERS.map((name) => [name, emitters[name].length])) as ListenerCounts

  function record(method: FakeMethod, arg?: unknown): void {
    calls.push({ method, arg })
    const error = failures.get(method)?.shift()
    if (error) throw error
  }

  /** Waits while a test holds the method. */
  const passGate = async (method: FakeMethod): Promise<void> => void (await gates.get(method))

  const state = (value: ConnectionState) => emitters.onConnectionState.emit(value)

  const client = {
    ...emitters,
    ...fakeSendMethods(record),
    ...fakeUploadMethods(record),
    calls,
    listenersAtConnect: undefined as ListenerCounts | undefined,
    listenersAtStart: undefined as ListenerCounts | undefined,
    destroyed: false,
    argsOf: (method: FakeMethod) => calls.filter((call) => call.method === method).map((call) => call.arg),
    setMe: (user: User) => void (me = user),
    fail(method: FakeMethod, error: Error, times = 1) {
      failures.set(method, [...(failures.get(method) ?? []), ...Array.from({ length: times }, () => error)])
    },
    holdConnect: () => void (holdingConnect = true),
    setDialogs: (...list: Dialog[]) => void (dialogs = list),
    setHistory: (chat: number | string, ...messages: Message[]) => void history.set(Number(chat), messages),
    setDownload: (chunks: Uint8Array[], end?: FakeDownloadEnd) => void (download = { chunks, end }),
    setThread: (chat: number | string, topic: number, ...messages: Message[]) =>
      void threads.set(`${Number(chat)}:${topic}`, messages),
    setTopics: (chat: number | string, ...list: ForumTopic[]) => void topicLists.set(Number(chat), list),
    hold(method: FakeMethod) {
      let release = () => {}
      gates.set(method, new Promise<void>((resolve) => (release = resolve)))
      return () => {
        gates.delete(method)
        release()
      }
    },
    drop: () => state("offline"),
    regain() {
      state("connecting")
      state("connected")
    },

    async connect() {
      client.listenersAtConnect = listeners()
      record("connect")
      state("connecting")
      if (holdingConnect) {
        await new Promise<void>((_, reject) => {
          releaseHeld = () => reject(new Error("the client was destroyed"))
        })
      }
      state("connected")
    },
    async getMe() {
      record("getMe")
      return me
    },
    async startUpdatesLoop() {
      client.listenersAtStart = listeners()
      record("startUpdatesLoop")
      state("updating")
      state("connected")
    },
    async *iterDialogs(params?: unknown) {
      record("iterDialogs", params)
      await passGate("iterDialogs")
      yield* dialogs
    },
    async getHistory(
      chat: unknown,
      params: { limit?: number; minId?: number; offset?: { id: number }; addOffset?: number } = {},
    ) {
      record("getHistory", { chat, ...params })
      await passGate("getHistory")
      const found = windowOf(
        (history.get(Number(chat)) ?? []).filter((message) => message.id > (params.minId ?? 0)),
        { ...params, offsetId: params.offset?.id },
      )
      return Object.assign(found, { total: found.length })
    },
    async searchMessages(params: {
      chatId?: unknown
      threadId?: number
      limit?: number
      offset?: number
      addOffset?: number
    }) {
      record("searchMessages", params)
      await passGate("searchMessages")
      const found = windowOf(threads.get(`${Number(params.chatId)}:${params.threadId}`) ?? [], {
        ...params,
        offsetId: params.offset,
      })
      return Object.assign(found, { total: found.length })
    },
    async getMessages(chat: unknown, ids: number | number[]) {
      record("getMessages", { chat, ids })
      await passGate("getMessages")
      const known = history.get(Number(chat)) ?? []
      return [ids].flat().map((id) => known.find((message) => message.id === id) ?? null)
    },
    async *downloadAsIterable(
      input: { type?: string },
      params: { abortSignal?: AbortSignal; stallTimeout?: number } = {},
    ) {
      const { abortSignal, stallTimeout } = params
      record("downloadAsIterable", { kind: input.type, stallTimeout })
      await passGate("downloadAsIterable")
      yield* download.chunks
      if (download.end instanceof Error) throw download.end
      if (download.end === "stall") {
        // As mtcute stalls: after `stallTimeout` without a chunk it fails with a timeout error; an abort fails it with the reason.
        await new Promise<never>((_, reject) => {
          const timer =
            stallTimeout === undefined
              ? undefined
              : setTimeout(() => reject(new MtTimeoutError(stallTimeout)), stallTimeout)
          abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer)
            reject(abortSignal.reason)
          })
        })
      }
    },
    async getForumTopics(chat: unknown, params: { limit?: number; offset?: { topic: number } } = {}) {
      record("getForumTopics", { chat, ...params })
      await passGate("getForumTopics")
      const all = topicLists.get(Number(chat)) ?? []
      const after = params.offset?.topic ? all.findIndex((topic) => topic.id === params.offset?.topic) + 1 : 0
      const found = all.slice(after, after + (params.limit ?? 100))
      const last = found.at(-1)
      // As mtcute pages: from the newest message of the last topic.
      const newestDate = (topic: ForumTopic) => {
        try {
          return topic.lastMessage.raw.date
        } catch {
          return topic.raw.date
        }
      }
      const next = last && { date: newestDate(last), id: last.raw.topMessage, topic: last.raw.id }
      return Object.assign(found, { total: all.length, next })
    },
    freezeStorage() {
      record("freezeStorage")
    },
    async destroy() {
      client.destroyed = true
      releaseHeld?.()
      record("destroy")
    },
  }
  return client as unknown as FakeSyncClient
}
