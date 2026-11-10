import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { upsertChats } from "./ingest-chats"
import { NOW, chatInput, columnOf, createTestMirror, followChat, type TestMirror } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { StorageFailure } from "./sync-ending"
import { createFakeSyncClient, type FakeSyncClient } from "./sync-client.testing"
import { ChatListRefresh } from "./sync-chat-refresh"
import { resolveOptions } from "./sync-options"
import { RequestQueue } from "./sync-request-queue"
import { syncRequestHandlers } from "./sync-requests"
import { FORUM, KEPT } from "./sync-requests.testing"
import { TEXT, shortSent } from "./sync-send.testing"
import { eventually } from "./sync.testing"
import { answered, type FakeSend } from "./sync-client-send.testing"

let mirror: TestMirror
let client: FakeSyncClient
let run: AbortController
let handlers: ReturnType<typeof syncRequestHandlers>
let downloads: RequestQueue
let logs: string[]
let endings: number
let failures: unknown[]

beforeEach(() => {
  mirror = createTestMirror()
  upsertChats(mirror.mirror, [chatInput({ id: FORUM, kind: "supergroup", forum: true })], NOW)
  followChat(mirror, { id: KEPT })
  client = createFakeSyncClient()
  client.setCallAnswer(shortSent(5))
  run = new AbortController()
  downloads = new RequestQueue()
  logs = []
  endings = 0
  failures = []
  const settings = resolveOptions({
    stateDir: "unused",
    label: "main",
    keepDisappearing: false,
    channels: false,
    openClient: () => client,
    log: (line) => logs.push(line),
    now: () => NOW,
    pause: async () => {},
  })
  const context = { client, mirror: mirror.mirror, settings, signal: run.signal }
  handlers = syncRequestHandlers({
    ...context,
    refresh: new ChatListRefresh(context),
    downloads,
    endSession: () => void endings++,
    failRun: (error) => void failures.push(error),
    forgetChats: () => {},
  })
})

afterEach(() => mirror.close())

const PARAMS = { chat: KEPT, text: TEXT }
const call = (signal: AbortSignal, params: unknown = PARAMS) => handlers.send!(params, { signal })
const outcomeOf = failureOf
const cancelled = { code: "upstream_error", message: "The request was cancelled before Telegram answered." }
const sent = () => client.argsOf("call") as FakeSend[]
const calledOnce = () => eventually(() => sent().length === 1)
const storedIds = () => columnOf(mirror.mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", KEPT)

describe("a send that is cancelled", () => {
  test("never reaches Telegram when it was cancelled already", async () => {
    const caller = new AbortController()
    caller.abort()

    expect(await outcomeOf(call(caller.signal))).toMatchObject(cancelled)
    expect(client.calls).toEqual([])
  })

  test("after its call went out is uncertain when its caller leaves, and the call is told to stop", async () => {
    client.setCallAnswer("hang")
    const caller = new AbortController()

    const answer = outcomeOf(call(caller.signal))
    await calledOnce()
    caller.abort()

    expect(await answer).toMatchObject({ code: "uncertain" })
    expect((await answer).message).toContain("cancelled")
    expect(sent()[0]?.options.abortSignal?.aborted).toBe(true)
  })

  test("after its call went out is uncertain when the service closes", async () => {
    client.setCallAnswer("hang")

    const answer = outcomeOf(call(new AbortController().signal))
    await calledOnce()
    run.abort()

    expect(await answer).toMatchObject({ code: "uncertain" })
  })

  test("while it waits behind another send leaves the line without a call, and the sends behind it go on", async () => {
    client.setCallAnswer("hang")
    const first = outcomeOf(call(new AbortController().signal))
    await calledOnce()
    const leaving = new AbortController()
    const left = outcomeOf(call(leaving.signal))
    const third = outcomeOf(call(new AbortController().signal))

    leaving.abort()
    expect(await left).toMatchObject(cancelled)
    expect(sent()).toHaveLength(1)

    client.setCallAnswer(shortSent(6))
    run.abort()
    expect(await first).toMatchObject({ code: "uncertain" })
    expect(await third).toMatchObject(cancelled)
    expect(sent()).toHaveLength(1)
  })
})

describe("sends", () => {
  test("run one at a time, in the order they were asked for", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let next = 10
    client.setCallAnswer(async () => {
      await gate
      return shortSent(next++)
    })

    const first = call(new AbortController().signal)
    const second = call(new AbortController().signal)
    await calledOnce()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent()).toHaveLength(1)

    release()

    expect(await first).toMatchObject({ id: 10 })
    expect(await second).toMatchObject({ id: 11 })
    expect(sent()).toHaveLength(2)
  })

  test("do not wait behind a history fetch that is running", async () => {
    const release = client.hold("getHistory")
    const fetching = handlers.fetch!({ chat: KEPT, pages: 1 }, { signal: new AbortController().signal })
    await eventually(() => client.argsOf("getHistory").length === 1)

    expect(await call(new AbortController().signal)).toMatchObject({ id: 5 })

    release()
    await fetching
  })

  test("do not wait behind a download that is running", async () => {
    let finish = () => {}
    const blocker = new Promise<void>((resolve) => (finish = resolve))
    const downloading = downloads.run(new AbortController().signal, () => blocker)

    expect(await call(new AbortController().signal)).toMatchObject({ id: 5 })

    finish()
    await downloading
  })
})

describe("a send that went out", () => {
  test("ends the service when Telegram ended the session, and is uncertain", async () => {
    client.setCallAnswer(answered(401, "SESSION_REVOKED"))

    expect(await outcomeOf(call(new AbortController().signal))).toMatchObject({ code: "uncertain" })
    expect(endings).toBe(1)
  })

  test("is answered as a success when the mirror cannot be written, and then stops the service", async () => {
    mirror.mirror.exec("CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END")

    const afterwards: (() => void)[] = []
    const answered = handlers.send!(PARAMS, {
      signal: new AbortController().signal,
      afterAnswered: (effect) => void afterwards.push(effect),
    })

    expect(await answered).toEqual({ id: 5, date: expect.any(Number) })

    expect(failures).toEqual([])
    for (const effect of afterwards) effect()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(StorageFailure)
    expect(storedIds()).toEqual([])
  })

  test("is answered as a success when mtcute's update state cannot take the response", async () => {
    client.fail("handleClientUpdate", new Error("state of +15550100123 broke"))

    expect(await call(new AbortController().signal)).toMatchObject({ id: 5 })

    expect(storedIds()).toEqual([5])
    expect(logs.join("\n")).not.toContain("15550100123")
    expect(logs).toContain("send: the update state could not take the response (Error)")
  })
})
