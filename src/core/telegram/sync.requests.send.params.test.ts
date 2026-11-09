import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { TEXT_MAX_UNITS } from "./service-requests"
import { INT32_MAX } from "./sync-request-params"
import { KEPT } from "./sync-requests.testing"
import { TEXT, answerShort, seedSendChats, send, sendsOf } from "./sync-send.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedSendChats(fixture)
  await fixture.running()
  answerShort(fixture, 50)
})

afterAll(() => fixture.close())

const refusal = (params: unknown) => failureOf(send(fixture, params as Record<string, unknown>))

describe("send parameters", () => {
  const ok = { chat: KEPT, text: TEXT }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["a list", [KEPT, TEXT]],
    ["no chat", { text: TEXT }],
    ["an empty chat", { ...ok, chat: "" }],
    ["a chat that is a number", { ...ok, chat: 7000000002 }],
    ["no text", { chat: KEPT }],
    ["a text that is a number", { ...ok, text: 5 }],
    ["a null text", { ...ok, text: null }],
    ["an empty text", { ...ok, text: "" }],
    ["a blank text", { ...ok, text: " \n\t " }],
    ["a text with blank space before it", { ...ok, text: ` ${TEXT}` }],
    ["a text with a line break after it", { ...ok, text: `${TEXT}\n` }],
    ["a text one unit over the most", { ...ok, text: "a".repeat(TEXT_MAX_UNITS + 1) }],
    ["an emoji text one unit over the most", { ...ok, text: `${"😀".repeat(TEXT_MAX_UNITS / 2)}a` }],
    ["a topic of 0", { ...ok, topic: 0 }],
    ["a topic as text", { ...ok, topic: "5" }],
    ["a topic with a fraction", { ...ok, topic: 1.5 }],
    ["a topic past what Telegram numbers", { ...ok, topic: INT32_MAX + 1 }],
    ["a null topic", { ...ok, topic: null }],
    ["a reply_to of 0", { ...ok, reply_to: 0 }],
    ["a negative reply_to", { ...ok, reply_to: -1 }],
    ["a reply_to as text", { ...ok, reply_to: "1" }],
    ["a reply_to past what Telegram numbers", { ...ok, reply_to: INT32_MAX + 1 }],
    ["a field it does not take", { ...ok, silent: true }],
    ["a field named __proto__", Object.fromEntries([...Object.entries(ok), ["__proto__", 1]])],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refusal(params)).toMatchObject({ code: "invalid_argument" })
      expect(sendsOf(fixture)).toEqual([])
    })
  }

  test("never echoes the text it refuses", async () => {
    const secret = `${"s".repeat(TEXT_MAX_UNITS)}+15550100123`

    expect((await refusal({ ...ok, text: secret })).message).not.toContain("15550100123")
  })

  test("takes a text of exactly the most units, though it is twice as many characters long as emoji", async () => {
    const text = "😀".repeat(TEXT_MAX_UNITS / 2)
    expect(text.length).toBe(TEXT_MAX_UNITS)

    expect(await send(fixture, { ...ok, text })).toMatchObject({ id: 50 })
    expect(sendsOf(fixture).at(-1)?.request.message).toBe(text)
  })

  test("takes the extra blank space inside a text as it is", async () => {
    const text = "first line\n\n  second line\twith a tab"

    await send(fixture, { ...ok, text })

    expect(sendsOf(fixture).at(-1)?.request.message).toBe(text)
  })
})
