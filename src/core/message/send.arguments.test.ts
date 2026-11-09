import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { USER } from "../telegram/mirror.testing"
import { TEXT_MAX_UNITS } from "../telegram/service-requests"
import { telegramMessageSend } from "./send"
import { createSendFixture, type SendFixture } from "./send.testing"

let t: SendFixture
let calls: ServiceCalls

beforeEach(async () => {
  t = createSendFixture()
  calls = await t.serveSend()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

/** Two UTF-16 units each. */
const EMOJI = "😀"

describe("send: the text is checked before any request", () => {
  test.each([
    ["an empty text", "", "text is blank"],
    ["a text of spaces", "   ", "text is blank"],
    ["a text of line breaks and tabs", "\n\t \r\n", "text is blank"],
  ])("%s", async (_, text, message) => {
    const error = await t.sendFails({ text })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
    expect(calls).toHaveLength(0)
  })

  test("a text over the most says how long it is and to split it", async () => {
    const error = await t.sendFails({ text: "a".repeat(TEXT_MAX_UNITS + 1) })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${TEXT_MAX_UNITS + 1} characters`)
    expect(error.message).toContain(`at most ${TEXT_MAX_UNITS}`)
    expect(error.message).toContain("several messages")
    expect(calls).toHaveLength(0)
  })

  test("counts UTF-16 units, as Telegram does, not code points", async () => {
    const error = await t.sendFails({ text: EMOJI.repeat(TEXT_MAX_UNITS / 2 + 1) })
    expect(error.message).toContain(`${TEXT_MAX_UNITS + 2} characters`)
    expect(calls).toHaveLength(0)
  })

  test("the most, after trimming, is accepted and goes out trimmed", async () => {
    const text = EMOJI.repeat(TEXT_MAX_UNITS / 2)
    await t.send({ text: `  \n${text}\t ` })
    expect(calls).toEqual([{ method: "send", params: { chat: USER, text } }])
  })

  test("blank space counts only inside the text", async () => {
    const text = "a".repeat(TEXT_MAX_UNITS - 2)
    await t.send({ text: ` ${text}  ` })
    expect((calls[0]?.params as { text: string }).text).toBe(text)
  })
})

describe("send: the other arguments are checked before any request", () => {
  test.each([
    ["a name", "Alice Example"],
    ["a username", "@alice_example"],
    ["a phone number", "+15550100"],
    ["an empty id", ""],
    ["a decimal", "12.5"],
  ])("chat as %s", async (_, chat) => {
    const error = await t.sendFails({ chat })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("chat must be a chat id")
    expect(calls).toHaveLength(0)
  })

  test.each([
    ["topic", 0],
    ["topic", -1],
    ["topic", 1.5],
    ["topic", "3"],
    ["reply_to", 0],
    ["reply_to", -4],
    ["reply_to", 2.5],
    ["reply_to", "5"],
  ])("%s as %p", async (name, value) => {
    const error = await t.sendFails({ [name]: value })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(name)
    expect(calls).toHaveLength(0)
  })

  test("a missing chat or text, and unknown arguments", async () => {
    expect((await t.fail(telegramMessageSend, { text: "hello" })).code).toBe("invalid_argument")
    expect((await t.fail(telegramMessageSend, { chat: USER })).code).toBe("invalid_argument")
    const stray = await t.sendFails({ parse_mode: "markdown" })
    expect(stray.message).toContain("parse_mode: unknown argument")
    expect(calls).toHaveLength(0)
  })
})
