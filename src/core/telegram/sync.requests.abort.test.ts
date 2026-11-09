import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { upsertChats } from "./ingest-chats"
import { getMeta } from "./mirror"
import { NOW, columnOf, createTestMirror, chatInput, followChat, type TestMirror } from "./mirror.testing"
import { createFakeSyncClient, type FakeSyncClient } from "./sync-client.testing"
import { ChatListRefresh } from "./sync-chat-refresh"
import { resolveOptions } from "./sync-options"
import { RequestQueue } from "./sync-request-queue"
import { syncRequestHandlers } from "./sync-requests"
import { FORUM, KEPT, keptMessage } from "./sync-requests.testing"
import { eventually } from "./sync.testing"

let mirror: TestMirror
let client: FakeSyncClient
let run: AbortController
let handlers: ReturnType<typeof syncRequestHandlers>

beforeEach(() => {
  mirror = createTestMirror()
  upsertChats(mirror.mirror, [chatInput({ id: FORUM, kind: "supergroup", forum: true })], NOW)
  followChat(mirror, { id: KEPT })
  client = createFakeSyncClient()
  client.setHistory(KEPT, keptMessage(1))
  run = new AbortController()
  const settings = resolveOptions({
    stateDir: "unused",
    label: "main",
    keepDisappearing: false,
    channels: false,
    openClient: () => client,
    log: () => {},
    now: () => NOW,
    pause: async () => {},
  })
  const context = { client, mirror: mirror.mirror, settings, signal: run.signal }
  handlers = syncRequestHandlers({
    ...context,
    refresh: new ChatListRefresh(context),
    downloads: new RequestQueue(),
    endSession: () => {},
    failRun: () => {},
    forgetChats: () => {},
  })
})

afterEach(() => mirror.close())

const HISTORY = { chat: FORUM, limit: 5 }
const FETCH = { chat: KEPT, pages: 1 }
const call = (method: string, params: unknown, signal: AbortSignal) => handlers[method]!(params, { signal })
const cancelled = { code: "upstream_error", message: "The request was cancelled before Telegram answered." }

describe("a request that is cancelled", () => {
  test("stops waiting for Telegram when its caller leaves", async () => {
    client.hold("getHistory")
    const caller = new AbortController()

    const answer = call("history", HISTORY, caller.signal)
    caller.abort()

    expect(await answer.catch((error) => error)).toMatchObject(cancelled)
  })

  test("stops waiting for Telegram when the run ends", async () => {
    client.hold("getForumTopics")

    const answer = call("topics", HISTORY, new AbortController().signal)
    run.abort()

    expect(await answer.catch((error) => error)).toMatchObject(cancelled)
  })

  test("never reaches Telegram when it was cancelled already", async () => {
    const caller = new AbortController()
    caller.abort()

    expect(await call("history", { ...HISTORY, topic: 2 }, caller.signal).catch((error) => error)).toMatchObject(
      cancelled,
    )
    expect(client.calls).toEqual([])
  })

  test("stops a fetch waiting for Telegram when its caller leaves, and stores nothing of the page", async () => {
    const release = client.hold("getHistory")
    const caller = new AbortController()

    const answer = call("fetch", FETCH, caller.signal)
    await eventually(() => client.argsOf("getHistory").length === 1)
    caller.abort()
    release()

    expect(await answer.catch((error) => error)).toMatchObject(cancelled)
    expect(columnOf(mirror.mirror, "SELECT id FROM messages WHERE chat = ?", KEPT)).toEqual([])
    expect(client.argsOf("getHistory")).toHaveLength(1)
  })

  test("never reaches Telegram for a fetch or a read around a message that was cancelled already", async () => {
    const caller = new AbortController()
    caller.abort()

    for (const [method, params] of [
      ["fetch", FETCH],
      ["around", { chat: FORUM, id: 5, before_count: 1, after_count: 1 }],
    ] as const) {
      expect(await call(method, params, caller.signal).catch((error) => error)).toMatchObject(cancelled)
    }
    expect(client.calls).toEqual([])
  })

  test("takes a fetch that left the line out of it, and the fetches behind it still run in turn", async () => {
    const release = client.hold("getHistory")
    const first = call("fetch", FETCH, new AbortController().signal)
    await eventually(() => client.argsOf("getHistory").length === 1)
    const leaving = new AbortController()
    const left = call("fetch", FETCH, leaving.signal)
    const third = call("fetch", FETCH, new AbortController().signal)

    leaving.abort()
    expect(await left.catch((error) => error)).toMatchObject(cancelled)
    expect(client.argsOf("getHistory")).toHaveLength(1)
    release()

    expect(await first).toMatchObject({ added: 1 })
    expect(await third).toMatchObject({ added: 0 })
    expect(client.argsOf("getHistory")).toHaveLength(2)
  })

  test("leaves the refresh it waited for running, for the service's own round to finish", async () => {
    const release = client.hold("iterDialogs")
    const caller = new AbortController()

    const answer = call("refresh", undefined, caller.signal)
    await eventually(() => client.argsOf("iterDialogs").length === 1)
    caller.abort()
    release()

    expect(await answer.catch((error) => error)).toMatchObject(cancelled)
    await eventually(() => getMeta(mirror.mirror).refreshed_at === String(NOW))
  })
})
