import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { REACTION_MAX_UNITS } from "./service-requests"
import { failureOf } from "./service.testing"
import { INT32_MAX } from "./sync-request-params"
import { KEPT } from "./sync-requests.testing"
import { actionsOf } from "./sync-action.testing"
import { REACTED, THUMBS, react, reactedAnswer, seedReactionChats } from "./sync-react.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedReactionChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(reactedAnswer(REACTED.others, []))
})

afterAll(() => fixture.close())

const refused = (params: unknown) => failureOf(react(fixture, params as Record<string, unknown>))

describe("react parameters", () => {
  const ok = { chat: KEPT, id: REACTED.others, emoji: THUMBS }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["a list", [KEPT, REACTED.others, THUMBS]],
    ["no chat", { id: REACTED.others, emoji: THUMBS }],
    ["a chat that is a number", { ...ok, chat: 7000000002 }],
    ["no id", { chat: KEPT, emoji: THUMBS }],
    ["an id of 0", { ...ok, id: 0 }],
    ["an id as text", { ...ok, id: "32" }],
    ["an id past what Telegram numbers", { ...ok, id: INT32_MAX + 1 }],
    ["neither an emoji nor remove", { chat: KEPT, id: REACTED.others }],
    ["remove that is false and no emoji", { chat: KEPT, id: REACTED.others, remove: false }],
    ["both an emoji and remove", { ...ok, remove: true }],
    ["remove that is not a boolean", { chat: KEPT, id: REACTED.others, remove: "yes" }],
    ["an emoji that is not text", { ...ok, emoji: 5 }],
    ["an empty emoji", { ...ok, emoji: "" }],
    ["an emoji over the most units", { ...ok, emoji: "😀".repeat(REACTION_MAX_UNITS / 2 + 1) }],
    ["a word", { ...ok, emoji: "like" }],
    ["an emoji with a letter", { ...ok, emoji: `${THUMBS}a` }],
    ["an emoji with a digit", { ...ok, emoji: `${THUMBS}1` }],
    ["an emoji with blank space", { ...ok, emoji: `${THUMBS} ` }],
    ["two emoji", { ...ok, emoji: `${THUMBS}🎉` }],
    ["a field it does not take", { ...ok, big: true }],
    ["a field named __proto__", Object.fromEntries([...Object.entries(ok), ["__proto__", 1]])],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refused(params)).toMatchObject({ code: "invalid_argument" })
      expect(actionsOf(fixture)).toEqual([])
    })
  }

  test("never echoes the emoji it refuses", async () => {
    expect((await refused({ ...ok, emoji: "secret+15550100123" })).message).not.toContain("15550100123")
  })

  test("takes an emoji with a skin tone, a joined sequence and a flag, each one grapheme", async () => {
    for (const emoji of ["👍🏽", "👨‍👩‍👧", "🇯🇵"]) {
      expect(await react(fixture, { ...ok, emoji })).toMatchObject({ id: REACTED.others, emoji })
    }
    expect(actionsOf(fixture)).toHaveLength(3)
  })

  test("takes remove: false beside an emoji, which is the emoji alone", async () => {
    expect(await react(fixture, { ...ok, remove: false })).toEqual({ id: REACTED.others, emoji: THUMBS })
  })
})
