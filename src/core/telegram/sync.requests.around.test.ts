import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AroundResult } from "./service-requests"
import { failureOf } from "./service.testing"
import { FORUM, groupMessage, request, seedListedChats, sentAtMs } from "./sync-requests.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  fixture.client.setHistory(FORUM, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => groupMessage(id)))
  await fixture.running()
})

afterEach(() => fixture.close())

const chatId = Number(FORUM)
const read = (id: number, before_count: number, after_count: number, topic?: number) =>
  request<AroundResult>(fixture, "around", { chat: FORUM, id, before_count, after_count, ...(topic ? { topic } : {}) })
const idsOf = (result: AroundResult) => result.messages.map((message) => message.id)

describe("a live read around a message", () => {
  test("asks Telegram for the window that starts at the message and reaches up over the newer ones", async () => {
    const result = await read(5, 2, 3)

    expect(fixture.client.argsOf("getHistory")).toEqual([
      { chat: chatId, offset: { id: 6, date: 0 }, addOffset: -3, limit: 6 },
    ])
    expect(idsOf(result)).toEqual([8, 7, 6, 5, 4, 3])
    expect(result.messages[3]).toMatchObject({ chat: FORUM, id: 5, ts: sentAtMs(5), body: "hello", fromMe: false })
  })

  test("takes only the older ones, only the newer ones, or just the message when a side is 0", async () => {
    expect(idsOf(await read(5, 2, 0))).toEqual([5, 4, 3])
    expect(idsOf(await read(5, 0, 2))).toEqual([7, 6, 5])
    expect(idsOf(await read(5, 0, 0))).toEqual([5])

    expect(fixture.client.argsOf("getHistory")).toEqual([
      { chat: chatId, offset: { id: 6, date: 0 }, addOffset: 0, limit: 3 },
      { chat: chatId, offset: { id: 6, date: 0 }, addOffset: -2, limit: 3 },
      { chat: chatId, offset: { id: 6, date: 0 }, addOffset: 0, limit: 1 },
    ])
  })

  test("returns what exists near the start of the chat", async () => {
    expect(idsOf(await read(2, 5, 1))).toEqual([3, 2, 1])
    expect(idsOf(await read(1, 3, 0))).toEqual([1])
  })

  test("keeps the nearest on each side when Telegram fills a page that ran out at the newest end from below", async () => {
    // Asked for 1 older and 5 newer around 9; only 1 newer exists, so Telegram adds older ones.
    expect(idsOf(await read(9, 1, 5))).toEqual([10, 9, 8])
    expect(idsOf(await read(10, 0, 4))).toEqual([10])
  })

  test("never asks for an offset past the largest number Telegram takes", async () => {
    await failureOf(read(2 ** 31 - 1, 0, 0))

    expect(fixture.client.argsOf("getHistory")).toEqual([
      { chat: chatId, offset: { id: 2 ** 31 - 1, date: 0 }, addOffset: 0, limit: 1 },
    ])
  })

  test("says not found when the message is not in the chat, even when others are near", async () => {
    fixture.client.setHistory(FORUM, ...[1, 2, 3, 4, 6, 7].map((id) => groupMessage(id)))

    for (const id of [5, 99]) {
      expect(await failureOf(read(id, 2, 2))).toMatchObject({
        code: "not_found",
        message: "No message with this id in this chat.",
      })
    }
  })
})

describe("a live read around a message of a forum topic", () => {
  beforeEach(() => fixture.client.setThread(FORUM, 7, ...[2, 4, 6, 8, 10].map((id) => groupMessage(id))))

  test("searches the topic's thread with the same window, and not the whole chat", async () => {
    const result = await read(6, 1, 1, 7)

    expect(fixture.client.argsOf("searchMessages")).toEqual([
      { chatId, query: "", threadId: 7, offset: 7, addOffset: -1, limit: 3 },
    ])
    expect(fixture.client.argsOf("getHistory")).toEqual([])
    expect(idsOf(result)).toEqual([8, 6, 4])
  })

  test("keeps the nearest of the topic's messages, near its ends", async () => {
    expect(idsOf(await read(2, 3, 1, 7))).toEqual([4, 2])
    expect(idsOf(await read(10, 1, 3, 7))).toEqual([10, 8])
  })

  test("says not found for a message that is in the chat but not in the topic", async () => {
    expect(await failureOf(read(5, 2, 2, 7))).toMatchObject({ code: "not_found" })
    expect(idsOf(await read(5, 2, 2))).toEqual([7, 6, 5, 4, 3])
  })
})
