import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { storeMessage } from "./ingest-messages"
import { messageInput, rowsOf } from "./mirror.testing"
import { answered } from "./sync-client-send.testing"
import { KEPT } from "./sync-requests.testing"
import { TEXT, seedOwnMessage, seedSendChats, send, sendsOf } from "./sync-send.testing"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedSendChats(fixture)
})

afterEach(() => fixture.close())

const duplicate = () => answered(400, "RANDOM_ID_DUPLICATE")

/** Starts the service and makes every call answer `RANDOM_ID_DUPLICATE`. */
async function begin(): Promise<void> {
  await fixture.running()
  fixture.client.setCallAnswer(duplicate())
}

const storedIds = () =>
  fixture.mirror((mirror) =>
    rowsOf(mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", KEPT).map((r) => r.id),
  )

describe("RANDOM_ID_DUPLICATE", () => {
  test("is a send that went out, with the id of the one message the mirror has of the user's with this text", async () => {
    seedOwnMessage(fixture, 40, TEXT)
    seedOwnMessage(fixture, 41, "something else")
    await begin()

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ id: 40, duplicate: true })
    expect(sendsOf(fixture)).toHaveLength(1)
  })

  test("has no id when the mirror has no such message", async () => {
    await begin()

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ duplicate: true })
  })

  test("has no id when the mirror has two such messages", async () => {
    seedOwnMessage(fixture, 40, TEXT)
    seedOwnMessage(fixture, 41, TEXT)
    await begin()

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ duplicate: true })
  })

  test("has no id for a message from before the call began by more than a minute", async () => {
    seedOwnMessage(fixture, 40, TEXT, 61_000)
    await begin()

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ duplicate: true })
  })

  test("takes a message from just within the minute", async () => {
    seedOwnMessage(fixture, 40, TEXT, 60_000)
    await begin()

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ id: 40, duplicate: true })
  })

  test("does not take a message someone else sent with the same text", async () => {
    fixture.seed((mirror) => {
      storeMessage(mirror, { now: START_MS, keepDisappearing: false }, messageInput({ chat: KEPT, id: 40, body: TEXT }))
    })
    await begin()

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ duplicate: true })
  })

  test("does not take a message of another chat", async () => {
    fixture.seed((mirror) => {
      const other = messageInput({ chat: "-1007200000001", id: 40, fromMe: true, body: TEXT, ts: START_MS - 1_000 })
      storeMessage(mirror, { now: START_MS, keepDisappearing: false }, other)
    })
    await begin()

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ duplicate: true })
  })

  test("stores nothing and tells mtcute's update state nothing", async () => {
    seedOwnMessage(fixture, 40, TEXT)
    await begin()
    const before = storedIds()

    await send(fixture, { chat: KEPT, text: TEXT })

    expect(storedIds()).toEqual(before)
    expect(fixture.client.handled).toEqual([])
  })

  test("stands after a reconnect, since it is the answer a repeated delivery earns", async () => {
    seedOwnMessage(fixture, 40, TEXT)
    await begin()
    fixture.client.setCallAnswer(() => {
      fixture.client.drop()
      fixture.client.regain()
      return duplicate()
    })

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ id: 40, duplicate: true })
  })
})
