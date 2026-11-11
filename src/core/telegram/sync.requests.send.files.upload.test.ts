import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { floodWait, rpcError } from "./login.testing"
import { failureOf } from "./service.testing"
import { KEPT } from "./sync-requests.testing"
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
import { seedSendChats } from "./sync-send.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let service: Awaited<ReturnType<SyncFixture["running"]>>

const STALL_MS = 50

beforeEach(async () => {
  fixture = syncFixture()
  seedSendChats(fixture)
  service = await fixture.running({ transferStallMs: STALL_MS })
  answerFiles(fixture, { firstId: 50 })
})

afterEach(() => fixture.close())

const three = () => [FILE_A, FILE_B, FILE_C].map((file) => outboxFile(fixture, file))
const params = () => ({ chat: KEPT, files: three() })
const uploading = () => eventually(() => fixture.client.uploads.some((upload) => upload.bytes.length > 0))
const sentNothing = () => {
  expect(requestsOf(fixture, "messages.sendMedia")).toEqual([])
  expect(requestsOf(fixture, "messages.sendMultiMedia")).toEqual([])
}

describe("the uploads of a send", () => {
  test("are one call for each file, in order, from the open file with its name and size", async () => {
    await sendFiles(fixture, params())

    expect(fixture.client.uploads.map(({ fileName, fileSize }) => ({ fileName, fileSize }))).toEqual(
      [FILE_A, FILE_B, FILE_C].map(({ name, content }) => ({ fileName: name, fileSize: content.length })),
    )
    expect(fixture.client.uploads.map(({ bytes }) => Buffer.from(bytes).toString())).toEqual(
      [FILE_A, FILE_B, FILE_C].map(({ content }) => content),
    )
    for (const { abortSignal } of fixture.client.uploads) expect(abortSignal).toBeInstanceOf(AbortSignal)
  })

  test("come before every call of the send, and each file is made a document by uploadMedia in a group", async () => {
    await sendFiles(fixture, params())

    expect(fixture.client.calls.map(({ method }) => method)).not.toContain("downloadAsIterable")
    expect(fileCallsOf(fixture).map(({ request }) => request._)).toEqual([
      "messages.uploadMedia",
      "messages.uploadMedia",
      "messages.uploadMedia",
      "messages.sendMultiMedia",
    ])
    const methods = fixture.client.calls.map(({ method }) => method)
    expect(methods.lastIndexOf("uploadFile")).toBeLessThan(methods.indexOf("call"))
  })

  test("make a lone file no uploadMedia call", async () => {
    await sendFiles(fixture, { chat: KEPT, files: three().slice(0, 1) })

    expect(fileCallsOf(fixture).map(({ request }) => request._)).toEqual(["messages.sendMedia"])
  })

  test("that stall stop with nothing sent, and the upload is told to stop", async () => {
    fixture.client.setUploadAnswer({ stallAfter: 3 })

    const failure = await failureOf(sendFiles(fixture, params()))

    expect(failure).toMatchObject({
      code: "upstream_error",
      message: `The upload of ${FILE_A.name} stalled; nothing was sent.`,
    })
    expect(fixture.client.uploads).toHaveLength(1)
    expect(fixture.client.uploads[0]?.abortSignal?.aborted).toBe(true)
    expect(fileCallsOf(fixture)).toEqual([])
  })

  test("that fail stop with nothing sent, naming the error and nothing of its message", async () => {
    fixture.client.setUploadAnswer(new Error("socket to +15550100123 broke"))

    const failure = await failureOf(sendFiles(fixture, params()))

    expect(failure).toMatchObject({
      code: "upstream_error",
      message: `The upload of ${FILE_A.name} failed (Error); nothing was sent.`,
    })
    expect(failure.message).not.toContain("15550100123")
    expect(fixture.client.uploads).toHaveLength(1)
    expect(fileCallsOf(fixture)).toEqual([])
  })

  test("that Telegram refuses stand as its refusal, with nothing sent", async () => {
    fixture.client.setUploadAnswer(rpcError(400, "FILE_PARTS_INVALID"))

    expect(await failureOf(sendFiles(fixture, params()))).toMatchObject({
      code: "upstream_error",
      message: "Telegram refused the send (FILE_PARTS_INVALID); nothing was sent.",
    })
    expect(fileCallsOf(fixture)).toEqual([])
  })

  test("that find the session ended end the service", async () => {
    fixture.client.setUploadAnswer(rpcError(401, "AUTH_KEY_UNREGISTERED"))

    expect(await failureOf(sendFiles(fixture, params()))).toMatchObject({ code: "upstream_error" })
    expect(await service.outcome).toMatchObject({ status: "logged out" })
    expect(fileCallsOf(fixture)).toEqual([])
  })

  test("that the service closing cuts short are cancelled, with nothing sent", async () => {
    fixture.client.setUploadAnswer("hang")

    const answer = failureOf(sendFiles(fixture, params()))
    await uploading()
    service.stop()

    expect(await answer).toBeInstanceOf(Error)
    expect(fileCallsOf(fixture)).toEqual([])
  })
})

describe("the documents of a group", () => {
  test("a flood wait while one is made is rate_limited with its seconds, and nothing is sent", async () => {
    fixture.client.setFileAnswer(() => floodWait(30))

    expect(await failureOf(sendFiles(fixture, params()))).toMatchObject({
      code: "rate_limited",
      message: "Telegram is limiting sends from this account; nothing was sent. Try again in 30 seconds.",
    })
    expect(requestsOf(fixture, "messages.uploadMedia")).toHaveLength(1)
    sentNothing()
  })

  test("a refusal of the chat while one is made is told as such, with nothing sent", async () => {
    fixture.client.setFileAnswer(() => rpcError(403, "CHAT_SEND_DOCS_FORBIDDEN"))

    expect(await failureOf(sendFiles(fixture, params()))).toMatchObject({ code: "forbidden" })
    sentNothing()
  })

  test("an answer that is no document is an upstream error, with nothing sent", async () => {
    fixture.client.setFileAnswer(() => ({ _: "messageMediaEmpty" }))

    expect(await failureOf(sendFiles(fixture, params()))).toMatchObject({
      code: "upstream_error",
      message: `Telegram did not take ${FILE_A.name}; nothing was sent.`,
    })
    sentNothing()
  })

  test("a server error while one is made is an upstream error, not uncertain: nothing was sent", async () => {
    fixture.client.setFileAnswer(() => rpcError(500, "INTERNAL"))

    expect(await failureOf(sendFiles(fixture, params()))).toMatchObject({
      code: "upstream_error",
      message: `The upload of ${FILE_A.name} failed (INTERNAL); nothing was sent.`,
    })
    sentNothing()
  })
})
