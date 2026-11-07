import { createRequire } from "node:module"
import type { ConnectionState, Dialog, ForumTopic, Message, User } from "@mtcute/core"
import { fakeAccount } from "./login.testing"
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
  | "destroy"
  | "freezeStorage"

/** One call the service made: the method and its arguments. */
export type FakeCall = { method: FakeMethod; arg?: unknown }

/** The emitters whose listeners the fake counts. */
const EMITTERS = ["onNewMessage", "onEditMessage", "onDeleteMessage", "onHistoryRead", "onError"] as const

/** How many listeners each emitter had at a moment. */
export type ListenerCounts = Record<(typeof EMITTERS)[number], number>

/** A fake mtcute client for the sync service, with the scripting and the record of a test. */
export type FakeSyncClient = SyncTelegram & {
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
  /** Sets the messages `getHistory` has for a chat, by its marked id. */
  setHistory(chat: number | string, ...messages: Message[]): void
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

/** A client that answers from what a test scripted, records its calls, and has mtcute's real emitters. */
export function createFakeSyncClient(): FakeSyncClient {
  const calls: FakeCall[] = []
  const failures = new Map<FakeMethod, Error[]>()
  const history = new Map<number, Message[]>()
  const threads = new Map<string, Message[]>()
  const topicLists = new Map<number, ForumTopic[]>()
  const gates = new Map<FakeMethod, Promise<void>>()
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
    async getHistory(chat: unknown, params: { limit?: number; minId?: number } = {}) {
      record("getHistory", { chat, ...params })
      await passGate("getHistory")
      const found = (history.get(Number(chat)) ?? [])
        .filter((message) => message.id > (params.minId ?? 0))
        .sort((a, b) => b.id - a.id)
        .slice(0, params.limit ?? 100)
      return Object.assign(found, { total: found.length })
    },
    async searchMessages(params: { chatId?: unknown; threadId?: number; limit?: number }) {
      record("searchMessages", params)
      await passGate("searchMessages")
      const found = (threads.get(`${Number(params.chatId)}:${params.threadId}`) ?? [])
        .sort((a, b) => b.id - a.id)
        .slice(0, params.limit ?? 100)
      return Object.assign(found, { total: found.length })
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
