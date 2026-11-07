import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { INT32_MAX } from "./sync-request-params"
import { KEPT, FORUM, PLAIN, UNLISTED, request, seedListedChats } from "./sync-requests.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  await fixture.running()
})

afterAll(() => fixture.close())

const refusal = (method: string, params: unknown) =>
  failureOf(request(fixture, method, params as Record<string, unknown>))

const telegramCalls = () =>
  (["getHistory", "searchMessages", "getForumTopics"] as const).flatMap((method) => fixture.client.argsOf(method))

describe("history parameters", () => {
  const ok = { chat: FORUM, limit: 10 }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["a list", [FORUM, 10]],
    ["no chat", { limit: 10 }],
    ["an empty chat", { ...ok, chat: "" }],
    ["a chat that is a number", { ...ok, chat: 123 }],
    ["no limit", { chat: FORUM }],
    ["a limit of 0", { ...ok, limit: 0 }],
    ["a limit over the most", { ...ok, limit: 101 }],
    ["a limit with a fraction", { ...ok, limit: 1.5 }],
    ["a limit as text", { ...ok, limit: "5" }],
    ["a null limit", { ...ok, limit: null }],
    ["a topic of 0", { ...ok, topic: 0 }],
    ["a topic as text", { ...ok, topic: "1" }],
    ["a topic past what Telegram numbers", { ...ok, topic: INT32_MAX + 1 }],
    ["a before_id of 0", { ...ok, before_id: 0 }],
    ["a negative before_id", { ...ok, before_id: -5 }],
    ["a null before_id", { ...ok, before_id: null }],
    ["a negative after", { ...ok, after: -1 }],
    ["an after with a fraction", { ...ok, after: 1.5 }],
    ["an after past the safe integers", { ...ok, after: 2 ** 53 }],
    ["a negative before", { ...ok, before: -1 }],
    ["a before as text", { ...ok, before: "1790000000000" }],
    ["a field it does not take", { ...ok, offset: 3 }],
    ["a field named __proto__", Object.fromEntries([...Object.entries(ok), ["__proto__", 1]])],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refusal("history", params)).toMatchObject({ code: "invalid_argument" })
      expect(telegramCalls()).toEqual([])
    })
  }
})

describe("topics parameters", () => {
  const ok = { chat: FORUM, limit: 10 }
  const offset = { date: 1, id: 2, topic: 3 }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["no chat", { limit: 10 }],
    ["no limit", { chat: FORUM }],
    ["a limit of 0", { ...ok, limit: 0 }],
    ["a limit over the most", { ...ok, limit: 101 }],
    ["an offset that is not an object", { ...ok, offset: 5 }],
    ["an offset that is a list", { ...ok, offset: [1, 2, 3] }],
    ["an offset missing a field", { ...ok, offset: { date: 1, id: 2 } }],
    ["an offset with a field it does not take", { ...ok, offset: { ...offset, extra: 1 } }],
    ["a negative offset field", { ...ok, offset: { ...offset, id: -1 } }],
    ["an offset field with a fraction", { ...ok, offset: { ...offset, topic: 0.5 } }],
    ["an offset field past what Telegram numbers", { ...ok, offset: { ...offset, date: INT32_MAX + 1 } }],
    ["a null offset", { ...ok, offset: null }],
    ["a field it does not take", { ...ok, topic: 3 }],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refusal("topics", params)).toMatchObject({ code: "invalid_argument" })
      expect(telegramCalls()).toEqual([])
    })
  }
})

describe("refresh parameters", () => {
  for (const [name, params] of [
    ["a field", { force: true }],
    ["a list", []],
  ] as [string, unknown][]) {
    test(`refuses ${name}`, async () => {
      expect(await refusal("refresh", params)).toMatchObject({ code: "invalid_argument" })
    })
  }
})

describe("the chat a request names", () => {
  test("a chat the mirror does not list is not found, for a live read and for topics", async () => {
    expect(await refusal("history", { chat: UNLISTED, limit: 5 })).toMatchObject({ code: "not_found" })
    expect(await refusal("topics", { chat: UNLISTED, limit: 5 })).toMatchObject({ code: "not_found" })
    expect(telegramCalls()).toEqual([])
  })

  test("a chat the mirror keeps is read from the mirror, not live", async () => {
    expect(await refusal("history", { chat: KEPT, limit: 5 })).toMatchObject({
      code: "invalid_argument",
      message: "This chat is mirrored; read it from the mirror.",
    })
    expect(telegramCalls()).toEqual([])
  })

  test("a chat that is not a forum supergroup has no topics", async () => {
    for (const chat of [KEPT, PLAIN]) {
      expect(await refusal("topics", { chat, limit: 5 })).toMatchObject({
        code: "invalid_argument",
        message: "This chat has no topics.",
      })
    }
    expect(telegramCalls()).toEqual([])
  })
})
