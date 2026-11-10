import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { storeMessage } from "./ingest-messages"
import { messageInput, rowsOf } from "./mirror.testing"
import { answered } from "./sync-client-send.testing"
import { KEPT } from "./sync-requests.testing"
import {
  FILE_A,
  FILE_B,
  answerFiles,
  outboxFile,
  requestsOf,
  sendFiles,
  writeOutboxFile,
} from "./sync-send-files.testing"
import { seedSendChats } from "./sync-send.testing"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
  seedSendChats(fixture)
})

afterEach(() => fixture.close())

const size = (file: { content: string }) => file.content.length

/** Stores a message the user sent in `KEPT` carrying a file, `agoMs` before the fake clock. */
function seedFileMessage(
  id: number,
  file: { name: string; content: string },
  {
    agoMs = 10_000,
    fromMe = true,
    chat = KEPT as string,
    fileSize = size(file),
  }: { agoMs?: number; fromMe?: boolean; chat?: string; fileSize?: number } = {},
): void {
  fixture.seed((mirror) => {
    const media = { type: "document", name: file.name, mime: "text/plain", size: fileSize }
    const message = messageInput({
      chat,
      id,
      fromMe,
      sender: fromMe ? null : "7000000002",
      media,
      ts: START_MS - agoMs,
    })
    storeMessage(mirror, { now: START_MS, keepDisappearing: false }, message)
  })
}

/** Starts the service and makes the send answer `RANDOM_ID_DUPLICATE`; the files of the send, in the outbox. */
async function begin(count = 2, reconnect = false) {
  await fixture.running()
  answerFiles(fixture, {
    firstId: 90,
    failSend: () => {
      if (reconnect) {
        fixture.client.drop()
        fixture.client.regain()
      }
      return answered(400, "RANDOM_ID_DUPLICATE")
    },
  })
  return [FILE_A, FILE_B].slice(0, count).map((file) => outboxFile(fixture, file))
}

const storedIds = () =>
  fixture.mirror((mirror) =>
    rowsOf(mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", KEPT).map((r) => r.id),
  )

describe("RANDOM_ID_DUPLICATE for files", () => {
  test("is a send that went out, with the id of each file's only message the mirror has with that name and size", async () => {
    seedFileMessage(40, FILE_A)
    seedFileMessage(41, FILE_B)
    const files = await begin()

    expect(await sendFiles(fixture, { chat: KEPT, files })).toEqual({
      duplicate: true,
      messages: [
        { id: 40, name: FILE_A.name },
        { id: 41, name: FILE_B.name },
      ],
    })
    expect(requestsOf(fixture, "messages.sendMultiMedia")).toHaveLength(1)
  })

  test("names only the files the mirror can name", async () => {
    seedFileMessage(41, FILE_B)
    const files = await begin()

    expect((await sendFiles(fixture, { chat: KEPT, files })).messages).toEqual([{ id: 41, name: FILE_B.name }])
  })

  test("of a lone file names its message too", async () => {
    seedFileMessage(40, FILE_A)
    const files = await begin(1)

    expect(await sendFiles(fixture, { chat: KEPT, files })).toEqual({
      duplicate: true,
      messages: [{ id: 40, name: FILE_A.name }],
    })
  })

  test("has no messages when the mirror has none", async () => {
    const files = await begin()

    expect(await sendFiles(fixture, { chat: KEPT, files })).toEqual({ duplicate: true })
  })

  const unmatched: [string, () => void][] = [
    ["two such messages", () => (seedFileMessage(40, FILE_A), seedFileMessage(41, FILE_A))],
    ["a file of the same name and another size", () => seedFileMessage(40, FILE_A, { fileSize: size(FILE_A) + 1 })],
    [
      "a file of another name and the same size",
      () => seedFileMessage(40, { name: "other.txt", content: FILE_A.content }),
    ],
    ["a message from more than a minute before the call", () => seedFileMessage(40, FILE_A, { agoMs: 61_000 })],
    ["a message someone else sent", () => seedFileMessage(40, FILE_A, { fromMe: false })],
    ["a message of another chat", () => seedFileMessage(40, FILE_A, { chat: "-1007200000001" })],
  ]
  for (const [name, seed] of unmatched) {
    test(`does not name a file for ${name}`, async () => {
      seed()
      const files = (await begin(1)).slice(0, 1)

      expect(await sendFiles(fixture, { chat: KEPT, files })).toEqual({ duplicate: true })
    })
  }

  test("takes a message from just within the minute", async () => {
    seedFileMessage(40, FILE_A, { agoMs: 60_000 })
    const files = await begin(1)

    expect((await sendFiles(fixture, { chat: KEPT, files })).messages).toEqual([{ id: 40, name: FILE_A.name }])
  })

  test("names neither of two files of the same name and size, since their messages cannot be told apart", async () => {
    seedFileMessage(40, FILE_A)
    seedFileMessage(41, FILE_A)
    await begin()
    const twice = ["one.txt", "two.txt"].map((path) => ({
      path: writeOutboxFile(fixture, path, FILE_A.content),
      name: FILE_A.name,
    }))

    expect(await sendFiles(fixture, { chat: KEPT, files: twice })).toEqual({ duplicate: true })
  })

  test("stores nothing and tells mtcute's update state nothing", async () => {
    seedFileMessage(40, FILE_A)
    const files = await begin()
    const before = storedIds()

    await sendFiles(fixture, { chat: KEPT, files })

    expect(storedIds()).toEqual(before)
    expect(fixture.client.handled).toEqual([])
  })

  test("stands after a reconnect, since it is the answer a repeated delivery earns", async () => {
    seedFileMessage(40, FILE_A)
    const files = await begin(2, true)

    expect(await sendFiles(fixture, { chat: KEPT, files })).toMatchObject({
      duplicate: true,
      messages: [{ id: 40, name: FILE_A.name }],
    })
  })
})
