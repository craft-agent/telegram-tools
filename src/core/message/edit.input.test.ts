import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { USER } from "../telegram/mirror.testing"
import { CAPTION_MAX_UNITS, TEXT_MAX_UNITS } from "../telegram/service-requests"
import { telegramMessageEdit } from "./edit"
import { createActionFixture, OWN_ID, type ActionFixture } from "./action.testing"

let t: ActionFixture
let calls: ServiceCalls

beforeEach(async () => {
  t = createActionFixture()
  t.own()
  calls = await t.serveEdit()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

/** Two UTF-16 units each. */
const EMOJI = "😀"

describe("edit: the text is checked before any request", () => {
  test.each([
    ["an empty text", ""],
    ["a text of spaces", "   "],
    ["a text of line breaks and tabs", "\n\t \r\n"],
  ])("%s", async (_, text) => {
    const error = await t.editFails({ text })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("text is blank")
    expect(calls).toHaveLength(0)
  })

  test("a text over the most says how long it is", async () => {
    const error = await t.editFails({ text: "a".repeat(TEXT_MAX_UNITS + 1) })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${TEXT_MAX_UNITS + 1} characters`)
    expect(error.message).toContain(`at most ${TEXT_MAX_UNITS}`)
    expect(calls).toHaveLength(0)
  })

  test("counts UTF-16 units, as Telegram does, not code points", async () => {
    const error = await t.editFails({ text: EMOJI.repeat(TEXT_MAX_UNITS / 2 + 1) })
    expect(error.message).toContain(`${TEXT_MAX_UNITS + 2} characters`)
    expect(calls).toHaveLength(0)
  })

  test("the most, after trimming, is accepted and goes out trimmed", async () => {
    const text = EMOJI.repeat(TEXT_MAX_UNITS / 2)
    await t.edit({ text: `  \n${text}\t ` })
    expect(calls).toEqual([{ method: "edit", params: { chat: USER, id: OWN_ID, text } }])
  })

  test("a caption over its most is refused when the mirror shows the message has media", async () => {
    t.own({ id: 8, body: "a caption", media: { type: "photo" } })
    const error = await t.editFails({ id: 8, text: "a".repeat(CAPTION_MAX_UNITS + 1) })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`A caption must be at most ${CAPTION_MAX_UNITS} characters`)
    expect(calls).toHaveLength(0)
  })

  test("a caption of the most goes out", async () => {
    t.own({ id: 8, body: "a caption", media: { type: "photo" } })
    const text = "a".repeat(CAPTION_MAX_UNITS)
    await t.edit({ id: 8, text })
    expect(calls).toEqual([{ method: "edit", params: { chat: USER, id: 8, text } }])
  })
})

describe("edit: the other arguments are checked before any request", () => {
  test.each([
    ["a name", "Alice Example"],
    ["a username", "@alice_example"],
    ["a phone number", "+15550100"],
    ["an empty id", ""],
  ])("chat as %s", async (_, chat) => {
    const error = await t.editFails({ chat })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("chat must be a chat id")
    expect(calls).toHaveLength(0)
  })

  test.each([
    ["zero", 0],
    ["negative", -4],
    ["a decimal", 2.5],
    ["text", "7"],
    ["null", null],
  ])("id as %s", async (_, id) => {
    const error = await t.editFails({ id })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("id")
    expect(calls).toHaveLength(0)
  })

  test("a missing argument and unknown arguments", async () => {
    expect((await t.fail(telegramMessageEdit, { chat: USER, id: OWN_ID })).code).toBe("invalid_argument")
    expect((await t.fail(telegramMessageEdit, { id: OWN_ID, text: "x" })).code).toBe("invalid_argument")
    expect((await t.fail(telegramMessageEdit, { chat: USER, text: "x" })).code).toBe("invalid_argument")
    const stray = await t.editFails({ parse_mode: "markdown" })
    expect(stray.message).toContain("parse_mode: unknown argument")
    expect(calls).toHaveLength(0)
  })
})
