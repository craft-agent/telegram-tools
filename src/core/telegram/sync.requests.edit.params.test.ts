import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { TEXT_MAX_UNITS } from "./service-requests"
import { INT32_MAX } from "./sync-request-params"
import { KEPT } from "./sync-requests.testing"
import { NEW_TEXT, OWN, actionsOf, edit, editedInPrivate, remove, seedActionChats } from "./sync-action.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedActionChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(editedInPrivate(OWN.text, NEW_TEXT))
})

afterAll(() => fixture.close())

const refusedEdit = (params: unknown) => failureOf(edit(fixture, params as Record<string, unknown>))
const refusedDelete = (params: unknown) => failureOf(remove(fixture, params as Record<string, unknown>))

describe("edit parameters", () => {
  const ok = { chat: KEPT, id: OWN.text, text: NEW_TEXT }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["a list", [KEPT, OWN.text, NEW_TEXT]],
    ["no chat", { id: OWN.text, text: NEW_TEXT }],
    ["a chat that is a number", { ...ok, chat: 7000000002 }],
    ["no id", { chat: KEPT, text: NEW_TEXT }],
    ["an id of 0", { ...ok, id: 0 }],
    ["a negative id", { ...ok, id: -1 }],
    ["an id as text", { ...ok, id: "10" }],
    ["an id with a fraction", { ...ok, id: 1.5 }],
    ["an id past what Telegram numbers", { ...ok, id: INT32_MAX + 1 }],
    ["no text", { chat: KEPT, id: OWN.text }],
    ["a text that is a number", { ...ok, text: 5 }],
    ["an empty text", { ...ok, text: "" }],
    ["a blank text", { ...ok, text: " \n\t " }],
    ["a text with blank space before it", { ...ok, text: ` ${NEW_TEXT}` }],
    ["a text with a line break after it", { ...ok, text: `${NEW_TEXT}\n` }],
    ["a text one unit over the most", { ...ok, text: "a".repeat(TEXT_MAX_UNITS + 1) }],
    ["an emoji text one unit over the most", { ...ok, text: `${"😀".repeat(TEXT_MAX_UNITS / 2)}a` }],
    ["a field it does not take", { ...ok, silent: true }],
    ["a topic, which an edit does not take", { ...ok, topic: 5 }],
    ["a field named __proto__", Object.fromEntries([...Object.entries(ok), ["__proto__", 1]])],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refusedEdit(params)).toMatchObject({ code: "invalid_argument" })
      expect(actionsOf(fixture)).toEqual([])
    })
  }

  test("never echoes the text it refuses", async () => {
    const secret = `${"s".repeat(TEXT_MAX_UNITS)}+15550100123`

    expect((await refusedEdit({ ...ok, text: secret })).message).not.toContain("15550100123")
  })

  test("takes a text of exactly the most units, though it is twice as many characters long as emoji", async () => {
    const text = "😀".repeat(TEXT_MAX_UNITS / 2)
    expect(text.length).toBe(TEXT_MAX_UNITS)
    fixture.client.setActionAnswer(editedInPrivate(OWN.text, text))

    expect(await edit(fixture, { ...ok, text })).toMatchObject({ id: OWN.text })
    expect(actionsOf(fixture).at(-1)?.request).toMatchObject({ message: text })
  })
})

describe("delete parameters", () => {
  const ok = { chat: KEPT, id: OWN.text }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["a list", [KEPT, OWN.text]],
    ["no chat", { id: OWN.text }],
    ["an empty chat", { ...ok, chat: "" }],
    ["no id", { chat: KEPT }],
    ["an id of 0", { ...ok, id: 0 }],
    ["a negative id", { ...ok, id: -1 }],
    ["an id as text", { ...ok, id: "10" }],
    ["an id with a fraction", { ...ok, id: 1.5 }],
    ["an id past what Telegram numbers", { ...ok, id: INT32_MAX + 1 }],
    ["a text, which a delete does not take", { ...ok, text: NEW_TEXT }],
    ["a field named __proto__", Object.fromEntries([...Object.entries(ok), ["__proto__", 1]])],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      const before = actionsOf(fixture).length

      expect(await refusedDelete(params)).toMatchObject({ code: "invalid_argument" })
      expect(actionsOf(fixture)).toHaveLength(before)
    })
  }
})
