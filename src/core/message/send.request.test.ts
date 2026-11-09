import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { ToolError } from "../errors"
import { OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { GENERAL_TOPIC, TEXT_MAX_UNITS } from "../telegram/service-requests"
import { formatLocalTime } from "../time"
import { annotations, invoke } from "../tool"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { telegramMessageSend } from "./send"
import { ACCEPTED, createSendFixture, type SendFixture } from "./send.testing"

let t: SendFixture
let calls: ServiceCalls

beforeEach(() => {
  t = createSendFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const context = () => ({ cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT })

describe("send: the tool", () => {
  test("is an add of the sends toolset", () => {
    expect(telegramMessageSend).toMatchObject({ id: "telegram_message_send", toolset: "sends", class: "add" })
    expect(annotations(telegramMessageSend)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  const targets = (args: object) => telegramMessageSend.targets?.({ text: "hello", ...args } as never, context())

  test("names the account and the chat it writes to", async () => {
    expect(await targets({ chat: SUPERGROUP })).toEqual([`default/${SUPERGROUP}`])
    expect(await targets({ chat: OTHER_USER, account: "default" })).toEqual([`default/${OTHER_USER}`])
  })

  test("cannot tell what it writes to when the account or the chat is not usable", async () => {
    expect(await targets({ chat: USER, account: "elsewhere" })).toEqual(["*"])
    expect(await targets({ chat: "Alice Example" })).toEqual(["*"])
  })

  test("says what it needs, what a result means and what `uncertain` asks", () => {
    const { description } = telegramMessageSend
    expect(description).toContain("`telegram_chat_read`")
    expect(description).toContain("Saved Messages")
    expect(description).toContain(`at most ${TEXT_MAX_UNITS} characters`)
    expect(description).toContain("never read as Markdown or HTML")
    expect(description).toContain("sync service running")
    expect(description).toContain("Sending files is a separate tool")
    expect(description).toContain("duplicate")
    expect(description).toContain("`uncertain`")
    expect(description).toContain("never send it again without the user checking")
  })
})

describe("send: the request", () => {
  test("sends the chat and the trimmed text, as a write", async () => {
    calls = await t.serveSend()
    await t.send({ text: "  hello there \n" })
    expect(calls).toEqual([{ method: "send", params: { chat: USER, text: "hello there" } }])
  })

  test("sends the text as written: Markdown and HTML stay as they are", async () => {
    calls = await t.serveSend()
    const text = "*bold* _it_ `code` <b>x</b> [a](https://example.test)"
    await t.send({ text })
    expect((calls[0]?.params as { text: string }).text).toBe(text)
  })

  test("sends the topic and the reply when given, and nothing else", async () => {
    calls = await t.serveSend()
    await t.send({ chat: SUPERGROUP, topic: 12, reply_to: 345 })
    await t.send({ chat: SUPERGROUP, topic: GENERAL_TOPIC })
    await t.send({ chat: SUPERGROUP, reply_to: 9 })
    expect(calls.map((call) => call.params)).toEqual([
      { chat: SUPERGROUP, text: "hello", topic: 12, reply_to: 345 },
      { chat: SUPERGROUP, text: "hello", topic: GENERAL_TOPIC },
      { chat: SUPERGROUP, text: "hello", reply_to: 9 },
    ])
  })

  test("takes the account's own service", async () => {
    calls = await t.serveSend()
    await t.send({ account: "default" })
    expect(calls).toHaveLength(1)
  })

  test("is a write: a reply lost after the request was written is uncertain, never a plain failure", async () => {
    await t.serveLost()
    const error = await t.sendFails()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("send may have taken effect")
  })

  test("a signal already aborted sends nothing", async () => {
    calls = await t.serveSend()
    const controller = new AbortController()
    controller.abort()
    await expect(
      invoke(telegramMessageSend, { chat: USER, text: "hello" }, { ...context(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })
})

describe("send: the result", () => {
  test("gives the id and the local time Telegram dated the message", async () => {
    await t.serveSend(() => ({ id: 42, date: ACCEPTED.date }))
    const result = await t.send({ chat: SUPERGROUP })
    expect(result).toEqual({
      chat: SUPERGROUP,
      id: 42,
      time: formatLocalTime(ACCEPTED.date),
      note: "Telegram accepted the message; that is not a read receipt.",
    })
  })

  test("leaves out what the service did not give", async () => {
    await t.serveSend(() => ({}))
    const result = await t.send()
    expect(result).toEqual({ chat: USER, note: "Telegram accepted the message; that is not a read receipt." })
  })

  test("a duplicate with its id says the earlier delivery went out once and not to send it again", async () => {
    await t.serveSend(() => ({ id: 42, duplicate: true }))
    const result = await t.send()
    expect(result).toMatchObject({ chat: USER, id: 42, duplicate: true })
    expect(result).not.toHaveProperty("time")
    expect(result.note).toContain("earlier delivery of this same call had already gone out")
    expect(result.note).toContain("only one message exists")
    expect(result.note).toContain("Do not send it again")
    expect(result.note).not.toContain("not known yet")
  })

  test("a duplicate without an id says it is not known yet and where it will show", async () => {
    await t.serveSend(() => ({ duplicate: true }))
    const result = await t.send()
    expect(result).toMatchObject({ chat: USER, duplicate: true })
    expect(result).not.toHaveProperty("id")
    expect(result.note).toContain("Do not send it again")
    expect(result.note).toContain("Its id is not known yet")
    expect(result.note).toContain("`telegram_chat_read` shows it once the service receives it")
  })
})

describe("send: the service's other answers pass through unchanged", () => {
  test.each([
    new ToolError("forbidden", "You cannot write in this chat; nothing was sent."),
    new ToolError("forbidden", "You are no longer in this chat; nothing was sent."),
    new ToolError("not_found", "No chat with this id in the chat list; refresh it, or check the id."),
    new ToolError("not_found", "No message 9 in this chat to reply to; nothing was sent."),
    new ToolError("rate_limited", "Telegram asks to wait 30 seconds before the next send."),
    new ToolError("invalid_argument", "This chat has no topics; nothing was sent."),
    new ToolError("upstream_error", "Telegram refused the request (MESSAGE_EMPTY)."),
    new ToolError("upstream_error", "The request was cancelled before Telegram answered."),
  ])("%p", async (refusal) => {
    await t.serveSend(() => {
      throw refusal
    })
    const failure = await t.sendFails()
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
    expect(failure.details).toBeUndefined()
  })

  test("the service not running is the client's error", async () => {
    const error = await t.sendFails()
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
  })
})
