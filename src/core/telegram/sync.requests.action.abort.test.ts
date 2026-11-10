import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { storeMessage } from "./ingest-messages"
import { NOW, chatInput, columnOf, createTestMirror, followChat, messageInput, type TestMirror } from "./mirror.testing"
import { upsertChats } from "./ingest-chats"
import { failureOf } from "./service.testing"
import { StorageFailure } from "./sync-ending"
import { createFakeSyncClient, type FakeSyncClient } from "./sync-client.testing"
import { ChatListRefresh } from "./sync-chat-refresh"
import { resolveOptions } from "./sync-options"
import { RequestQueue } from "./sync-request-queue"
import { syncRequestHandlers } from "./sync-requests"
import { FORUM, KEPT } from "./sync-requests.testing"
import { TEXT, shortSent } from "./sync-send.testing"
import { NEW_TEXT, OWN, OWN_TEXT, affected, editedInPrivate } from "./sync-action.testing"
import { eventually } from "./sync.testing"
import { answered, type FakeSend } from "./sync-client-send.testing"

let mirror: TestMirror
let client: FakeSyncClient
let run: AbortController
let handlers: ReturnType<typeof syncRequestHandlers>
let endings: number
let failures: unknown[]

beforeEach(() => {
  mirror = createTestMirror()
  upsertChats(mirror.mirror, [chatInput({ id: FORUM, kind: "supergroup", forum: true })], NOW)
  followChat(mirror, { id: KEPT })
  storeMessage(
    mirror.mirror,
    { now: NOW, keepDisappearing: false },
    messageInput({ chat: KEPT, id: OWN.text, fromMe: true, sender: null, body: OWN_TEXT }),
  )
  client = createFakeSyncClient()
  client.setCallAnswer(shortSent(5))
  client.setActionAnswer(editedInPrivate(OWN.text, NEW_TEXT))
  run = new AbortController()
  endings = 0
  failures = []
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
    endSession: () => void endings++,
    failRun: (error) => void failures.push(error),
    forgetChats: () => {},
  })
})

afterEach(() => mirror.close())

const cancelled = { code: "upstream_error", message: "The request was cancelled before Telegram answered." }
const own = { chat: KEPT, id: OWN.text }
const sendCall = (signal: AbortSignal) => handlers.send!({ chat: KEPT, text: TEXT }, { signal })
const editCall = (signal: AbortSignal) => handlers.edit!({ ...own, text: NEW_TEXT }, { signal })
const deleteCall = (signal: AbortSignal) => handlers.delete!(own, { signal })
const calledOnce = () => eventually(() => client.argsOf("call").length === 1)
const bodies = () => columnOf(mirror.mirror, "SELECT body FROM messages WHERE chat = ? AND id = ?", KEPT, OWN.text)
const storedIds = () => columnOf(mirror.mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", KEPT)

describe("an action that is cancelled", () => {
  for (const [name, start] of [
    ["edit", editCall],
    ["delete", deleteCall],
  ] as const) {
    test(`${name} never reaches Telegram when it was cancelled already`, async () => {
      const caller = new AbortController()
      caller.abort()

      expect(await failureOf(start(caller.signal))).toMatchObject(cancelled)
      expect(client.calls).toEqual([])
    })

    test(`${name} is uncertain when its caller leaves after its call went out, and the call is told to stop`, async () => {
      client.setActionAnswer("hang")
      const caller = new AbortController()

      const answer = failureOf(start(caller.signal))
      await calledOnce()
      caller.abort()

      expect(await answer).toMatchObject({ code: "uncertain" })
      expect((await answer).message).toContain("cancelled")
      expect((client.argsOf("call") as FakeSend[])[0]?.options.abortSignal?.aborted).toBe(true)
      expect(bodies()).toEqual([OWN_TEXT])
    })

    test(`${name} is uncertain when the service closes after its call went out`, async () => {
      client.setActionAnswer("hang")

      const answer = failureOf(start(new AbortController().signal))
      await calledOnce()
      run.abort()

      expect(await answer).toMatchObject({ code: "uncertain" })
    })

    test(`${name} that waits behind a send leaves the line without a call, and the send goes on`, async () => {
      client.setCallAnswer("hang")
      const first = failureOf(sendCall(new AbortController().signal))
      await calledOnce()
      const leaving = new AbortController()
      const left = failureOf(start(leaving.signal))

      leaving.abort()

      expect(await left).toMatchObject(cancelled)
      expect(client.argsOf("call")).toHaveLength(1)
      run.abort()
      expect(await first).toMatchObject({ code: "uncertain" })
    })
  }
})

describe("actions", () => {
  test("wait behind a send, and run in the order they were asked for", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    client.setCallAnswer(async () => {
      await gate
      return shortSent(6)
    })

    const sent = sendCall(new AbortController().signal)
    const edited = editCall(new AbortController().signal)
    await calledOnce()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(client.argsOf("call")).toHaveLength(1)

    release()

    expect(await sent).toMatchObject({ id: 6 })
    expect(await edited).toMatchObject({ id: OWN.text })
    expect(client.argsOf("call")).toHaveLength(2)
  })
})

describe("an action that went through", () => {
  test("ends the service when Telegram ended the session, and is uncertain", async () => {
    client.setActionAnswer(answered(401, "SESSION_REVOKED"))

    expect(await failureOf(editCall(new AbortController().signal))).toMatchObject({ code: "uncertain" })
    expect(endings).toBe(1)
  })

  test("an edit is answered as a success when the mirror cannot be written, and then stops the service", async () => {
    mirror.mirror.exec("CREATE TRIGGER refuse BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'no'); END")

    const afterwards: (() => void)[] = []
    const answer = handlers.edit!(
      { ...own, text: NEW_TEXT },
      {
        signal: new AbortController().signal,
        afterAnswered: (effect) => void afterwards.push(effect),
      },
    )

    expect(await answer).toMatchObject({ id: OWN.text, edited: expect.any(Number) })

    expect(failures).toEqual([])
    for (const effect of afterwards) effect()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(StorageFailure)
    expect(bodies()).toEqual([OWN_TEXT])
  })

  test("a delete is answered as a success when the mirror cannot be written, and then stops the service", async () => {
    client.setActionAnswer(affected())
    mirror.mirror.exec("CREATE TRIGGER refuse BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'no'); END")

    const afterwards: (() => void)[] = []
    const answer = handlers.delete!(own, {
      signal: new AbortController().signal,
      afterAnswered: (effect) => void afterwards.push(effect),
    })

    expect(await answer).toEqual({ id: OWN.text, deleted: true })

    expect(failures).toEqual([])
    for (const effect of afterwards) effect()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(StorageFailure)
    expect(storedIds()).toEqual([OWN.text])
  })

  test("is answered as a success when mtcute's update state cannot take the response", async () => {
    client.setActionAnswer(affected())
    client.fail("handleClientUpdate", new Error("state of +15550100123 broke"))

    expect(await deleteCall(new AbortController().signal)).toEqual({ id: OWN.text, deleted: true })

    expect(storedIds()).toEqual([])
  })
})
