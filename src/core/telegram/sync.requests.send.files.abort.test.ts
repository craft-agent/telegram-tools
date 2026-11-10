import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { upsertChats } from "./ingest-chats"
import { labelPaths } from "./labels"
import { NOW, chatInput, createTestMirror, followChat, makeTempDir, type TestMirror } from "./mirror.testing"
import { failureOf } from "./service.testing"
import type { SendFile } from "./service-requests"
import { createFakeSyncClient, type FakeSyncClient } from "./sync-client.testing"
import { ChatListRefresh } from "./sync-chat-refresh"
import { resolveOptions } from "./sync-options"
import { RequestQueue } from "./sync-request-queue"
import { syncRequestHandlers } from "./sync-requests"
import { FORUM, KEPT } from "./sync-requests.testing"
import type { FakeSend } from "./sync-client-send.testing"
import { answerFiles } from "./sync-send-files.testing"
import { shortSent } from "./sync-send.testing"
import { eventually } from "./sync.testing"

let mirror: TestMirror
let client: FakeSyncClient
let run: AbortController
let handlers: ReturnType<typeof syncRequestHandlers>
let stateDir: string
let files: SendFile[]

const LABEL = "main"
const STALL_MS = 40
const CANCELLED = { code: "upstream_error", message: "The request was cancelled before Telegram answered." }

beforeEach(() => {
  mirror = createTestMirror()
  upsertChats(mirror.mirror, [chatInput({ id: FORUM, kind: "supergroup", forum: true })], NOW)
  followChat(mirror, { id: KEPT })
  client = createFakeSyncClient()
  client.setCallAnswer(shortSent(5))
  run = new AbortController()
  stateDir = makeTempDir()
  const { outbox } = labelPaths(stateDir, LABEL)
  mkdirSync(outbox, { recursive: true })
  files = ["a.txt", "b.txt"].map((name) => {
    writeFileSync(join(outbox, name), `made-up ${name}`)
    return { path: join(outbox, name), name }
  })
  const settings = resolveOptions({
    stateDir,
    label: LABEL,
    keepDisappearing: false,
    channels: false,
    openClient: () => client,
    log: () => {},
    now: () => NOW,
    pause: async () => {},
    downloadStallMs: STALL_MS,
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

afterEach(() => {
  mirror.close()
  rmSync(stateDir, { recursive: true, force: true })
})

const call = (signal: AbortSignal) => handlers.send_files!({ chat: KEPT, files }, { signal })
const sendText = (signal: AbortSignal) => handlers.send!({ chat: KEPT, text: "made up" }, { signal })
const requests = () => (client.argsOf("call") as FakeSend<{ _: string }>[]).map(({ request }) => request._)
const uploading = () => eventually(() => client.uploads.some((upload) => upload.bytes.length > 0))

describe("a file send that is cancelled", () => {
  test("never reaches Telegram when it was cancelled already", async () => {
    const caller = new AbortController()
    caller.abort()

    expect(await failureOf(call(caller.signal))).toMatchObject(CANCELLED)
    expect(client.calls).toEqual([])
  })

  test("during an upload sends nothing, and the upload is told to stop", async () => {
    client.setUploadAnswer("hang")
    const caller = new AbortController()

    const answer = failureOf(call(caller.signal))
    await uploading()
    caller.abort()

    expect(await answer).toMatchObject(CANCELLED)
    expect(client.uploads).toHaveLength(1)
    expect(client.uploads[0]?.abortSignal?.aborted).toBe(true)
    expect(requests()).toEqual([])
  })

  test("while a document is made sends nothing", async () => {
    client.setFileAnswer(() => "hang")
    const caller = new AbortController()

    const answer = failureOf(call(caller.signal))
    await eventually(() => requests().length === 1)
    caller.abort()

    expect(await answer).toMatchObject(CANCELLED)
    expect(requests()).toEqual(["messages.uploadMedia"])
  })

  test("after its call went out is uncertain when its caller leaves, and the call is told to stop", async () => {
    answerFiles({ client }, { firstId: 50, hangOnSend: true })
    const caller = new AbortController()

    const answer = failureOf(call(caller.signal))
    await eventually(() => requests().includes("messages.sendMultiMedia"))
    caller.abort()

    expect(await answer).toMatchObject({ code: "uncertain" })
    expect((await answer).message).toContain("cancelled")
    expect((client.argsOf("call") as FakeSend[]).at(-1)?.options.abortSignal?.aborted).toBe(true)
  })

  test("while it waits behind a text send leaves the line without an upload", async () => {
    client.setCallAnswer("hang")
    const first = failureOf(sendText(new AbortController().signal))
    await eventually(() => requests().length === 1)
    const leaving = new AbortController()
    const left = failureOf(call(leaving.signal))

    leaving.abort()

    expect(await left).toMatchObject(CANCELLED)
    expect(client.uploads).toEqual([])
    run.abort()
    expect(await first).toMatchObject({ code: "uncertain" })
  })
})

describe("a file send and a text send", () => {
  test("share one line: the files wait until the text has been answered", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    client.setCallAnswer(async () => {
      await gate
      return shortSent(10)
    })

    const text = sendText(new AbortController().signal)
    await eventually(() => requests().length === 1)
    const sending = failureOf(call(new AbortController().signal))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(client.uploads).toEqual([])

    release()
    expect(await text).toMatchObject({ id: 10 })
    await sending
    expect(client.uploads).not.toEqual([])
  })
})

describe("an upload's progress", () => {
  /** An upload that reports `steps` steps, `stepMs` apart, and then reports nothing until it is aborted. */
  const reporting = (steps: number, stepMs: number) => {
    client.uploadFile = async ({ progressCallback, abortSignal }) => {
      for (let step = 1; step <= steps; step++) {
        await new Promise((resolve) => setTimeout(resolve, stepMs))
        progressCallback?.(step, steps + 1)
      }
      return new Promise<never>((_, reject) => abortSignal?.addEventListener("abort", () => reject(abortSignal.reason)))
    }
  }

  test("keeps an upload from stalling for as long as the bytes keep moving, however long it takes in all", async () => {
    reporting(6, STALL_MS / 2)
    const started = Date.now()

    const failure = await failureOf(call(new AbortController().signal))

    expect(failure.message).toBe(`The upload of ${files[0]!.name} stalled; nothing was sent.`)
    expect(Date.now() - started).toBeGreaterThan(STALL_MS * 3)
  })

  test("does not count a report that moves nothing", async () => {
    client.uploadFile = async ({ progressCallback, abortSignal }) => {
      const repeat = setInterval(() => progressCallback?.(5, 10), STALL_MS / 4)
      try {
        return await new Promise<never>((_, reject) =>
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason)),
        )
      } finally {
        clearInterval(repeat)
      }
    }

    expect((await failureOf(call(new AbortController().signal))).message).toContain("stalled")
  })
})
