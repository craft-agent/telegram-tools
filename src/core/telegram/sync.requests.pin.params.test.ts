import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { INT32_MAX } from "./sync-request-params"
import { KEPT } from "./sync-requests.testing"
import { OWN, actionsOf } from "./sync-action.testing"
import { pin, pinnedAnswer, seedPinChats } from "./sync-pin.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedPinChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(pinnedAnswer(OWN.text))
})

afterAll(() => fixture.close())

const refused = (params: unknown) => failureOf(pin(fixture, params as Record<string, unknown>))

describe("pin parameters", () => {
  const ok = { chat: KEPT, id: OWN.text }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["a list", [KEPT, OWN.text]],
    ["no chat", { id: OWN.text }],
    ["an empty chat", { ...ok, chat: "" }],
    ["no id", { chat: KEPT }],
    ["an id of 0", { ...ok, id: 0 }],
    ["an id as text", { ...ok, id: "10" }],
    ["an id with a fraction", { ...ok, id: 1.5 }],
    ["an id past what Telegram numbers", { ...ok, id: INT32_MAX + 1 }],
    ["an unpin that is not a boolean", { ...ok, unpin: "yes" }],
    ["a notify that is not a boolean", { ...ok, notify: 1 }],
    ["a both_sides that is not a boolean", { ...ok, both_sides: "true" }],
    ["a notify with an unpin", { ...ok, unpin: true, notify: true }],
    ["a both_sides with an unpin", { ...ok, unpin: true, both_sides: true }],
    ["a field it does not take", { ...ok, silent: true }],
    ["a field named __proto__", Object.fromEntries([...Object.entries(ok), ["__proto__", 1]])],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refused(params)).toMatchObject({ code: "invalid_argument" })
      expect(actionsOf(fixture)).toEqual([])
    })
  }

  test("takes flags that are false beside an unpin, which are no flags", async () => {
    expect(await pin(fixture, { ...ok, unpin: true, notify: false, both_sides: false })).toEqual({
      id: OWN.text,
      pinned: false,
    })
    expect(actionsOf(fixture)[0]?.request).toMatchObject({ unpin: true })
  })
})
