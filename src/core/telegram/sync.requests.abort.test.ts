import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { upsertChats } from "./ingest-chats"
import { getMeta } from "./mirror"
import { NOW, createTestMirror, chatInput, type TestMirror } from "./mirror.testing"
import { createFakeSyncClient, type FakeSyncClient } from "./sync-client.testing"
import { ChatListRefresh } from "./sync-chat-refresh"
import { resolveOptions } from "./sync-options"
import { syncRequestHandlers } from "./sync-requests"
import { FORUM } from "./sync-requests.testing"
import { eventually } from "./sync.testing"

let mirror: TestMirror
let client: FakeSyncClient
let run: AbortController
let handlers: ReturnType<typeof syncRequestHandlers>

beforeEach(() => {
  mirror = createTestMirror()
  upsertChats(mirror.mirror, [chatInput({ id: FORUM, kind: "supergroup", forum: true })], NOW)
  client = createFakeSyncClient()
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
  handlers = syncRequestHandlers({ ...context, refresh: new ChatListRefresh(context), endSession: () => {} })
})

afterEach(() => mirror.close())

const HISTORY = { chat: FORUM, limit: 5 }
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
