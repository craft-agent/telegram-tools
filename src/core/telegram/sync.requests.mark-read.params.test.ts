import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { THEIRS, actionsOf, affected } from "./sync-action.testing"
import { markRead, seedMarkReadChats } from "./sync-mark-read.testing"
import { INT32_MAX } from "./sync-request-params"
import { KEPT } from "./sync-requests.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedMarkReadChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(affected())
})

afterAll(() => fixture.close())

const refused = (params: unknown) => failureOf(markRead(fixture, params as Record<string, unknown>))

describe("mark_read parameters", () => {
  const ok = { chat: KEPT, up_to: THEIRS }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["a list", [KEPT, THEIRS]],
    ["no chat", { up_to: THEIRS }],
    ["an empty chat", { ...ok, chat: "" }],
    ["a chat that is a number", { ...ok, chat: Number(KEPT) }],
    ["no up_to", { chat: KEPT }],
    ["an up_to of 0", { ...ok, up_to: 0 }],
    ["an up_to as text", { ...ok, up_to: "1" }],
    ["an up_to with a fraction", { ...ok, up_to: 1.5 }],
    ["an up_to below 0", { ...ok, up_to: -1 }],
    ["an up_to past what Telegram numbers", { ...ok, up_to: INT32_MAX + 1 }],
    ["a topic of 0", { ...ok, topic: 0 }],
    ["a topic as text", { ...ok, topic: "5" }],
    ["a topic with a fraction", { ...ok, topic: 1.5 }],
    ["a field it does not take", { ...ok, id: THEIRS }],
    ["a field named __proto__", Object.fromEntries([...Object.entries(ok), ["__proto__", 1]])],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refused(params)).toMatchObject({ code: "invalid_argument" })
      expect(actionsOf(fixture)).toEqual([])
    })
  }

  test("takes the largest id Telegram numbers, which the mirror then does not hold", async () => {
    expect(await refused({ ...ok, up_to: INT32_MAX })).toMatchObject({ code: "not_found" })
    expect(actionsOf(fixture)).toEqual([])
  })
})
