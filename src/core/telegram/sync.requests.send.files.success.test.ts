import { Long } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { storeMessage } from "./ingest-messages"
import { messageInput, messageRow } from "./mirror.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import {
  FILE_A,
  FILE_B,
  FILE_C,
  answerFiles,
  fileCallsOf,
  outboxFile,
  requestsOf,
  sendFiles,
} from "./sync-send-files.testing"
import { OPEN_TOPIC, SENT_MS, seedSendChats } from "./sync-send.testing"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let outcome: Awaited<ReturnType<SyncFixture["running"]>>["outcome"]

beforeEach(async () => {
  fixture = syncFixture()
  seedSendChats(fixture, { mirrorForum: true })
  fixture.seed((mirror) => {
    storeMessage(mirror, { now: START_MS, keepDisappearing: false }, messageInput({ chat: FORUM, id: 10 }))
  })
  outcome = (await fixture.running()).outcome
  fixture.client.setUploadAnswer({ mime: "text/plain" })
})

afterEach(() => fixture.close())

const row = (chat: string, id: number) => fixture.mirror((mirror) => messageRow(mirror, chat, id))
const files = (...made: (typeof FILE_A)[]) => made.map((file) => outboxFile(fixture, file))

describe("one file sent", () => {
  beforeEach(() => answerFiles(fixture, { firstId: 50 }))

  test("is one messages.sendMedia as a file with its name, with retries and sleeps off, and no other send", async () => {
    const [file] = files(FILE_A)

    expect(await sendFiles(fixture, { chat: KEPT, files: [file] })).toEqual({
      messages: [{ id: 50, name: FILE_A.name }],
      date: SENT_MS,
    })

    const [only, ...rest] = fileCallsOf(fixture)
    expect(rest).toEqual([])
    expect(only?.options).toMatchObject({ maxRetryCount: 0, floodSleepThreshold: 0 })
    expect(only?.options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(only?.request).toEqual({
      _: "messages.sendMedia",
      peer: { _: "inputPeerUser", userId: Number(KEPT), accessHash: expect.anything() },
      media: {
        _: "inputMediaUploadedDocument",
        file: expect.objectContaining({ _: "inputFile", name: FILE_A.name }),
        mimeType: "text/plain",
        attributes: [{ _: "documentAttributeFilename", fileName: FILE_A.name }],
        forceFile: true,
      },
      message: "",
      randomId: expect.any(Long),
    })
  })

  test("carries the caption exactly as written, with no entities", async () => {
    const caption = "See *this* and https://example.test/a_b_c"

    await sendFiles(fixture, { chat: KEPT, files: files(FILE_A), caption })

    const { request } = requestsOf(fixture, "messages.sendMedia")[0]!
    expect(request.message).toBe(caption)
    expect(request.entities).toBeUndefined()
    expect(row(KEPT, 50)).toMatchObject({ body: caption })
  })

  test("is recorded in the mirror as the user's own, with the file's facts as a received file has them", async () => {
    await sendFiles(fixture, { chat: KEPT, files: files(FILE_A), caption: "caption" })

    expect(row(KEPT, 50)).toMatchObject({ from_me: 1, ts: SENT_MS, topic: null, kind: "message", body: "caption" })
    expect(JSON.parse(String(row(KEPT, 50)?.media))).toEqual({
      type: "document",
      name: FILE_A.name,
      mime: "text/plain",
      size: FILE_A.content.length,
    })
  })

  test("tells mtcute's update state with the whole response", async () => {
    await sendFiles(fixture, { chat: KEPT, files: files(FILE_A) })

    expect(fixture.client.handled).toHaveLength(1)
    expect(fixture.client.handled[0]).toMatchObject({ update: { _: "updates" }, noDispatch: true })
  })

  test("in a topic, replying within it, carries the header and records the topic and the reply", async () => {
    answerFiles(fixture, { firstId: 60, forum: true, topic: OPEN_TOPIC })

    await sendFiles(fixture, { chat: FORUM, files: files(FILE_A), topic: OPEN_TOPIC, reply_to: 10 })

    expect(requestsOf(fixture, "messages.sendMedia")[0]?.request.replyTo).toEqual({
      _: "inputReplyToMessage",
      replyToMsgId: 10,
      topMsgId: OPEN_TOPIC,
    })
    expect(row(FORUM, 60)).toMatchObject({ from_me: 1, topic: OPEN_TOPIC })
  })

  test("in a topic without a reply is a post to the topic", async () => {
    answerFiles(fixture, { firstId: 60, forum: true, topic: OPEN_TOPIC })

    await sendFiles(fixture, { chat: FORUM, files: files(FILE_A), topic: OPEN_TOPIC })

    expect(requestsOf(fixture, "messages.sendMedia")[0]?.request.replyTo).toEqual({
      _: "inputReplyToMessage",
      replyToMsgId: OPEN_TOPIC,
      topMsgId: OPEN_TOPIC,
    })
  })

  test("uses a fresh random id for each send", async () => {
    await sendFiles(fixture, { chat: KEPT, files: files(FILE_A) })
    await sendFiles(fixture, { chat: KEPT, files: files(FILE_A) })

    const [first, second] = requestsOf(fixture, "messages.sendMedia")
    expect(first?.request.randomId.eq(second!.request.randomId)).toBe(false)
  })
})

describe("several files sent", () => {
  beforeEach(() => answerFiles(fixture, { firstId: 70 }))

  test("are one messages.sendMultiMedia of documents with a random id each, after one uploadMedia each", async () => {
    const result = await sendFiles(fixture, { chat: KEPT, files: files(FILE_A, FILE_B, FILE_C), reply_to: 2 })

    expect(result).toEqual({
      messages: [FILE_A, FILE_B, FILE_C].map(({ name }, index) => ({ id: 70 + index, name })),
      date: SENT_MS,
    })
    expect(fileCallsOf(fixture).map(({ request }) => request._)).toEqual([
      "messages.uploadMedia",
      "messages.uploadMedia",
      "messages.uploadMedia",
      "messages.sendMultiMedia",
    ])
    const [{ request, options }] = requestsOf(fixture, "messages.sendMultiMedia")
    expect(options).toMatchObject({ maxRetryCount: 0, floodSleepThreshold: 0 })
    expect(request.replyTo).toEqual({ _: "inputReplyToMessage", replyToMsgId: 2 })
    expect(request.multiMedia).toHaveLength(3)
    for (const item of request.multiMedia) {
      expect(item).toEqual({
        _: "inputSingleMedia",
        media: {
          _: "inputMediaDocument",
          id: {
            _: "inputDocument",
            id: expect.any(Long),
            accessHash: expect.anything(),
            fileReference: expect.anything(),
          },
        },
        randomId: expect.any(Long),
        message: expect.any(String),
      })
    }
    expect(new Set(request.multiMedia.map(({ randomId }) => randomId.toString())).size).toBe(3)
  })

  test("carry the caption on the last file only", async () => {
    await sendFiles(fixture, { chat: KEPT, files: files(FILE_A, FILE_B, FILE_C), caption: "for all of them" })

    const [{ request }] = requestsOf(fixture, "messages.sendMultiMedia")
    expect(request.multiMedia.map(({ message }) => message)).toEqual(["", "", "for all of them"])
  })

  test("are recorded one by one, each with its own file's facts", async () => {
    await sendFiles(fixture, { chat: KEPT, files: files(FILE_A, FILE_B) })

    for (const [index, file] of [FILE_A, FILE_B].entries()) {
      expect(row(KEPT, 70 + index)).toMatchObject({ from_me: 1, body: null })
      expect(JSON.parse(String(row(KEPT, 70 + index)?.media))).toMatchObject({
        type: "document",
        name: file.name,
        size: file.content.length,
        mime: "text/plain",
      })
    }
    expect(fixture.client.handled).toHaveLength(1)
  })
})

describe("a mirror that cannot be written", () => {
  test("does not turn the files that went out into a failure, and then stops the service", async () => {
    answerFiles(fixture, { firstId: 50 })
    fixture.seed((mirror) =>
      mirror.exec("CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END"),
    )

    const result = await sendFiles(fixture, { chat: KEPT, files: files(FILE_A, FILE_B) })

    expect(result.messages).toHaveLength(2)
    expect(await outcome).toMatchObject({ exitCode: 1, status: "failed" })
    expect(requestsOf(fixture, "messages.sendMultiMedia")).toHaveLength(1)
  })
})
