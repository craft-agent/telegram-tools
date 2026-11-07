import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { HistoryResult } from "./service-requests"
import { FORUM, groupMessage, request, seedListedChats, sentAtMs } from "./sync-requests.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  fixture.client.setHistory(FORUM, ...[1, 2, 3, 4, 5, 6].map((id) => groupMessage(id)))
  await fixture.running()
})

afterEach(() => fixture.close())

const chatId = Number(FORUM)
const read = (params: Record<string, unknown>) => request<HistoryResult>(fixture, "history", { chat: FORUM, ...params })
const idsOf = (result: HistoryResult) => result.messages.map((message) => message.id)

describe("a live read of the whole chat", () => {
  test("asks Telegram for the newest messages, from no offset, and returns them as the mirror stores them", async () => {
    const result = await read({ limit: 100 })

    expect(fixture.client.argsOf("getHistory")).toEqual([{ chat: chatId, limit: 100, offset: { id: 0, date: 0 } }])
    expect(idsOf(result)).toEqual([6, 5, 4, 3, 2, 1])
    expect(result.messages[0]).toMatchObject({ chat: FORUM, id: 6, ts: sentAtMs(6), body: "hello", fromMe: false })
    expect(result.more).toBe(false)
  })

  test("starts after the message `before_id` names, and at the second after `before`, rounded up", async () => {
    await read({ limit: 10, before_id: 40, before: sentAtMs(5) + 500 })
    await read({ limit: 10, before: sentAtMs(5) })

    expect(fixture.client.argsOf("getHistory")).toEqual([
      { chat: chatId, limit: 10, offset: { id: 40, date: sentAtMs(5) / 1000 + 1 } },
      { chat: chatId, limit: 10, offset: { id: 0, date: sentAtMs(5) / 1000 } },
    ])
  })

  test("keeps only the messages sent after `after` and before `before`, both exclusive", async () => {
    const result = await read({ limit: 100, after: sentAtMs(1), before: sentAtMs(5) })

    expect(idsOf(result)).toEqual([4, 3, 2])
  })

  test("keeps only the messages with an id below `before_id`", async () => {
    expect(idsOf(await read({ limit: 100, before_id: 4 }))).toEqual([3, 2, 1])
  })

  test("answers a window nothing can be in without asking Telegram", async () => {
    expect(await read({ limit: 10, before_id: 1 })).toEqual({ messages: [], more: false })
    expect(await read({ limit: 10, before: 0 })).toEqual({ messages: [], more: false })
    expect(await read({ limit: 10, after: sentAtMs(3), before: sentAtMs(3) + 1 })).toEqual({
      messages: [],
      more: false,
    })

    expect(fixture.client.argsOf("getHistory")).toEqual([])
  })
})

describe("whether older messages remain", () => {
  test("they do when Telegram returned a full page", async () => {
    const result = await read({ limit: 3 })

    expect(idsOf(result)).toEqual([6, 5, 4])
    expect(result.more).toBe(true)
  })

  test("they do when a full page was cut only by `before_id` or `before`", async () => {
    expect((await read({ limit: 3, before_id: 6 })).more).toBe(true)
    expect(idsOf(await read({ limit: 3, before: sentAtMs(6) }))).toEqual([5, 4])
    expect((await read({ limit: 3, before: sentAtMs(6) })).more).toBe(true)
  })

  test("they do not when the page was not full", async () => {
    expect((await read({ limit: 7 })).more).toBe(false)
  })

  test("they do not when `after` cut the page: everything older is older than `after` too", async () => {
    const result = await read({ limit: 3, after: sentAtMs(4) })

    expect(idsOf(result)).toEqual([6, 5])
    expect(result.more).toBe(false)
  })

  test("they do when a full page lies all after `after`", async () => {
    expect((await read({ limit: 3, after: sentAtMs(2) })).more).toBe(true)
  })
})

describe("a live read of a forum topic", () => {
  beforeEach(() => fixture.client.setThread(FORUM, 7, ...[2, 4, 6].map((id) => groupMessage(id))))

  test("searches the topic's thread, with no query and no date bounds when none is given", async () => {
    const result = await read({ limit: 10, topic: 7 })

    expect(fixture.client.argsOf("searchMessages")).toEqual([{ chatId, query: "", threadId: 7, offset: 0, limit: 10 }])
    expect(fixture.client.argsOf("getHistory")).toEqual([])
    expect(idsOf(result)).toEqual([6, 4, 2])
  })

  test("passes `before_id` as the offset and the bounds as whole seconds that include the window", async () => {
    await read({ limit: 10, topic: 7, before_id: 9, after: sentAtMs(1) + 500, before: sentAtMs(5) + 500 })

    expect(fixture.client.argsOf("searchMessages")).toEqual([
      {
        chatId,
        query: "",
        threadId: 7,
        offset: 9,
        limit: 10,
        minDate: sentAtMs(1) / 1000,
        maxDate: sentAtMs(5) / 1000 + 1,
      },
    ])
  })

  test("filters and pages like a read of the whole chat", async () => {
    expect(idsOf(await read({ limit: 10, topic: 7, after: sentAtMs(2), before: sentAtMs(6) }))).toEqual([4])
    expect(idsOf(await read({ limit: 10, topic: 7, before_id: 6 }))).toEqual([4, 2])
    expect((await read({ limit: 3, topic: 7 })).more).toBe(true)
    expect((await read({ limit: 4, topic: 7 })).more).toBe(false)
  })
})
